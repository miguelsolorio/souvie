# WS14: Brand & marketing site

**Wave:** 1 · **Suggested model:** Sonnet · **Branch:** `ws/14-brand-marketing-site`

## Goal
When this is done, the product has a name that has passed basic availability checks, a visual identity expressed as design tokens the app consumes, a logo and icon set, a landing page with a working waitlist, and App Store listing copy ready to paste. The name itself is a human decision; this WS does the legwork and ships everything that does not depend on it with a placeholder, then swaps the name in once chosen.

## Depends on
- WS00 (Scaffold): `packages/ui` exists with a tokens entry point; `apps/marketing` workspace slot exists; Supabase local dev works for the waitlist table.
- No dependency on WS01. The waitlist table is public-insert with no auth.

## Read first
1. `docs/08-brand.md` (all of it: shortlist, slogans, positioning, personas, pitches, landing outline, App Store draft, launch channels, email sequence, press blurb)
2. `docs/00-overview.md` §1.1 (differentiation: do not market "recipe to cart" alone)
3. `docs/04-integrations.md` §5.2 (Kroger branding rules; Instacart copy rules) and §5.4
4. `docs/06-risks.md` (R12 retailer assistants commoditize single-store recipe-to-cart, R18 Instacart terms, R22 monetization and logo rules)
5. `docs/01-architecture.md` (Monorepo layout: `apps/marketing` is Astro; `packages/ui`)

