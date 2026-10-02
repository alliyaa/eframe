/**
 * "now on the shelf" backend — Cloudflare Worker
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → paste this in
 * Then: Settings → Bindings → add a KV namespace, bind it as FRAMES
 * (Create the KV namespace first under Workers & Pages → KV if you don't have one)
 *
 * Five API routes:
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
 * PLUS: anything else (GET /, GET /app.html, etc.) transparently proxies
 * through to the real site on Cloudflare Pages (PAGES_ORIGIN below) — so
 * this same eframe.alliyaahmad3.workers.dev domain serves the whole site,
 * not just the API. One URL for everything, no separate Pages link to juggle.
 *
 *  - POST /checkout               <- creates a real Stripe Checkout Session,
 *                                     scoped to ONE shipping country at a time
 *                                     so the address typed and the shipping
 *                                     rate charged can never mismatch (unlike
 *                                     a static Payment Link, which lets anyone
 *                                     pick any rate regardless of address).
 *                                     Needs a STRIPE_SECRET_KEY secret set on
 *                                     this Worker (Settings -> Variables ->
 *                                     add, mark as "Encrypt"). NEVER put this
 *                                     key in any public file.
 *
 * No auth on this MVP version — frameId itself is the "secret."
 * Fine for a first prototype; revisit before real customers.
 */

// EDIT THIS if your Pages project's URL is ever different
const PAGES_ORIGIN = "https://eframe.pages.dev";

