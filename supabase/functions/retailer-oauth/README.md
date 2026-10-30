# retailer-oauth

The server side of connecting a Kroger (QFC, Fred Meyer) account, plus the Kroger calls the app cannot make itself because they need the client secret or a customer token. WS07.

Every request is `POST` with a JSON body and a signed-in user's `Authorization: Bearer <jwt>` (`verify_jwt` stays on). Responses are `{ ok: true, ... }` or `{ ok: false, error, message }` with an HTTP status, and always `Cache-Control: no-store`.

## Actions

| `action` | Body | Answer |
|---|---|---|
| `authorize` | `householdId`, and one of `banner` (`qfc`, `fredmeyer`), `chain`, or `storeId` | `authorizeUrl`: open it in the system browser. PKCE and the sealed state are set here. With only `storeId`, one Locations lookup picks the banner |
| `exchange` | `code`, `state` from `souvie://oauth/kroger`; optional `storeId`, `storeName`, `modality` | `connection`: the refresh token is in Vault, never in the answer |
| `disconnect` | `connectionId` | `connection` with `status: "revoked"`. Deletes our Vault secret. Kroger has no revocation endpoint, so the grant stays valid at Kroger until it expires or the person removes the app in their Kroger account |
| `stores` | `zip`, optional `radiusMiles` | QFC and Fred Meyer stores, as Kroger returned them |
| `products` | `householdId`, `storeId`, `q` | Products with that store's prices. Members of the household only |
| `cart_add` | `connectionId`, `items: [{ productId, upc, quantityDelta, modality? }]` (1 to 50) | `result: { accepted, rejected }` and `checkoutUrl`. Only the connection's own member can fill its cart |

## Per-member hourly limits

The Kroger quota is shared by every household on our client id, and sign-up is open. So each member gets a budget per clock hour, counted in `retailer_user_usage` by `retailer_user_consume` before any Kroger call:

| Action | Calls per member per hour | Kroger quota it protects |
|---|---|---|
| `stores` | 20 | Locations, 1,600 a day (published) |
| `products` | 60 | Products, 10,000 a day |
| `cart_add` | 30 | Cart, 5,000 a day |

Past the limit the answer is HTTP 429, `error: "rate_limited"`, a plain message, `resetsAt` (the next hour), and a `Retry-After` header. `authorize`, `exchange`, and `disconnect` are not limited here. The worker's runs (WS09) call the adapter directly and are budgeted there. The shared daily ceiling (95% of each quota) still applies on top: past it the answer is HTTP 429 with `error: "quota_exhausted"`.

## Errors

`unauthorized` 401, `method_not_allowed` 405, `invalid_request` 400, `not_a_member` 403, `not_found` 404, `not_allowed` 403, `invalid_state` 400, `invalid_grant` 400, `reauth_required` 409, `quota_exhausted` 429, `rate_limited` 429, `retailer_error` 502, `internal_error` 500. Messages are in `handler.ts`.

## Secrets

Set on the project with `supabase secrets set`: `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI` (`souvie://oauth/kroger`), and optionally `KROGER_API_BASE`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come from the platform. Locally: `supabase functions serve retailer-oauth --env-file .env.local`.

## Tests

`index.test.ts` drives `handler.ts` with the real `KrogerAdapter` over recorded Kroger responses and an in-memory stand-in for the WS07 SQL functions. No network.
