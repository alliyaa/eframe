/**
 * "now on the shelf" backend — Cloudflare Worker
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → paste this in
 * Then: Settings → Bindings → add a KV namespace, bind it as FRAMES
 * (Create the KV namespace first under Workers & Pages → KV if you don't have one)
 *
 * Five routes:
 *  - POST /update/:frameId        <- webpage calls this when someone picks a book
 *  - POST /upload/:frameId        <- webpage calls this for the "custom photo"
 *                                     mode (pets, art, anything). Stores the
 *                                     actual image bytes, since there's no
 *                                     trusted external URL for a user's own photo.
 *  - GET  /frame/:frameId         <- the PHYSICAL FRAME's firmware points its
 *                                     "Auto Rotate URL" setting here. FETCHES the
 *                                     actual image server-side and streams the bytes
 *                                     back directly — no redirect, since some
 *                                     firmware HTTP clients don't follow 302s.
 *  - GET  /frame/:frameId/meta    <- full JSON (title/author/quote), for OUR
 *                                     webpage's own preview screen only.
 *  - POST /waitlist               <- landing page's email signup form
 *
 * No auth on this MVP version — frameId itself is the "secret."
 * Fine for a first prototype; revisit before real customers.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // POST /upload/:frameId  { imageBase64, contentType }
    // For the "custom photo" mode — pets, art, anything the person uploads.
    // Resize/compress happens client-side before this is called; we just
    // store what we're given, capped to keep KV values reasonable.
    const uploadMatch = url.pathname.match(/^\/upload\/([A-Za-z0-9]{4,12})$/);
    if (uploadMatch && request.method === "POST") {
      const frameId = uploadMatch[1].toUpperCase();
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json body" }, 400, cors);
      }
      const { imageBase64, contentType } = body;
      if (!imageBase64 || typeof imageBase64 !== "string") {
        return json({ error: "imageBase64 is required" }, 400, cors);
      }
      // Rough size guard — base64 is ~33% bigger than raw bytes, cap around 4MB raw
      if (imageBase64.length > 5_500_000) {
        return json({ error: "image too large — please use a smaller photo" }, 400, cors);
      }
      const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
      const type = allowedTypes.includes(contentType) ? contentType : "image/jpeg";
      await env.FRAMES.put(`customimg:${frameId}`, imageBase64);
      const record = {
        title: "custom photo",
        author: "",
        thumb: "",
        quote: "",
        mode: "custom",
        customImageType: type,
        updatedAt: new Date().toISOString(),
      };
      await env.FRAMES.put(frameId, JSON.stringify(record));
      return json({ ok: true, frameId }, 200, cors);
    }

    // POST /update/:frameId  { title, author, thumb, quote }
    const updateMatch = url.pathname.match(/^\/update\/([A-Za-z0-9]{4,12})$/);
    if (updateMatch && request.method === "POST") {
      const frameId = updateMatch[1].toUpperCase();
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json body" }, 400, cors);
      }
      const { title, author, thumb, quote, mode } = body;
      if (!title || !thumb) {
        return json({ error: "title and thumb are required" }, 400, cors);
      }
      // SECURITY: only allow image URLs from sources we actually use —
      // without this, anyone could POST an arbitrary URL and turn this
      // Worker into an open fetch-proxy when /frame/:id later fetches it.
      const ALLOWED_IMAGE_HOSTS = [
        "covers.openlibrary.org",
        "books.google.com",
        "books.googleusercontent.com",
        "apod.nasa.gov",
      ];
      let thumbHost;
      try {
        thumbHost = new URL(thumb).hostname;
      } catch {
        return json({ error: "thumb must be a valid URL" }, 400, cors);
      }
      if (!ALLOWED_IMAGE_HOSTS.includes(thumbHost)) {
        return json({ error: `image host not allowed: ${thumbHost}` }, 400, cors);
      }
      const record = {
        title,
        author: author || "",
        thumb,
        quote: (quote || "").slice(0, 100),
        mode: mode || "reading",
        updatedAt: new Date().toISOString(),
      };
      await env.FRAMES.put(frameId, JSON.stringify(record));
      return json({ ok: true, frameId, record }, 200, cors);
    }

    // GET /frame/:frameId/meta  -> full JSON, for OUR webpage's preview only
    const metaMatch = url.pathname.match(/^\/frame\/([A-Za-z0-9]{4,12})\/meta$/);
    if (metaMatch && request.method === "GET") {
      const frameId = metaMatch[1].toUpperCase();
      const stored = await env.FRAMES.get(frameId);
      if (!stored) return json({ error: "no book set yet for this frame" }, 404, cors);
      return json(JSON.parse(stored), 200, cors);
    }

    // GET /frame/:frameId  -> what the PHYSICAL FRAME's firmware polls.
    // Fetches the actual image server-side and streams the bytes back —
    // no redirect, so it works even if the firmware's HTTP client
    // doesn't follow 302s (this was causing ESP_FAIL on the device).
    const frameMatch = url.pathname.match(/^\/frame\/([A-Za-z0-9]{4,12})$/);
    if (frameMatch && request.method === "GET") {
      const frameId = frameMatch[1].toUpperCase();
      const stored = await env.FRAMES.get(frameId);
      if (!stored) {
        return json({ error: "no book set yet for this frame" }, 404, cors);
      }
      const record = JSON.parse(stored);

      // Custom-photo mode: serve the stored bytes directly, no external fetch
      if (record.mode === "custom") {
        const storedImage = await env.FRAMES.get(`customimg:${frameId}`);
        if (!storedImage) {
          return json({ error: "no photo stored for this frame" }, 404, cors);
        }
        const binary = Uint8Array.from(atob(storedImage), (c) => c.charCodeAt(0));
        const headers = new Headers(cors);
        headers.set("Content-Type", record.customImageType || "image/jpeg");
        return new Response(binary, { status: 200, headers });
      }

      let imgResp;
      try {
        imgResp = await fetch(record.thumb);
      } catch {
        return json({ error: "could not reach image source" }, 502, cors);
      }
      if (!imgResp.ok) {
        return json({ error: "image source returned an error" }, 502, cors);
      }
      const headers = new Headers(cors);
      headers.set("Content-Type", imgResp.headers.get("Content-Type") || "image/jpeg");
      return new Response(imgResp.body, { status: 200, headers });
    }

    // POST /waitlist  { email }
    if (url.pathname === "/waitlist" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json body" }, 400, cors);
      }
      const email = (body.email || "").trim().toLowerCase();
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(email)) {
        return json({ error: "that doesn't look like a valid email" }, 400, cors);
      }
      // stored under a waitlist: prefix in the same KV store, alongside frame records
      await env.FRAMES.put(`waitlist:${email}`, JSON.stringify({ email, joinedAt: new Date().toISOString() }));
      return json({ ok: true }, 200, cors);
    }

    return json({ error: "not found" }, 404, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
