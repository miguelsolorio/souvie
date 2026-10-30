# 08 · Brand

Names, slogans, positioning, and the marketing materials WS14 turns into a landing page and a store listing. Nothing here has been checked against trademarks, the App Store, or domain registries. Run the checks in §1.3 before committing to a name.

## 1. Name

### 1.1 Shortlist

| Name | Why it works | Watch out for |
|---|---|---|
| **Sous** | A sous-chef preps and shops so the cook can cook. Four letters, one syllable, verbs well ("Sous it"). Says "assistant in the kitchen" without saying AI | Several small kitchen apps have used "Sous" or "Sous Chef." Check the App Store and USPTO class 9 and 42 |
| **Larder** | The stocked pantry. Implies provisioning, which is the job, and it's warmer than "grocery" | Common word; a few food brands use it. Domain likely taken; `larder.app` or `getlarder.com` may be open |
| **Mise** | From mise en place: everything in its place before you cook. Pronounced "meez." Reads as craft | Needs a pronunciation hint on first use. At least one cooking app has used it |
| **Forkcast** | A forecast for the week's forks. Dry, a little silly, memorable | Puns date fast. Check for a podcast or newsletter by this name |
| **Cartwheel** | The plan-to-cart motion in one word. Friendly | Target ran a loyalty program called Cartwheel until 2019. The trademark may still be live in retail classes. Probably skip |

Also considered: Provision, Simmer, Marketday, Stocked, Ladle, Hearth, Tablewise, Platewise, Weeknight.

**Recommendation:** Sous first, Larder second. Both describe what the product does for you rather than what it is. Use "meal-planner" as the repo and working name until checkpoint 6.

### 1.2 Rules the name must follow

- Must not contain "Kroger," "QFC," "Fred Meyer," "Safeway," "Albertsons," "Costco," or "Instacart." Kroger's developer terms forbid "Kroger" anywhere in the app name, and the rest invite trademark trouble.
- Must work as an iOS app name under 30 characters and as a bare word on a home screen icon.
- Should survive being said out loud once with no spelling.

### 1.3 Checks to run (WS14, human)

1. USPTO TESS: classes 9 (software), 35 (retail services), 42 (SaaS), 43 (food services).
2. App Store and Google Play search for the exact name and obvious variants.
3. Domains: `.com`, `.app`, `.co`. Record what's available and the price.
4. npm and GitHub org names, so the package scope can match later.
5. Social handles on Instagram, TikTok, and X.

Record results in `status.md` under the decisions log.

## 2. Slogans

Lead candidates:

- Dinner, decided. Groceries, done.
- You pick the meals. We fill the cart.
- Plan the week. Skip the store.
- From "what's for dinner?" to "it's in the trunk."
- Your week of meals, shopped by Saturday.
- A sous-chef for the whole week.

Rules: never promise the app pays for you unless the household has opted into Tier 3. "We fill the cart" is accurate for Tier 1. "Done" is fine when the next step is one tap.

## 3. Positioning

**Statement.** For busy households who are tired of the Sunday-night "what are we eating" scramble, [Name] is a meal planner that finishes the job. It suggests dinners you'll like, builds one list for the week, and loads your QFC, Safeway, or Costco cart so pickup is one tap away. Recipe apps stop at a list. [Name] shops.

**What we say about competitors.** Nothing by name. The contrast is "recipe apps stop at a list."

**What we don't claim.** Price comparison across stores (Kroger and Instacart terms forbid showing it). Unattended checkout, except in the opt-in assisted mode, described plainly as "the agent fills the cart and stops at the pay button."

### 3.1 Personas

| Persona | Situation | What they need from us |
|---|---|---|
| The Tuesday parents | Two working adults, two kids, one nut allergy. Dinner planning happens in the car | Allergy filters they can trust, a 30-second review on a phone, pickup on the way home |
| The Costco-and-QFC couple | Cook four nights a week. Bulk staples at Costco, fresh stuff at QFC | Store splitting by rule, a Saturday morning run, leftovers planned on purpose |
| The strict-budget cook | One person, tight weekly budget, a specific diet | Budget cap per run, cheap-cut suggestions, no surprises at checkout |

## 4. Elevator pitches

**Ten seconds.** [Name] plans your week's dinners and loads your grocery cart. You look it over on your phone and tap pay.

**Thirty seconds.** Every week [Name] picks dinners your household will eat, builds one grocery list, and turns it into real products at your store. On Saturday morning the cart's ready: you check it, swap anything, and pay in the store's app. Pickup's on the way home. It learns what you buy, so week two is better than week one.

## 5. Landing page (apps/marketing)

Structure and draft copy. Sentence case. No retailer logos anywhere on marketing pages. "Works with" is text.

**Hero**
- Headline: Dinner, decided. Groceries, done.
- Sub: [Name] plans the week, builds the list, and fills your cart at QFC, Fred Meyer, Safeway, or Costco. You tap pay.
- CTA: Join the waitlist

