# 08 · Brand

Names, slogans, positioning, and the marketing materials WS14 turns into a landing page and a store listing. WS14 ran the name checks in §1.3 on 2026-10-30. The results and a three-name recommendation are in §1.4. They are evidence, not clearance.

## 1. Name

### 1.1 Shortlist

| Name | Why it works | Watch out for |
|---|---|---|
| **Souvie** | Sous plus vie: "Sous life," said "SOO-vee." One word, sounds like sous vide, and keeps the sous-chef idea with some motion in it. Fits on an icon as is, verbs well ("Souvie it"), and reads playful rather than technical | Said aloud it may get typed "Souvi," "Suvi," or "Soovee," so check those variants too. App Store search will surface sous vide cooker apps next to it. Check USPTO class 9 and 42, and `souvie.com`, `.app`, `.co` |
| **Sous** | A sous-chef preps and shops so the cook can cook. Four letters, one syllable, verbs well ("Sous it"). Says "assistant in the kitchen" without saying AI | Several small kitchen apps have used "Sous" or "Sous Chef." Check the App Store and USPTO class 9 and 42 |
| **Larder** | The stocked pantry. Implies provisioning, which is the job, and it's warmer than "grocery" | Common word; a few food brands use it. Domain likely taken; `larder.app` or `getlarder.com` may be open |
| **Mise** | From mise en place: everything in its place before you cook. Pronounced "meez." Reads as craft | Needs a pronunciation hint on first use. At least one cooking app has used it |
| **Forkcast** | A forecast for the week's forks. Dry, a little silly, memorable | Puns date fast. Check for a podcast or newsletter by this name |
| **Cartwheel** | The plan-to-cart motion in one word. Friendly | Target ran a loyalty program called Cartwheel until 2019. The trademark may still be live in retail classes. Probably skip |

Also considered: Provision, Simmer, Marketday, Stocked, Ladle, Hearth, Tablewise, Platewise, Weeknight. Two-word variants on Sous that add motion: Sous Vive, Sous Vif, Sous Vite, Sous Run, Sous Shift, Sous Avant, Sous Loop, Sous Tempo. Any of these would put "Sous" alone on the home screen icon and the full name in the store.

**Recommendation (updated 2026-10-30):** the checks in §1.4 knocked out Sous and Larder, the earlier fallbacks, along with Mise, Forkcast, and Cartwheel. Souvie stays the working name, conditional on a lawyer's read of one pending mark and a domain plan. Tablewise and Marketday are the next two. Use "meal-planner" as the repo and working name until checkpoint 6, and keep [Name] in the copy below until the name is chosen.

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

WS14 ran items 1 to 4 on 2026-10-30. Item 5 (social handles) is still open. Results are in §1.4. Record the final choice in `status.md` under the decisions log.

### 1.4 Availability checks (WS14, run 2026-10-30)

**These are evidence, not clearance.** They show what a search for the word turns up today. They do not say a name is free to use, and they do not replace a trademark search by counsel. Miguel chooses the name at human checkpoint 6.

How each column was run:

- **USPTO.** Trademark Search at `tmsearch.uspto.gov` (TESS was retired in 2023). Wordmark search for the single word. Filters: status Live (registered and pending), class 009 with "Coordinated" on, which also returns marks in related classes such as 035, 041, 042, and 043. Dead and abandoned marks are left out. The search matches whole words, so two-word forms, misspellings, and sound-alikes need a lawyer. The site has no per-search URL, so every USPTO cell links to the search page.
- **App Store.** The iTunes Search API, US storefront, software, top 50. "Same-name" means the app title is the name, or the name before a colon or dash.
- **Google Play.** The US search page, first eight results, with each title read from its details page. Same rule for "same-name."
- **.com and .app.** RDAP at Verisign and Google Registry. "Taken" means registered. "Live site" means it answered over HTTPS with a page.
- **.co.** No RDAP service exists for .co, so WHOIS at `whois.registry.co`.
- **npm.** `registry.npmjs.org/<name>` for the bare package name. **GitHub.** `api.github.com/users/<name>`, which covers users and organizations.
- **Not run:** Instagram, TikTok, and X handles (§1.3 item 5), state trademark registers, marks outside the USPTO filter above, international marks, and common-law use. Prices for domains were not collected.

