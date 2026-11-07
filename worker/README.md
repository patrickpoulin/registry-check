# Price check Worker

Registry lookups can say a name is free without saying it's a **premium** name the registry
sells for hundreds or thousands of dollars (fin.love, for example). Only a registrar knows
that, and registrar APIs need a secret key, so the static site can't call them directly.
This small Cloudflare Worker holds the key and answers the site's price questions.

The site only sends names that the registry already says are free, 50 per request, and the
Worker caches each answer for 6 hours. Both services have free tiers that cover this.

## One-time setup (about 10 minutes)

1. **Name.com API token.** Create a free account at name.com, then go to
   Account → Settings → Security → API Management (https://www.name.com/account/settings/api)
   and create a production token. Note the **username** and **token** it shows. If two-step
   verification is on, enable "API access" there too.
2. **Cloudflare account.** Create a free account at dash.cloudflare.com.
3. **Deploy the Worker** from this folder (needs Node.js):

   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put NAMECOM_USERNAME   # paste your Name.com username
   npx wrangler secret put NAMECOM_TOKEN      # paste the API token
   npx wrangler deploy
   ```

   `deploy` prints a URL like `https://registry-check-prices.<you>.workers.dev`.
4. **Point the site at it.** Put that URL in `site/config.js` as `priceApi` and push to `main`.

The "Show premium names" checkbox turns on once `priceApi` is set.

## Checking it works

```sh
curl -X POST https://registry-check-prices.<you>.workers.dev/check \
  -H "Origin: https://patrickpoulin.github.io" \
  -d '{"domains":["fin.love","zebrafish.love"]}'
```

You should see `"premium": true` and a price for fin.love.

## Notes

- Prices are Name.com's, in USD, for one year. Other registrars charge differently, but
  whether a name is premium is set by the registry, so that part is the same everywhere.
- `purchasable: false` means the name isn't registered but can't be bought (reserved); the
  site lists it under Taken.
- If the Worker is down or the token is wrong, the site still works and says prices couldn't
  be loaded.