**How it works** (three steps)
1. Tell it how you eat. Allergies, budget, how much time you have on a Tuesday.
2. Get a week you'll actually cook. Swap anything with a tap.
3. Wake up to a full cart. Review it, pay in the store's app, pick it up.

**Works with** (text only)
QFC and Fred Meyer carts fill automatically. Safeway and Costco lists open ready to shop with Instacart. Assisted checkout for Safeway and Costco is available to households that opt in.

**Why it's different**
- One list, several stores. Bulk at Costco, produce at QFC, by your rules.
- It remembers. Pick a brand once and it stays picked.
- Allergies are enforced in code, not suggested by a model.
- Nothing gets bought without you. The cart waits for your tap.

**Privacy**
We never see your card. Payment happens in the store's own checkout. Your retailer login stays with the retailer. You can export or delete everything, any time.

**Waitlist form**
Email, zip code. Copy: "We're starting in Washington. Tell us your zip and we'll let you know when your stores are live."

**FAQ**
- Does it buy things without asking? No. It fills the cart and stops. Households can opt in to assisted checkout, where it still pauses at the pay button unless you set a cap.
- Which stores? QFC and Fred Meyer today. Safeway and Costco through Instacart, with assisted checkout for households that opt in.
- What about allergies? Allergies are hard filters. A recipe or product that trips one never shows up.
- Is this a subscription? Not yet. We're building for our own household first.

## 6. App Store listing (draft)

- **Title (≤30):** [Name]: Meal plan to cart
- **Subtitle (≤30):** Plan the week. Fill the cart.
- **Promotional text:** Pick dinners, get one list, wake up to a full grocery cart at QFC or Fred Meyer. Review, tap pay, pick up.
- **Description:**
  [Name] is a meal planner that finishes the job.

  Tell it how your household eats: allergies, diets, budget, how much time you have on a weeknight. It suggests a week of dinners you'll cook, or import your own from any site, a photo, or a pasted caption.

  One list for the whole week, with pantry staples removed and everything grouped by aisle. Shop it in the store, offline, with everyone in the house checking things off.

  Or let [Name] do the shopping. It turns your list into real products at your QFC or Fred Meyer, fills your cart on a schedule you choose, and sends you a note when it's ready. You review it, swap anything, and pay in the store's app. For Safeway and Costco, your list opens ready to shop with Instacart.

  It learns. Pick a brand once and it stays picked. Allergies are enforced in code. Nothing is bought without you.

  Built in Washington, for Washington stores first.
- **Keywords (≤100 chars):** meal planner,grocery list,recipes,weekly dinner,pickup,shopping list,meal prep,QFC,Costco,Safeway
- **What's new (v1):** First release for our household and friends.

Compliance notes: no "Kroger" in title or subtitle; "QFC" and "Costco" in keywords are nominative use and fine; never "Free Delivery"; never "partner."

## 7. Launch channels (Phase 4, when the public beta decision is yes)

1. Product Hunt, with the ten-second pitch and a 20-second screen recording of a Saturday run.
2. r/Seattle, r/SeattleWA, r/mealprep, r/EatCheapAndHealthy: a plain post about what it does and what it doesn't.
3. Pacific Northwest parenting groups, through members who already use it.
4. Two or three Seattle meal-prep creators on TikTok and Instagram, offered early access, no payment.
5. A short write-up on miguelsolorio.com about building it, in the site's existing voice.

## 8. Onboarding emails (three)

**Email 1, right after sign-up: "Connect your store"**
Subject: One tap and your cart fills itself
Body: Thanks for joining. The fastest way to see what [Name] does is to connect QFC or Fred Meyer. It takes one sign-in and we never see your password. After that, plan a week and we'll fill the cart. [Connect a store]

**Email 2, day two: "Your first week"**
Subject: Here's a week you'd probably cook
Body: Based on what you told us, we drafted seven dinners. Swap any of them. When it looks right, build the list and pick a day for the shopping run. [Open the plan]

**Email 3, after the first run: "How did the cart look?"**
Subject: Was anything wrong in the cart?
Body: Your first cart was [n] items for about $[total]. If we picked the wrong brand or size, tap "always this one" on the right product and we'll remember. Reply to this email with anything else; a person reads it.

## 9. Press blurb

[Name] is a meal-planning app that does the shopping. It suggests a week of dinners a household will cook, builds one grocery list, and fills the cart at QFC or Fred Meyer through Kroger's public API, with Safeway and Costco lists handed to Instacart. The person reviews the cart on their phone and pays in the store's app. It launched for Washington households first and is built by Miguel Solorio, a software designer in Duvall, Washington.

## 10. Copy rules for everything we publish

- No em dashes. Use a period, a colon, or reorder.
- Sentence case headings. Spell out numbers under ten in prose. Contractions are fine.
- Say what it does in concrete nouns: cart, list, Saturday, QFC. Skip "seamless," "empower," "effortless," "smart," "AI-powered."
- Never say the app pays for you unless describing the opt-in assisted mode, and then say it stops at the pay button.
- Never show a retailer's prices next to another retailer's.
- Never call Instacart a partner. Never write "Free Delivery."