| Name | USPTO | App Store (US) | Google Play (US) | .com | .app | .co | npm | GitHub |
|---|---|---|---|---|---|---|---|---|
| **Souvie** | [1 live: ESSENTIAL SOUVIE, pending, Cuisine Solutions, classes 29, 30, 35, 39, 42, 43. 2 dead (ONLY SOUVIE, S SOUVIE)](https://tmsearch.uspto.gov/search/search-information) | [no same-name app; close: SouvieShelf](https://itunes.apple.com/search?term=souvie&entity=software&country=us&limit=50) | [no same-name app](https://play.google.com/store/search?q=souvie&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/souvie.com) | [taken, no site](https://pubapi.registry.google/rdap/domain/souvie.app) | taken, live site (`whois -h whois.registry.co souvie.co`) | [free](https://www.npmjs.com/package/souvie) | [taken (user, 0 repos)](https://github.com/souvie) |
| **Souvi (variant)** | [0 live](https://tmsearch.uspto.gov/search/search-information) | [1 same-name: Souvi: Shared Photo Albums](https://itunes.apple.com/search?term=souvi&entity=software&country=us&limit=50) | [1 same-name: Souvi: Shared Photo Albums](https://play.google.com/store/search?q=souvi&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/souvi.com) | [taken, live site](https://pubapi.registry.google/rdap/domain/souvi.app) | taken, no site (`whois -h whois.registry.co souvi.co`) | [free](https://www.npmjs.com/package/souvi) | [taken (organization, 0 repos)](https://github.com/souvi) |
| **Suvi (variant)** | [2 live: SUVI HEALTH pending (9, 42); SUVI registered (9)](https://tmsearch.uspto.gov/search/search-information) | [no same-name app; close: AI MV & AI Music Video: Suvi](https://itunes.apple.com/search?term=suvi&entity=software&country=us&limit=50) | [1 same-name: Suvi](https://play.google.com/store/search?q=suvi&c=apps) | [taken, no site](https://rdap.verisign.com/com/v1/domain/suvi.com) | [taken, no site](https://pubapi.registry.google/rdap/domain/suvi.app) | taken, no site (`whois -h whois.registry.co suvi.co`) | [free](https://www.npmjs.com/package/suvi) | [taken (user, 0 repos)](https://github.com/suvi) |
| **Soovee (variant)** | [0 live](https://tmsearch.uspto.gov/search/search-information) | [no same-name app](https://itunes.apple.com/search?term=soovee&entity=software&country=us&limit=50) | [no same-name app](https://play.google.com/store/search?q=soovee&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/soovee.com) | [free](https://pubapi.registry.google/rdap/domain/soovee.app) | free (`whois -h whois.registry.co soovee.co`) | [free](https://www.npmjs.com/package/soovee) | [taken (user, 0 repos)](https://github.com/soovee) |
| **Sous** | [27 live. SOUS registered (9, 42, mobile app, Aurora Technologies); SOUS pending (42, Institute of Food Technologists); SOUSCHEF pending (9, 42); YES, SOUS CHEF pending (9, 42); CHEF & SOUS pending (9, 41, 42)](https://tmsearch.uspto.gov/search/search-information) | [5 same-name: Sous - Personal Chefs; Sous: AI Recipes & Meal Plans; Sous: Meal planner (+2)](https://itunes.apple.com/search?term=sous&entity=software&country=us&limit=50) | [2 same-name: Sous: Recipes & Meal Plans; Sous: AI Cooking Assistant](https://play.google.com/store/search?q=sous&c=apps) | [taken, live site: SOUS.com](https://rdap.verisign.com/com/v1/domain/sous.com) | [taken, live site](https://pubapi.registry.google/rdap/domain/sous.app) | taken, no site (`whois -h whois.registry.co sous.co`) | [taken](https://www.npmjs.com/package/sous) | [taken (user, 16 repos)](https://github.com/sous) |
| **Larder** | [4 live. LARDER registered (9, 42, 44) for recipe and ingredient mobile apps, Alderwood Limited (UK)](https://tmsearch.uspto.gov/search/search-information) | [6 same-name: Larder:Paycheck Budget Planner; Larder: Family Meal Planner; Larder: Meal Planner (+3)](https://itunes.apple.com/search?term=larder&entity=software&country=us&limit=50) | [3 same-name: Larder: Meal Planner & Recipes; Larder: Mise en Go; Larder](https://play.google.com/store/search?q=larder&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/larder.com) | [taken, no site](https://pubapi.registry.google/rdap/domain/larder.app) | taken, live site: larder.co for sale / Spaceship.com (`whois -h whois.registry.co larder.co`) | [taken](https://www.npmjs.com/package/larder) | [taken (organization, 3 repos)](https://github.com/larder) |
| **Mise** | [16 live. MISE pending (35, 42, 43, 45), Foodrunner Inc (Washington); MISE registered (9, 16); AI MISE pending (42)](https://tmsearch.uspto.gov/search/search-information) | [4 same-name: mise - meal planner; Mise: Meal Plan & Grocery List; mise - recipes, simplified (+1)](https://itunes.apple.com/search?term=mise&entity=software&country=us&limit=50) | [7 same-name: mise - meal planner; Mise: AI Sous Chef & Meal Plan; Mise: Recipe Saver & Importer (+4)](https://play.google.com/store/search?q=mise&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/mise.com) | [taken, no site](https://pubapi.registry.google/rdap/domain/mise.app) | taken, no site (`whois -h whois.registry.co mise.co`) | [taken](https://www.npmjs.com/package/mise) | [taken (user, 3 repos)](https://github.com/mise) |
| **Forkcast** | [2 live. FORKCAST pending (9), vendor-selection software, Forkcast Technologies; LIPARI FORKCAST pending (35)](https://tmsearch.uspto.gov/search/search-information) | [1 same-name: ForkCast - Meal & Grocery Plan](https://itunes.apple.com/search?term=forkcast&entity=software&country=us&limit=50) | [3 same-name: Forkcast: Meal Calories; Forkcast; ForkCast - Meal & Grocery Plan](https://play.google.com/store/search?q=forkcast&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/forkcast.com) | [taken, live site: AI Meal Planner: Weekly Meal Plans & Shopping Lists / Forkcast](https://pubapi.registry.google/rdap/domain/forkcast.app) | taken, live site (`whois -h whois.registry.co forkcast.co`) | [free](https://www.npmjs.com/package/forkcast) | [taken (organization, 14 repos)](https://github.com/forkcast) |
| **Cartwheel** | [14 live. CARTWHEEL registered (42) three times, including delivery software (GR Dispatch)](https://tmsearch.uspto.gov/search/search-information) | [1 same-name: Cartwheel - AI Grocery Lists](https://itunes.apple.com/search?term=cartwheel&entity=software&country=us&limit=50) | [no same-name app; close: Cartwheel Driver](https://play.google.com/store/search?q=cartwheel&c=apps) | [taken, live site: Cartwheel / NameBrokers](https://rdap.verisign.com/com/v1/domain/cartwheel.com) | [taken, live site](https://pubapi.registry.google/rdap/domain/cartwheel.app) | taken, live site: VW108 : Mengenal Cartwheel Robotics dan Inovasi Teknologi AI (`whois -h whois.registry.co cartwheel.co`) | [taken](https://www.npmjs.com/package/cartwheel) | [taken (organization, 4 repos)](https://github.com/cartwheel) |
| **Provision** | [76 live. PROVISION registered (42, 9) several times for business and security software](https://tmsearch.uspto.gov/search/search-information) | [2 same-name: Provision; Provision: Emergency Store](https://itunes.apple.com/search?term=provision&entity=software&country=us&limit=50) | [1 same-name: Provision](https://play.google.com/store/search?q=provision&c=apps) | [taken, live site: Provision AI / Pre-Construction Platform for General Contractors 2026](https://rdap.verisign.com/com/v1/domain/provision.com) | [taken, live site](https://pubapi.registry.google/rdap/domain/provision.app) | taken, live site (`whois -h whois.registry.co provision.co`) | [taken](https://www.npmjs.com/package/provision) | [free](https://github.com/provision) |
| **Simmer** | [16 live, not itemized](https://tmsearch.uspto.gov/search/search-information) | [6 same-name: Simmer: Recipe Organizer; SIMMER: Financial Wellness; Simmer (+3)](https://itunes.apple.com/search?term=simmer&entity=software&country=us&limit=50) | [4 same-name: Simmer; Simmer; SIMMER (+1)](https://play.google.com/store/search?q=simmer&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/simmer.com) | [taken, no site](https://pubapi.registry.google/rdap/domain/simmer.app) | taken, live site: simmer.co / Premium Domain Portfolio (`whois -h whois.registry.co simmer.co`) | [taken](https://www.npmjs.com/package/simmer) | [taken (organization, 1 repo)](https://github.com/simmer) |
| **Marketday** | [0 live as one word. MARKET DAY (two words) registered (9, 16, 18, 21, 25, 29, 30), World's Finest Chocolate](https://tmsearch.uspto.gov/search/search-information) | [1 same-name: MarketDay: Farmers Markets](https://itunes.apple.com/search?term=marketday&entity=software&country=us&limit=50) | [no same-name app; close: 8 market days](https://play.google.com/store/search?q=marketday&c=apps) | [taken, no site](https://rdap.verisign.com/com/v1/domain/marketday.com) | [taken, live site](https://pubapi.registry.google/rdap/domain/marketday.app) | taken, live site (`whois -h whois.registry.co marketday.co`) | [free](https://www.npmjs.com/package/marketday) | [free](https://github.com/marketday) |
| **Stocked** | [18 live, not itemized](https://tmsearch.uspto.gov/search/search-information) | [3 same-name: Stocked - Grocery Organization; Stocked; Stocked: Household Supplies](https://itunes.apple.com/search?term=stocked&entity=software&country=us&limit=50) | [4 same-name: Stocked; Stocked; Stocked: Household Supplies (+1)](https://play.google.com/store/search?q=stocked&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/stocked.com) | [taken, live site: Stocked dot App: premium domain name (Buy now) - stocked.app](https://pubapi.registry.google/rdap/domain/stocked.app) | taken, live site (`whois -h whois.registry.co stocked.co`) | [taken](https://www.npmjs.com/package/stocked) | [taken (organization, 6 repos)](https://github.com/stocked) |
| **Ladle** | [4 live. LADLE registered (42), cloud software, Storewise Inc.; FORK & LADLE registered (35, 43)](https://tmsearch.uspto.gov/search/search-information) | [4 same-name: Ladle: Recipe & Meal Planner; Ladle: Recipes & Meal Plan; Ladle: The Cooking Book (+1)](https://itunes.apple.com/search?term=ladle&entity=software&country=us&limit=50) | [3 same-name: Ladle: Recipe & Meal Planner; Ladle: Recipe Keeper & Saver; Ladle: Recipe Box & Planner](https://play.google.com/store/search?q=ladle&c=apps) | [taken, live site: Smart Solutions for Foodservice Operations & Compliance / Ladle](https://rdap.verisign.com/com/v1/domain/ladle.com) | [taken, live site](https://pubapi.registry.google/rdap/domain/ladle.app) | free (`whois -h whois.registry.co ladle.co`) | [taken](https://www.npmjs.com/package/ladle) | [taken (organization, 0 repos)](https://github.com/ladle) |
| **Hearth** | [118 live, not itemized](https://tmsearch.uspto.gov/search/search-information) | [6 same-name: Hearth: Cozy Fireplace; Hearth: Family Care; Hearth: Bills & Reminders (+3)](https://itunes.apple.com/search?term=hearth&entity=software&country=us&limit=50) | [4 same-name: Hearth: Couples Budget; Hearth - Magical Home & Living; Hearth: Browser That Remembers (+1)](https://play.google.com/store/search?q=hearth&c=apps) | [taken, live site: Hearth.com Forums Home](https://rdap.verisign.com/com/v1/domain/hearth.com) | [taken, live site: hearth](https://pubapi.registry.google/rdap/domain/hearth.app) | taken, live site (`whois -h whois.registry.co hearth.co`) | [taken](https://www.npmjs.com/package/hearth) | [taken (organization, 0 repos)](https://github.com/hearth) |
| **Tablewise** | [0 live](https://tmsearch.uspto.gov/search/search-information) | [no same-name app](https://itunes.apple.com/search?term=tablewise&entity=software&country=us&limit=50) | [no same-name app](https://play.google.com/store/search?q=tablewise&c=apps) | [taken, no site](https://rdap.verisign.com/com/v1/domain/tablewise.com) | [taken, live site: TableWise](https://pubapi.registry.google/rdap/domain/tablewise.app) | taken, live site (`whois -h whois.registry.co tablewise.co`) | [free](https://www.npmjs.com/package/tablewise) | [taken (organization, 0 repos)](https://github.com/tablewise) |
| **Platewise** | [0 live](https://tmsearch.uspto.gov/search/search-information) | [2 same-name: PlateWise; Platewise: Macro Diary](https://itunes.apple.com/search?term=platewise&entity=software&country=us&limit=50) | [1 same-name: PlateWise - AI Calorie Counter](https://play.google.com/store/search?q=platewise&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/platewise.com) | [taken, no site](https://pubapi.registry.google/rdap/domain/platewise.app) | taken, no site (`whois -h whois.registry.co platewise.co`) | [free](https://www.npmjs.com/package/platewise) | [taken (organization, 0 repos)](https://github.com/platewise) |
| **Weeknight** | [2 live. WEEKNIGHT KITCHEN registered (classes 9 and 41), Minnesota Public Radio](https://tmsearch.uspto.gov/search/search-information) | [2 same-name: Weeknight: Meal Plan + Recipes; Weeknight: Dinner Planner](https://itunes.apple.com/search?term=weeknight&entity=software&country=us&limit=50) | [no same-name app; close: Guilt Free Weeknight Meals](https://play.google.com/store/search?q=weeknight&c=apps) | [taken, live site](https://rdap.verisign.com/com/v1/domain/weeknight.com) | [taken, live site: Weeknight - Dinner, handled.](https://pubapi.registry.google/rdap/domain/weeknight.app) | taken, live site: Weeknight: Dinner, handled. (`whois -h whois.registry.co weeknight.co`) | [free](https://www.npmjs.com/package/weeknight) | [taken (user, 1 repo)](https://github.com/weeknight) |

What the table shows:

- **Souvie.** No same-name app on either store and no live USPTO mark for the word alone. Two things to take to a lawyer. Cuisine Solutions, Inc. has a pending application for ESSENTIAL SOUVIE (classes 29, 30, 35, 39, 42, 43, sous-vide foods) and an earlier ONLY SOUVIE that was abandoned, so the word looks like a house term of theirs. And **Suvie**, a Food & Drink app from Home Tech Innovation Inc. that sells chef-designed meals and a countertop cooking appliance (also `com.suvie.app` on Google Play), sounds the same when said aloud. All three of souvie.com, souvie.app, and souvie.co are registered. souvie.com is a Brazilian cosmetics shop and souvie.co is a Turkish online shop. `getsouvie.com`, `trysouvie.com`, `usesouvie.com`, `hellosouvie.com`, `souvieapp.com`, and `souviehq.com` returned "not registered" at Verisign.
- **Sous.** Fails. SOUS is a registered mark in classes 9 and 42 for a mobile app (Aurora Technologies), SOUS is pending in 42 for a food-technology institute, and the App Store has five apps called Sous, most of them recipe or meal-plan apps.
- **Larder.** Fails. LARDER is registered in 9, 42, and 44 for recipe and ingredient mobile apps (Alderwood Limited, UK). Six App Store apps and three Play apps use the name, several of them meal planners or pantry trackers.
- **Mise.** Fails. MISE is pending in 35, 42, 43, and 45 for Foodrunner Inc, a Washington company. Four App Store apps and seven Play apps use the name, most for meal planning or recipes.
- **Forkcast.** Fails. "ForkCast - Meal & Grocery Plan" is on both stores, and `forkcast.app` is an AI meal planner with shopping lists.
- **Cartwheel.** Fails. Three live CARTWHEEL registrations in class 42 (one for delivery software) and one in 44, plus an App Store app named "Cartwheel - AI Grocery Lists."
- **Secondary names.** Simmer, Stocked, Ladle, Hearth, and Weeknight each have same-name recipe, meal-plan, or grocery apps. Platewise has nutrition apps. Provision has dozens of registered PROVISION marks in software classes. Marketday and Tablewise have no same-name meal-planning app.

**Recommendation: three names, in order.** Nothing here is clear. Drop Sous, Larder, Mise, Forkcast, and Cartwheel: each already has a same-name meal-planning or grocery app in the stores, and Sous, Larder, and Mise also have live marks in classes 9, 42, or 43.

1. **Souvie, conditional.** It is the only name from the original shortlist with no same-name app and no live mark for the bare word, it keeps the Sous idea, and it already fits the icon and the copy. Before committing, a lawyer should read the ESSENTIAL SOUVIE application and the Suvie overlap, and Miguel should pick a domain (`getsouvie.com` or a similar unregistered form, or an offer for souvie.app). If counsel is uneasy, take number two.
2. **Tablewise.** No same-name app on either store, no live USPTO match for the word, npm free. `tablewise.app` and `tablewise.co` host a restaurant QR-ordering product called TableWise, so expect a trademark question in classes 9, 42, and 43 and no clean domain; `trytablewise.com`, `usetablewise.com`, and `hellotablewise.com` were unregistered. It reads a little like restaurant software.
3. **Marketday.** No same-name meal-planning app (the App Store has "MarketDay: Farmers Markets," a market finder), no live one-word USPTO match, npm and GitHub free, and it names the Saturday run. Two-word MARKET DAY is registered in classes 9, 16, 18, 21, 25, 29, and 30 by World's Finest Chocolate, Inc. for catalogs and food products, which is close to groceries. `marketday.app` and `marketday.co` are live sites; `usemarketday.com` and `marketdayhq.com` were unregistered.

Record the decision in `status.md` under the decisions log. WS13 needs the final name for the desktop title and bundle id.

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

This is the copy as shipped by WS14. Source files: `apps/marketing/src/components/` (Hero, HowItWorks, Stores, Trust, Waitlist, Footer) and `src/pages/privacy.astro`. The name is the placeholder "Meal Planner", read from `apps/marketing/src/config.ts`. Sentence case. No retailer logos anywhere on marketing pages. "Works with" is text. No pricing, "Pro," or subscription language (v1 is non-commercial, `06-risks.md` R22).

`apps/marketing/scripts/check-copy.mjs` scans the blocks between the `copy:start` and `copy:end` markers below, plus the site source. It fails on "partner" near "Instacart," "Free Delivery," "Kroger" in a title or heading, em dashes, and prices.

<!-- copy:start -->
**Hero**
- Headline: Dinner, decided. Groceries, done.
- Sub: [Name] plans your household's week, builds one list, and fills your carts across stores on a schedule you pick. You tap pay.
- CTA: Join the waitlist
- Line under the CTA: Coming to iOS and web. Starting in Washington.

**How it works** (three steps)
1. Plan. Tell it how your household eats: allergies, budget, how much time you have on a Tuesday. It suggests a week of dinners you'll cook. Swap anything with a tap.
2. List. One list for the whole week. Pantry staples come off, amounts add up, and everything's grouped by aisle. Shop it in the store, offline, with everyone checking things off.
3. Cart. Pick a day and [Name] fills your cart. You review it, swap anything, and pay in the store's app. Pickup's on the way home.

**Why it's different** (under the steps)
- One list, several stores. Bulk at Costco, produce at QFC, by your rules.
- It remembers. Pick a brand once and it stays picked.
- Allergies are enforced in code, not suggested by a model.

**Works with your stores** (text only)
Works with QFC, Fred Meyer, Safeway, Albertsons, and Costco in Washington.
QFC and Fred Meyer carts fill automatically. Safeway, Albertsons, and Costco lists open ready to shop on Instacart.

**Your money and your data stay yours**
- We never see your card. You pay in the store's own app or checkout.
- Your store login stays with the store. Sign-in happens on the store's page, not ours.
- Nothing gets bought without you. The cart waits for your tap.
- You can export or delete everything, any time. Your plans, lists, and history are yours.

**Join the waitlist**
We're starting in Washington. Tell us your zip and we'll email you when your stores are live.
Fields: Email, Zip code (optional).
Confirmation: You're on the list. We'll email you when your stores are live.
Already signed up: You're already on the list.
Fine print: We use your email and zip only to tell you when [Name] opens. Coming to iOS and web.

**Footer**
[Name]. Built in Washington. Coming to iOS and web. Privacy policy (placeholder page).
QFC, Fred Meyer, Safeway, Albertsons, Costco, and Instacart are trademarks of their owners. [Name] isn't affiliated with or endorsed by them.
<!-- copy:end -->

Changes from the earlier draft, and why:

- **Hero sub** now sells the household loop (one plan, one list, carts across stores, a schedule) instead of "recipe to cart," which Kroger and Instacart now ship for free (`00-overview.md` §Landscape, R12).
- **Stores** dropped the line about assisted checkout for Safeway and Costco. That is Tier 3, behind a flag, with consent copy still waiting on human checkpoint 5, and Costco's terms prohibit agents. Add it back only after that checkpoint.
- **Zip code** stays, optional, because `02-data-model.md` lists a `zip` column on `waitlist`.
- **FAQ** is not shipped. Its "Is this a subscription?" answer is pricing language, which v1 avoids. The other answers are covered in the sections above.
- **"Why it's different"** moved under the three steps rather than getting its own section, so the page keeps the section order in the brief.
- The page says "We're starting in Washington" and "Coming to iOS and web." Nothing says when.

Not yet written: the real privacy policy and a contact address. The placeholder page at `/privacy/` says so.

## 6. Store listings (ready to paste)

Fill in [Name] once checkpoint 6 picks it. Character counts below are for the text as written, with the name counted as shown. The title leaves 11 characters for the name: Souvie (6), Tablewise (9), and Marketday (9) fit; "Meal Planner" (12) does not, so use "Meal Planner: Plan to cart" (26) if the placeholder ships.

<!-- copy:start -->
### App Store (iOS)

- **Title (30 max):** [Name]: Meal plan to cart
  - Souvie: Meal plan to cart (25). Tablewise: Meal plan to cart (28). Marketday: Meal plan to cart (28).
- **Subtitle (30 max):** Plan the week. Fill the cart. (29)
- **Promotional text (170 max):** One plan for your household, one list split across your stores, and carts that fill on a schedule you pick. You review, tap pay, pick up. (137)
- **Description (4,000 max):**

  [Name] is a meal planner that finishes the job.

  Tell it how your household eats: allergies, diets, budget, how much time you have on a weeknight. It suggests a week of dinners you'll cook. Or import your own from a website, a photo, or a pasted caption.

  One list for the whole week, with pantry staples removed and everything grouped by aisle. Shop it in the store, offline, with everyone in the house checking things off.

  Or let [Name] do the shopping. It turns your list into real products at your QFC or Fred Meyer, fills your cart on a schedule you choose, and sends you a note when it's ready. You review it, swap anything, and pay in the store's app. For Safeway, Albertsons, and Costco, your list opens ready to shop on Instacart.

  It learns. Pick a brand once and it stays picked. Allergies are enforced in code, not suggested by a model. Nothing is bought without you.

  Built in Washington, for Washington stores first.
- **Keywords (100 max):** grocery list,recipes,weekly dinner,pickup,shopping list,meal prep,family,dinner ideas,menu,planner (98)
- **What's new, v1:** First release for our household and friends.
- **What's new, template:** Version [x.y]. [One sentence on what changed, in plain words.] [One sentence on what to try first.]

### Google Play

- **Title (30 max):** [Name]: Meal plan to cart (same as the App Store; the counts above apply)
- **Short description (80 max):** Plan the week's dinners, build one list, and fill your carts. You tap pay. (74)
- **Full description (4,000 max):** The App Store description above, unchanged. (About 930 characters.)
<!-- copy:end -->

Why the keywords differ from the first draft:

- The first draft listed QFC, Costco, and Safeway. Apple's App Review Guidelines (2.3.7) tell developers not to put other companies' trademarks in keywords, and a rejection costs a review cycle. Say the store names in the description, where they are plain statements of compatibility. If Miguel wants them in the keywords anyway, he can add them inside the 100-character limit and accept the review risk.
- Apple indexes the title and subtitle on their own, so the keyword field does not repeat their phrases ("meal plan," "fill the cart").

Compliance notes: no "Kroger" in the title or subtitle. Never "Free Delivery." Never "partner." No prices or plans anywhere (v1 is non-commercial). The retailer names appear only in the description, as compatibility statements. No Kroger or other banner logos in screenshots or the icon.

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
