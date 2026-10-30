# Kroger HTTP fixtures

Recorded response shapes for the unit tests. No test in CI calls Kroger.

Each file is one response: `status`, the headers that matter (`cache-control`, `date`, the `x-ratelimit-*-day` pair, `content-type`), and `body`. The field names, nesting, casing (`inStore`, `shipToHome`), error bodies, and headers match what `api.kroger.com` returned on 2026-10-30.

The values are not Kroger's. Product names, brands, UPCs, prices, store names, and addresses are invented ("Fixture Farms", "QFC - Fixture Ridge"). Kroger's terms forbid keeping cached copies of catalog data or building a product database, so no real catalog or location data is committed here.

`products-chicken-thighs.json` carries `cache-control: max-age=3600` so the cache tests can exercise header handling. The live API sent no `Cache-Control` and no `Expires` on catalog responses when we checked, which means nothing is cached in practice (docs/09-open-questions.md).

Tokens in `token-*.json` are placeholders, not credentials.