## In scope
- Name checks for every shortlist candidate in `docs/08-brand.md` (Sous, Mise, Larder, Forkcast, Cartwheel, plus the secondary list): USPTO TESS search in classes 9 and 42, Apple App Store and Google Play search, domains (.com, .app, .co), npm package name, GitHub org/user. Record results in `docs/08-brand.md` under a new "Availability checks" table with date and URL for each check. Do not pick the name; present the top three with a recommendation. **Human checkpoint 6**: the orchestrator stops and asks Miguel to choose before the final rename.
- Design tokens in `packages/ui/src/tokens.ts` and `packages/ui/tailwind.preset.js` (NativeWind): color scales (primary, neutral, success, warning, danger, plus semantic aliases for surface, text, border), type scale (display, title, body, caption with sizes and line heights), spacing (4pt grid), radius, shadow. Light and dark modes.
- Logo mark as SVG (`packages/ui/assets/logo.svg`, `logo-mark.svg`, `logo-wordmark.svg`) and app icon set generated from the mark (`apps/mobile/assets/icon.png` 1024×1024, `adaptive-icon.png`, `splash-icon.png`, `favicon.png`). Use the placeholder wordmark "Meal Planner" until the name is chosen; structure the SVG so swapping the wordmark text is one edit.
- Astro landing page in `apps/marketing` with sections in this order: hero (slogan + one-line positioning + waitlist CTA), how it works in three steps (plan, list, cart), store compatibility (text list only: "Starting with QFC and Fred Meyer in Washington. Safeway, Albertsons, and Costco are next."; no retailer logos; amended 2026-10-30 because the Instacart application is still open), trust and privacy (no card data, you pay in the store's app, you can export and delete everything), waitlist form, footer with privacy policy link placeholder.
- Waitlist: Supabase table `waitlist` (email, source, created_at) with an insert-only anon policy and a unique index on lowercased email; the form posts via `supabase-js` and shows a confirmation. Honeypot field for spam.
- App Store listing copy in `docs/08-brand.md`: title (30 chars), subtitle (30 chars), promotional text (170), description, keywords (100 chars), what's-new template. Google Play short and full descriptions.
- Copy compliance pass across the site and listing: never say "partner" about Instacart, never say "Free Delivery", never use "Kroger" in the name or imply endorsement, do not use Kroger banner logos anywhere on marketing (terms allow them only inside the Add-to-Cart UI and only for non-monetized apps), do not show prices from multiple retailers on one screen.
- Deploy `apps/marketing` to Cloudflare Pages (same host WS13 uses for the app) with a `deploy-marketing` CI job on `main`.

## Out of scope
- Choosing the name (human checkpoint).
- The app's screens or any use of tokens inside `apps/mobile` beyond wiring the icon and splash assets (other WSs consume tokens).
- Email sending for the waitlist (no confirmation emails; a later WS can add Resend).
- Analytics on the marketing site beyond a single PostHog pageview event if `EXPO_PUBLIC_POSTHOG_KEY` is set (WS15 owns analytics design).
- Paid acquisition, social accounts, or the press outreach itself. This WS produces the materials in `docs/08-brand.md`; sending them is Miguel's call.
- Legal review of trademarks. Record what the searches show; do not conclude a mark is clear.
- The desktop app title and bundle id (WS13); hand them the final name through the completion report.

## Deliverables
- `docs/08-brand.md`: "Availability checks" table, final App Store and Play listing copy, landing page copy as shipped.
- `packages/ui/src/tokens.ts`, `packages/ui/tailwind.preset.js`, `packages/ui/src/tokens.test.ts` (contrast checks: every text/surface pair meets WCAG AA 4.5:1 in both modes).
- `packages/ui/assets/logo.svg`, `logo-mark.svg`, `logo-wordmark.svg`.
- `apps/mobile/assets/icon.png`, `adaptive-icon.png`, `splash-icon.png`, `favicon.png` and the matching `app.json` entries.
- `apps/marketing/` Astro project: `src/pages/index.astro`, `src/components/{Hero,HowItWorks,Stores,Trust,Waitlist,Footer}.astro`, `src/styles/tokens.css` generated from `packages/ui` tokens, `public/` with logo and OG image, `README.md`.
- `supabase/migrations/<timestamp>_waitlist.sql` with table, policy, index, and `supabase/tests/waitlist_rls.sql` (anon can insert, anon cannot select, duplicate email rejected).
- `.github/workflows/marketing.yml`: build on PR, deploy on `main`.
- `apps/marketing/scripts/check-copy.mjs`: fails the build if the site or `docs/08-brand.md` listing copy contains "partner" near "Instacart", "Free Delivery", or "Kroger" in a title context. Wire it into `pnpm lint`.

## Interfaces
**Implements**
- Token export shape in `packages/ui/src/tokens.ts`: `export const tokens = { color: { light: {...}, dark: {...} }, type: {...}, space: {...}, radius: {...}, shadow: {...} } as const` plus `export type Tokens = typeof tokens`. NativeWind preset reads from the same object.
- Table `waitlist(id, email text, source text, created_at)` with `create unique index on waitlist (lower(email))`.
- Astro site at `apps/marketing` with `pnpm --filter marketing dev|build`.

**Consumes**
- `packages/ui` package scaffold from WS00.
- Supabase anon key for the waitlist form (public by design).
- Nothing from `packages/core`. Shared contracts are untouched.

## Acceptance criteria
1. `docs/08-brand.md` contains an "Availability checks" table with one row per shortlist name and columns for USPTO, App Store, Google Play, .com, .app, npm, GitHub, each with a result and a URL, dated. It ends with a three-name recommendation and the reasons.
2. `pnpm test --filter ui` passes `tokens.test.ts`, including AA contrast for all text-on-surface pairs in light and dark.
3. `pnpm --filter marketing build` succeeds and `dist/index.html` contains the six sections in order (checked by `apps/marketing/tests/sections.test.mjs` parsing the HTML).
4. Submitting the waitlist form on the local dev server inserts a `waitlist` row; submitting the same email again shows the "You're already on the list" message; the honeypot field being filled results in no insert.
5. `supabase test db` passes `waitlist_rls.sql`: anon insert succeeds, anon select returns zero rows, duplicate lowercased email fails.
6. `node apps/marketing/scripts/check-copy.mjs` exits 0 on the shipped copy and exits 1 on a fixture containing "our partner Instacart".
7. No retailer logo files exist under `apps/marketing/public` (checked by the same script).
8. `apps/mobile` builds with the new icon and splash assets (`npx expo prebuild --platform ios --no-install` succeeds and the icon is visible in the Simulator).
9. The `marketing.yml` workflow passes on the PR; on `main` the site is live at a Cloudflare Pages URL recorded in the completion report.
10. Lighthouse (desktop) on the deployed landing page scores ≥90 for performance and accessibility.
11. `pnpm typecheck && pnpm lint && pnpm test` pass at the repo root.

## Verification commands
```bash
pnpm test --filter ui                                   # expected: tokens and contrast tests pass
pnpm --filter marketing dev                             # manual: all six sections render; submit waitlist
pnpm --filter marketing build && node apps/marketing/tests/sections.test.mjs   # expected: pass
node apps/marketing/scripts/check-copy.mjs              # expected: exit 0
supabase start && supabase db reset && supabase test db # expected: waitlist_rls.sql passes
cd apps/mobile && npx expo prebuild --platform ios --no-install   # expected: succeeds with new icons
pnpm typecheck && pnpm lint && pnpm test                # expected: clean
npx lighthouse <deployed-url> --preset=desktop --only-categories=performance,accessibility   # expected: ≥90 each
```

## Risks and notes
- R12: the hero must sell the household loop (one plan, one list, carts filled across stores, scheduled runs), not "turn recipes into a cart", which Kroger and Instacart now do for free.
- R18 and R22: Instacart terms forbid calling them a partner and saying "Free Delivery"; Kroger terms forbid banner logos outside the in-app Add-to-Cart UI and forbid them entirely for monetized apps. Text-only store compatibility is the safe default.
- R22: v1 is non-commercial. Do not add pricing, "Pro", or subscription language to the site. Add a "Coming to iOS and web" line instead.
- Name checks are evidence, not clearance. Say so in the doc. Trademark counsel is a later, human decision.
- The waitlist is public-insert. Rate limit at the edge (Cloudflare) and use the honeypot; expect some spam.
- Tokens must work in NativeWind and in Astro CSS. Generate `tokens.css` from `tokens.ts` with a small script; do not hand-maintain two copies.
- Accessibility: the design tokens test is the contrast gate; the landing page must pass axe with zero serious issues before deploy.
- Prose style for all copy: short sentences, no em dashes, no filler. Match `docs/08-brand.md` voice.

## Completion report
End with the completion report format from `docs/implementation-guide.md` §6.2 (Message templates). Nothing else is read by the orchestrator. Include the three-name recommendation and the live URLs.

## Deploy-gates round (orchestrator, 2026-10-30)

The name swap merged as 0fd014f. Before the site deploys, one more round covers, in this order: (1) the Stores lead in `Stores.astro`, `docs/08-brand.md` §5 and `sections.test.mjs` moves to the amended wording above; (2) the store listing in docs/08 §6 drops "We plan to open those lists on Instacart" (a listing describes the build on submission day) and the §6 compliance note is rewritten to match; (3) `packages/ui/README.md` wordmark numbers become the measured ink edges (99, 113, 119.8), and `assets.test.ts` spells the old name split like the other tests; (4) a privacy contact route and address; (5) waitlist rate limiting through a Pages Function or Turnstile; (6) `db push` of the waitlist migration and the Cloudflare Pages project, both human-gated. "You tap pay" stays until checkpoint 5.
