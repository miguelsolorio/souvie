# apps/marketing

The landing page and waitlist (WS14). Astro, static output, deployed to Cloudflare Pages. It is separate from `apps/mobile` because it needs SEO and static content, not the app's router (`docs/01-architecture.md` §Why Expo web instead of a separate Next.js app).

Copy lives in `docs/08-brand.md` §5. The page is five sections and a footer, in this order: hero, how it works, stores, trust and privacy, waitlist, footer.

## Run it

```bash
pnpm --filter marketing dev          # http://localhost:4321
pnpm --filter marketing build        # writes dist/
pnpm --filter marketing preview      # serves dist/
node apps/marketing/tests/sections.test.mjs   # after a build: checks the six sections
pnpm --filter marketing test         # unit tests (waitlist logic, copy checker, generated files)
node apps/marketing/scripts/check-copy.mjs    # copy compliance (also part of `pnpm lint`)
```

Needs Node 22.23 or newer (Astro 7 requires it; the repo's `.node-version` is 22, which resolves to the latest 22.x). `dev` and `build` first run `scripts/sync-brand.mjs`, which loads TypeScript from `packages/ui` with Node's built-in type stripping.

## Environment

The site reads the same `.env.local` at the repo root as the app and the worker. Only these reach the browser, and they are all public by design:

| Variable | Used for | If missing |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | the waitlist insert | the form says the waitlist isn't open yet |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the waitlist insert (RLS allows insert only) | same |
| `EXPO_PUBLIC_POSTHOG_KEY` | one anonymous `$pageview` (US cloud, no cookie, honors Do Not Track) | no analytics |
| `MARKETING_SITE_URL` | absolute canonical and Open Graph URLs at build time | those tags are left out |

`astro.config.mjs` sets `envDir` to the repo root and `envPrefix` to `PUBLIC_` and `EXPO_PUBLIC_`. Anything else in `.env.local`, such as the service-role key, never enters the bundle.

## Waitlist

The form posts with `supabase-js` (loaded only on submit, so the page itself ships almost no JavaScript) to the `waitlist` table from `supabase/migrations/*_waitlist.sql`.

- Insert-only for the `anon` role. No select, update, or delete. Duplicate emails (any case) fail with SQLSTATE 23505, shown as "You're already on the list."
- A hidden `website` field is the honeypot. If it has a value the form shows the normal confirmation and writes nothing.
- The table checks email shape, zip (five digits), and source (`[a-z0-9._-]{1,64}`), so a client that skips the form still cannot store junk. `?ref=` or `?utm_source=` becomes `source`.
- Expect some spam anyway. Calls go from the browser straight to Supabase, so a Cloudflare rate-limiting rule on this site's hostname does not cover them. If spam arrives, put a Cloudflare Pages Function in front of the insert and rate-limit that, or add Turnstile.
- The migration has to be applied to the hosted project (`supabase db push`) before the live form works. The hosted project is not touched by this workstream.
- No email is sent. Confirmation emails are a later workstream (Resend).

## Brand files

`src/styles/tokens.css` and `public/{logo,logo-mark,favicon}.svg` are generated from `packages/ui` by `scripts/sync-brand.mjs`. Do not edit them. `pnpm --filter marketing test` fails if they drift.

`public/og.png` (1200x630) and `public/apple-touch-icon.png` are rendered from SVG sources:

```bash
rsvg-convert -w 1200 -h 630 src/assets/og.svg -o public/og.png
rsvg-convert -w 180 -h 180 ../../packages/ui/assets/app-icon.svg -o public/apple-touch-icon.png
rsvg-convert -w 48 -h 48 ../../packages/ui/assets/favicon.svg -o public/favicon.png
```

The name is Souvie (said "SOO-vee"). If it ever changes, change it in three places: `src/config.ts`, the `<text>` and `<title>` in `packages/ui/assets/logo.svg` and `logo-wordmark.svg`, and the title and the lines marked `NAME` in `src/assets/og.svg`. A longer or shorter name also needs a new `viewBox` so the wordmark cannot clip in a fallback font, and a new `width` and `height` on the logo `<img>` in `src/layouts/Base.astro`. `packages/ui/README.md` ("Wordmark fit") has the steps and `packages/ui/src/assets.test.ts` is the gate. Then run `pnpm --filter marketing tokens` and re-render `og.png`. `tests/brand-sync.test.ts` fails if the name differs between these files.

## Copy rules

`scripts/check-copy.mjs` fails the lint run on: "Kroger" in a title, heading, name, or logo text, em dashes, prices, "Pro" or subscription language, retailer logo images, and retailer logo files under `public/` or `src/assets/`. It also scans the blocks between `copy:start` and `copy:end` markers in `docs/08-brand.md`, and fails if it finds none. Pass `--file path` to check one file.

## Deploy

`.github/workflows/marketing.yml` builds on every pull request and, on `main`, deploys `dist/` to Cloudflare Pages with `wrangler pages deploy`. One-time setup (Miguel):

1. Create a Cloudflare Pages project (direct upload, no Git integration). Note its name.
2. In the GitHub repository settings add secrets `CLOUDFLARE_API_TOKEN` (Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`.
3. Add repository variables `CF_PAGES_PROJECT_MARKETING` (the project name), `MARKETING_SITE_URL` (the Pages URL), `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and optionally `EXPO_PUBLIC_POSTHOG_KEY`. All are public values.

Until `CF_PAGES_PROJECT_MARKETING` is set, the deploy job is skipped and `main` stays green. `public/_headers` sets security headers and a Content-Security-Policy that allows only this origin, `*.supabase.co`, and `us.i.posthog.com`.
