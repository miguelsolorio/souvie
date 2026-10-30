# 00 · Overview

## What this is

A cross-platform meal-planning app whose primary job is to get the groceries bought with as little human effort as possible. It suggests and imports recipes, turns a week's plan into one consolidated grocery list, converts that list into retailer line items, and has an agent fill the cart and schedule pickup at Washington grocers: QFC and Fred Meyer (Kroger), Safeway, Albertsons and Haggen (Albertsons Companies), and Costco. Login, per-user retailer integrations, and meal and purchase history are secondary.

**One line:** a sous-chef that plans the week and does the shopping.

## The core loop

```
Onboard → AI curates recipes → Plan the week → Grocery list (aggregated, pantry-aware)
   → Shoppable line items per store → Agent fills cart → User reviews and pays (or agent checks out)
   → Pickup scheduled → History (meals cooked, orders, spend) → feeds back into suggestions
```

Version one must make this loop work end to end for one household against QFC. Everything else is secondary.

## Decisions already made

| Decision | Choice | Consequence |
|---|---|---|
| Client stack | Expo + React Native, TypeScript | One codebase for iOS, Android, and web (Expo Router with React Native Web). Desktop is Tauri 2 wrapping the static web export |
| Backend | Supabase | Postgres with Row Level Security, Auth, Storage, Edge Functions, Realtime, pgvector, Vault, Cron, Queues. A separate Node worker runs long agent jobs |
| Audience v1 | The household first, public later | Multi-user households and shared plans and lists from day one. No billing, App Store release, or admin tooling until v2 |
| Checkout stance | Three tiers, all allowed | Tier 1: official API fills the cart, the user pays in the retailer app. Tier 2: Instacart as the fulfillment layer. Tier 3: browser automation for full checkout, feature-flagged and opt-in |
| AI provider | Anthropic Claude | Haiku 5.5 for parsing, Sonnet 5.5 for planning and the shopping agent, Opus 5.5 for escalation. One `packages/llm` wrapper so the provider can change |

## v1 must-haves

- Sign in with Apple, Google, or email. Households with shared plans and lists.
- Onboarding that captures taste, constraints, time, budget, and stores, then has the AI curate a first week.
- Recipe import from URL, pasted text, and photo. Manual entry. AI-suggested recipes.
- A weekly planner with slot assignment and "swap this" AI actions.
- A grocery list that is aggregated across recipes, unit-normalized, pantry-aware, grouped by aisle, usable offline in the store, and shared in realtime.
- Line-item conversion: every list item mapped to concrete retailer products with price, size, and alternatives.
- Kroger cart fill via the official API. Instacart hand-off for Costco and Safeway. A browser-automation adapter behind a flag.
- Scheduled runs ("every Saturday at 9am, shop next week's plan") with a push notification when the cart is ready.
- History: meals cooked, orders placed, spend per week.

## Explicitly out of v1

Billing, a public recipe community, nutrition tracking beyond display, meal kits, multi-tenant admin, App Store release.

## Landscape and differentiation (research, October 2026)

The retailers now ship their own "recipe to cart" assistants. Kroger's AI Shopping Assistant (July 2026, all banners, Gemini-based) builds weekly plans by budget and diet and turns a photo of a list or a recipe URL into a cart. Instacart's Clementine (September 2026) does chat, list, and recipe to cart and "order my usuals." Walmart has Sparky. Albertsons has a Safeway plugin inside ChatGPT (August 2026) that builds carts and sends the user to Safeway to pay.

Meal-planning apps (Samsung Food, Mealime, AnyList, eMeals, Plan to Eat) all stop at handing a list to a retailer. The user fixes quantities and pays. Nobody does unattended checkout except Hungryroot, which owns its own inventory.

What that means for this product:

- **Do not compete on "recipe to cart" inside one store.** Kroger does that for free.
- **Compete on the household loop across stores.** One plan, one list, split across QFC, Costco, and Safeway by household rules and learned habits. Product preferences that persist week to week. Scheduled autonomous runs. A review step designed to take thirty seconds on a phone. And, for households that opt in, the only hands-off checkout outside a closed-inventory service.
- **Import quality is table stakes, not a moat.** A maintained TypeScript port of `recipe-scrapers` (v3.2.0, October 2026, Zod-validated) plus Claude structured outputs gets there quickly.

Sources: Kroger assistant (theshelbyreport.com, 2026-07-29); Instacart Clementine (techcrunch.com, 2026-09-09; investors.instacart.com); Safeway in ChatGPT (albertsonscompanies.com newsroom, 2026-08-05); Walmart Sparky and the end of OpenAI Instant Checkout (thepaypers.com, digitalcommerce360.com 2026-03); competitor pricing and integrations from each product's App Store listing and help center, collected 2026-10-29.

## Document map

| Doc | Read it when |
|---|---|
| `01-architecture.md` | You need the system shape, monorepo layout, tooling, or environment variables |
| `02-data-model.md` | You touch any table, policy, or migration |
| `03-ai-design.md` | You build onboarding, suggestions, import, parsing, aggregation, or the agent |
| `04-integrations.md` | You touch a retailer, Instacart, or the browser adapters |
| `05-security-privacy.md` | You handle tokens, sessions, spending, allergens, or user data |
| `06-risks.md` | You want to know what can go wrong and which workstream prevents it |
| `07-roadmap.md` | You need the phase and wave order |
| `08-brand.md` | You work on the name, copy, landing page, or store listing |
| `09-open-questions.md` | You hit something the research could not confirm |
| `implementation-guide.md` | You are the orchestrator, or you want to know how the build is run |
| `status.md` | You want to know what is done |
