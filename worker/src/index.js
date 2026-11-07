// Price check for Registry Check.
//
// POST /check  body: {"domains": ["fin.love", "apple.love", ...]}  (up to 500)
// ->  {"results": {"fin.love": {"purchasable": true, "premium": true, "price": 4000, "renewal": 4000}, ...}}
//
// Asks Name.com's API, which reports registry premium names and their prices.
// Secrets (set with `wrangler secret put`): NAMECOM_USERNAME, NAMECOM_TOKEN.
// Vars (wrangler.toml): ALLOWED_ORIGINS, NAMECOM_API.

const MAX_DOMAINS = 500;
const CHUNK = 50; // Name.com's limit per availability call
const CACHE_SECONDS = 6 * 60 * 60;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{2,63})+$/;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== "/check" || request.method !== "POST") {
      return json({ error: "POST /check with {\"domains\": [...]}" }, 404, cors);
    }
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "origin not allowed" }, 403, cors);
    if (!env.NAMECOM_USERNAME || !env.NAMECOM_TOKEN) return json({ error: "Name.com credentials not set" }, 500, cors);

    let domains;
    try {
      const body = JSON.parse(await request.text());
      domains = [...new Set((body.domains || []).map((d) => String(d).toLowerCase().trim()))]
        .filter((d) => DOMAIN_RE.test(d))
        .slice(0, MAX_DOMAINS);
    } catch {
      return json({ error: "body must be JSON" }, 400, cors);
    }

    const cache = caches.default;
    const results = {};
    const missing = [];
    await Promise.all(domains.map(async (d) => {
      const hit = await cache.match(cacheKey(d));
      if (hit) results[d] = await hit.json();
      else missing.push(d);
    }));

    const api = (env.NAMECOM_API || "https://api.name.com/v4").replace(/\/+$/, "");
    const auth = "Basic " + btoa(`${env.NAMECOM_USERNAME}:${env.NAMECOM_TOKEN}`);
    const errors = [];
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      try {
        const res = await fetch(`${api}/domains:checkAvailability`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({ domainNames: chunk }),
        });
        if (!res.ok) { errors.push(`Name.com ${res.status}`); continue; }
        const data = await res.json();
        for (const r of data.results || []) {
          const d = String(r.domainName || "").toLowerCase();
          if (!d) continue;
          const row = {
            purchasable: !!r.purchasable,
            premium: !!r.premium,
            price: num(r.purchasePrice),
            renewal: num(r.renewalPrice),
          };
          results[d] = row;
          ctx.waitUntil(cache.put(cacheKey(d), new Response(JSON.stringify(row), {
            headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` },
          })));
        }
      } catch (e) {
        errors.push(String(e));
      }
    }

    return json({ results, ...(errors.length ? { errors } : {}) }, 200, cors);
  },
};

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function cacheKey(domain) {
  return new Request(`https://registry-check-cache.invalid/${domain}`);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes("*") || allowed.includes(origin);
  return ok
    ? { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" }
    : {};
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
