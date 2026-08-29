/**
 * "now on the shelf" backend — Cloudflare Worker
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → paste this in
 * Then: Settings → Bindings → add a KV namespace, bind it as FRAMES
 * (Create the KV namespace first under Workers & Pages → KV if you don't have one)
 *
 * Three routes:
 *  - POST /update/:frameId        <- webpage calls this when someone picks a book
 *  - GET  /frame/:frameId         <- the PHYSICAL FRAME's firmware points its
 *                                     "Auto Rotate URL" setting here. FETCHES the
 *                                     actual image server-side and streams the bytes
 *                                     back directly — no redirect, since some
 *                                     firmware HTTP clients don't follow 302s.
 *  - GET  /frame/:frameId/meta    <- full JSON (title/author/quote), for OUR
 *                                     webpage's own preview screen only.
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

    return json({ error: "not found" }, 404, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}