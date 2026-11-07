# Registry Check ♥

A static site that checks a built-in library of common 3 to 7 letter English words against
a domain ending. Type an ending like `.love` and the page checks every word in the library
(`ace.love`, `apple.love`, …), showing which are still available. Filter by word length and
switch between Available, Taken and All.

## How availability is checked

GitHub Pages has no backend, so everything runs in the visitor's browser:

1. **DNS-over-HTTPS** (Google, then Cloudflare) first, because it's fast and not rate
   limited for this volume. A name with DNS records is **Taken**.
2. **RDAP** (the modern replacement for WHOIS) confirms the names DNS says don't exist. The
   site loads IANA's RDAP bootstrap file (`data.iana.org/rdap/dns.json`) to find the
   registry's server: `404` is **Available**, `200` is **Taken**. If the registry has no RDAP
   or blocks the request, the name shows as available with a dashed outline (probably free).

Before checking words, the site makes sure the ending exists and detects endings that answer
DNS for every name (wildcards), using RDAP only for those.

Premium and reserved names can still show as available, so the footer reminds people to
confirm with a registrar.

## Premium names

Registries charge extra for "premium" names (fin.love can be $4,000+) even though RDAP still
reports them as unregistered. Only registrars know which names are premium, so the optional
Cloudflare Worker in `worker/` asks Name.com's API for the price of every free name. Premium
names are then hidden unless the visitor ticks **Show premium names**, and every free name
shows its first-year price. Setup steps are in [`worker/README.md`](worker/README.md); until
`priceApi` is set in `site/config.js`, the checkbox is disabled and no names are filtered.

## Files

- `site/index.html`, `site/style.css`, `site/app.js`: the page
- `site/words.js`: the word library, grouped by length (edit freely)
- `site/config.js`: the price-check Worker URL (`priceApi`)
- `worker/`: the price-check Cloudflare Worker (Name.com API)
- `.github/workflows/pages.yml`: deploys `site/` to GitHub Pages on every push to `main`

## Deploying

In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. After that,
each push to `main` publishes the site.

To run locally: `cd site && python3 -m http.server`, then open http://localhost:8000.
