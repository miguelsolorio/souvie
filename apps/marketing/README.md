# apps/marketing

Placeholder for the marketing site. WS14 builds it as an Astro project: landing page, waitlist form, and store-listing copy from `docs/08-brand.md`. It is separate from `apps/mobile` because it needs SEO and static content, not the app's router or design system (`docs/01-architecture.md` §Why Expo web instead of a separate Next.js app).

There is no `package.json` yet, so pnpm and Turborepo skip this folder. WS14 adds one, runs it with `pnpm --filter marketing dev|build`, and deploys it to Cloudflare Pages.
