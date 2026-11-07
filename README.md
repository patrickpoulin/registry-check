# Registry Check ♥

A static site for checking basic English words against top-level domains like `.love`.
Type one or more words (comma separated), pick the domain endings you care about, and the
page shows every combination (`sweet.love`, `sweet.lol`, …) with whether it looks available.

## How availability is checked

GitHub Pages has no backend, so everything runs in the visitor's browser:

1. **RDAP** (the modern replacement for WHOIS). The site loads IANA's RDAP bootstrap
   file (`data.iana.org/rdap/dns.json`) to find each TLD's registry server, then asks it
   about the name. `404` means the registry has no record of it (**Available**);
   `200` means it's registered (**Taken**, with registration/expiry dates and registrar).
2. **DNS-over-HTTPS** fallback (Google, then Cloudflare) for TLDs without RDAP or when a
   registry blocks the browser request. `NXDOMAIN` shows as **Probably available**;
   any records show as **Taken**.

Premium and reserved names can still show as available, so the footer reminds people to
confirm with a registrar.

## Files

- `site/index.html`, `site/style.css`, `site/app.js`: the page
- `site/tlds.js`: the curated list of domain endings and which are on by default
- `.github/workflows/pages.yml`: deploys `site/` to GitHub Pages on every push to `main`

## Deploying

In the repo's **Settings → Pages**, set **Source** to **GitHub Actions**. After that,
each push to `main` publishes the site.

To run locally: `cd site && python3 -m http.server`, then open http://localhost:8000.