// Shipping, in cents, per allowed country. Edit these if your real costs change.
const SHIPPING_RATES = {
  US: { amount: 1500, label: "US Shipping" },
  CA: { amount: 3500, label: "Canada Shipping" },
  GB: { amount: 4000, label: "UK Shipping" },
};
const PRODUCT_PRICE_CENTS = 31900; // $319.00 — keep in sync with the site's displayed price

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

    // ---- Spotify "now playing" ----
    // needs two secrets on this Worker: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
    // and this redirect URI added in the Spotify dashboard: <your worker url>/spotify/callback
    const spLogin = url.pathname.match(/^\/spotify\/login\/([A-Za-z0-9]{4,12})$/);
    if (spLogin && request.method === "GET") {
      if (!env.SPOTIFY_CLIENT_ID) return json({ error: "spotify isn't configured yet" }, 500, cors);
      const nonce = crypto.randomUUID();
      await env.FRAMES.put(`spstate:${nonce}`, spLogin[1].toUpperCase(), { expirationTtl: 600 });
      const q = new URLSearchParams({
        client_id: env.SPOTIFY_CLIENT_ID, response_type: "code",
        redirect_uri: url.origin + "/spotify/callback",
        scope: "user-read-currently-playing user-read-recently-played",
        state: nonce, show_dialog: "true",
      });
      return Response.redirect("https://accounts.spotify.com/authorize?" + q.toString(), 302);
    }
    if (url.pathname === "/spotify/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const frameId = state ? await env.FRAMES.get(`spstate:${state}`) : null;
      if (!code || !frameId) return Response.redirect(url.origin + "/app.html?spotify=failed", 302);
      await env.FRAMES.delete(`spstate:${state}`);
      const tok = await spotifyToken(env, new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: url.origin + "/spotify/callback",
      }));
      if (!tok || !tok.refresh_token) return Response.redirect(url.origin + "/app.html?spotify=failed", 302);
      await env.FRAMES.put(`spotify:${frameId}`, tok.refresh_token);
      await env.FRAMES.put(frameId, JSON.stringify({
        title: "now playing", author: "spotify", thumb: "", quote: "", mode: "spotify",
        updatedAt: new Date().toISOString(),
      }));
      return Response.redirect(`${url.origin}/app.html?frame=${frameId}&spotify=connected`, 302);
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
        "eframe.pages.dev", // your own bundled images (moon photo etc)
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

      // Spotify mode: look up what's playing at the moment the frame asks
      if (record.mode === "spotify") {
        const art = await spotifyArt(env, frameId);
        if (!art) return json({ error: "nothing played yet" }, 404, cors);
        record.thumb = art;
      }

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

    // POST /checkout  { country: "US" | "CA" | "GB" }
    // Creates a Checkout Session scoped to exactly ONE country and its
    // matching shipping rate, so the customer physically cannot select a
    // mismatched combo — Stripe will only let them type an address in the
    // one country we told it to allow.
    if (url.pathname === "/checkout" && request.method === "POST") {
      if (!env.STRIPE_SECRET_KEY) {
        return json({ error: "checkout isn't configured yet" }, 500, cors);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json body" }, 400, cors);
      }
      const country = (body.country || "").toUpperCase();
      const rate = SHIPPING_RATES[country];
      if (!rate) {
        return json({ error: "unsupported shipping country" }, 400, cors);
      }

      const params = new URLSearchParams();
      params.set("mode", "payment");
      params.set("success_url", url.origin + "/?checkout=success");
      params.set("cancel_url", url.origin + "/?checkout=cancelled");
      params.set("shipping_address_collection[allowed_countries][0]", country);
      params.set("line_items[0][quantity]", "1");
      params.set("line_items[0][price_data][currency]", "usd");
      params.set("line_items[0][price_data][unit_amount]", String(PRODUCT_PRICE_CENTS));
      params.set("line_items[0][price_data][product_data][name]", "Marginalia Frame");
      params.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
      params.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(rate.amount));
      params.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
      params.set("shipping_options[0][shipping_rate_data][display_name]", rate.label);

      let stripeResp;
      try {
        stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });
      } catch {
        return json({ error: "could not reach Stripe" }, 502, cors);
      }
      const session = await stripeResp.json();
      if (!stripeResp.ok) {
        return json({ error: session.error ? session.error.message : "Stripe error" }, 502, cors);
      }
      return json({ url: session.url }, 200, cors);
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

    // Anything else: transparently serve the real site (index.html, app.html,
    // etc.) from Cloudflare Pages, so this one domain does double duty as
    // both the API and the actual pages — no separate .pages.dev link needed.
    if (request.method === "GET") {
      const pagesUrl = PAGES_ORIGIN + url.pathname + url.search;
      try {
        const pageResp = await fetch(pagesUrl, { headers: { "User-Agent": "eframe-worker-proxy" } });
        const headers = new Headers(pageResp.headers);
        headers.delete("content-security-policy"); // avoid Pages' CSP blocking things when served from this domain
        return new Response(pageResp.body, { status: pageResp.status, headers });
      } catch {
        return json({ error: "could not reach the site" }, 502, cors);
      }
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

async function spotifyToken(env, params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(env.SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET),
    },
    body: params,
  });
  return r.ok ? r.json() : null;
}

// album art of what's playing now; else last thing played; else the last art we saved
async function spotifyArt(env, frameId) {
  const refresh = await env.FRAMES.get(`spotify:${frameId}`);
  if (!refresh) return null;
  const tok = await spotifyToken(env, new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }));
  if (!tok) return await env.FRAMES.get(`spotlast:${frameId}`);
  if (tok.refresh_token) await env.FRAMES.put(`spotify:${frameId}`, tok.refresh_token);
  const h = { Authorization: "Bearer " + tok.access_token };
  let art = null;
  try {
    const cur = await fetch("https://api.spotify.com/v1/me/player/currently-playing", { headers: h });
    if (cur.status === 200) {
      const d = await cur.json();
      art = d && d.item && d.item.album && d.item.album.images && d.item.album.images[0] && d.item.album.images[0].url;
    }
    if (!art) {
      const rec = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=1", { headers: h });
      if (rec.ok) {
        const d = await rec.json();
        const t = d.items && d.items[0] && d.items[0].track;
        art = t && t.album && t.album.images && t.album.images[0] && t.album.images[0].url;
      }
    }
  } catch {}
  if (art) await env.FRAMES.put(`spotlast:${frameId}`, art);
  else art = await env.FRAMES.get(`spotlast:${frameId}`);
  return art;
}