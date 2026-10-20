# Commercialising Raw Muscle Gym Tracker: Google Play first

## Context

The app is an offline PWA: static files in `docs/`, hosted on GitHub Pages at
`simonraw1.github.io/gym_planner/`, with all data in the phone's IndexedDB and
no backend. The goal is to sell it, starting on Google Play (cheaper and
lower-risk than Apple). Below are the business, store and code steps, in
order, with a recommendation at each fork. The code steps (section 4) are
what I'd implement once you approve.

## 1. Packaging: wrap the PWA as a Trusted Web Activity (TWA)

**Recommendation:** a TWA built with Bubblewrap or PWABuilder
(pwabuilder.com produces a signed Play bundle from the manifest).
- The Play app is a thin Android shell that opens the web app full screen in
  Chrome, with no URL bar. It keeps one codebase: a web deploy updates the
  Play app instantly, with no store review for each change.
- It needs **Digital Asset Links**: a file at
  `https://<domain>/.well-known/assetlinks.json`. A GitHub Pages *project* site
  can't serve the domain root, so this effectively needs a custom domain (see 2).
- **Alternative, later:** Capacitor bundles the files inside the app, so it
  needs no hosting or domain verification and gives native plugins (local
  notifications for the rest timer, haptics, file save, Play Billing). The
  costs are an Android Studio/Gradle build and updates only through Play
  releases. Switch only if TWA limits bite.

## 2. Hosting and domain (needed before Play)

- **Buy a domain**, e.g. `rawmuscle.app`, and point the app at it.
- **Move hosting off GitHub Pages.** Its terms say it isn't for "commercial
  transactions or SaaS". Cloudflare Pages or Netlify both have free tiers that
  allow commercial use, deploy straight from this repo, and can serve
  `/.well-known/`.
- **Links follow automatically.** Relative URLs are already used everywhere,
  and plans links come from `linkFor()` in `docs/app.js` (built from
  `location.href`), so they switch to the new domain without code changes.
  With asset links verified, a tapped `#plans=` link opens straight in the
  Play app.

## 3. Business, store and legal checklist

**Google Play account ($25 one-off).**
- **Personal account:** new personal accounts must run a **closed test with
  at least 12 testers for 14 days** before going to production. Your gym
  members are ideal testers.
- **Organisation account:** if you trade as a company (Ratch Tech?), this
  needs a D-U-N-S number but skips the 12-tester rule.
- **Address shown publicly:** apps that make money show the developer's
  address on the store page, so use a business address.

**Store listing.**
- Category: Health & Fitness.
- 512px icon (already in `docs/icons/`), a 1024×500 feature graphic, and at
  least 2 phone screenshots.
- Short and full descriptions.

**Play Console forms.**
- **Data safety:** "no data collected or shared" is true today, which is a
  real selling point.
- **Privacy policy URL:** required. Write a short one saying all data stays on
  the device.
- **Other forms:** content rating questionnaire, target audience (adults),
  Health apps declaration, ads (none).

**Brand and IP.**
- Confirm you own the bear logo (`tools/logo.png`).
- Trademark-search "Raw Muscle" (UK IPO / EUIPO / USPTO).
- Keep the SweetAlert2 MIT licence credited.

**Terms and disclaimer.** Add a short "not medical advice, train at your own
risk" notice and terms of use. Google handles VAT/GST, refunds and checkout
for Play purchases.

## 4. Product changes before launch (code work, in priority order)

1. **Play-ready shell.**
   - **Install gate:** don't show it inside the Play app. `isGated` in
     `docs/app.js` (~line 1478) relies on `(display-mode: standalone)`. Also
     treat `document.referrer.startsWith("android-app://")` (the TWA launch
     marker) as installed, and remember it in a pref.
   - **Manifest:** add `screenshots`, `categories: ["health","fitness"]` and
     `lang` to `docs/manifest.webmanifest`.
   - **Asset links:** add `docs/.well-known/assetlinks.json`. It needs the
     signing certificate fingerprint from Play.
2. **Data safety for paying users.** Data lives only in the browser storage
   for the domain, and uninstalling the app or clearing Chrome data wipes it.
   - **Backup reminder:** prompt on the Train page when the last backup is
     over 14 days old. The `last_export` data is already tracked and shown in
     Settings as "Never backed up".
   - **Auto-export after a workout:** an optional share of the backup file to
     Drive. It stays local-first, with no cloud sync, which AGENTS.md rules
     out unless you ask.
3. **First-run experience.**
   - **Welcome screen:** a 3-step intro on first launch.
   - **Starter programme:** a sample folder (e.g. "Beginner 3-day full body")
     loaded with the existing `importPlans()` from a bundled plans file.
   - **Better empty states.**
4. **About / legal screen in Settings.** App version (from a constant bumped
   with `CACHE` in `docs/sw.js`), privacy policy, terms, licences, contact
   email.
5. **Monetisation** (see section 5). Play requires Google Play Billing for
   digital goods. In a TWA that means the **Digital Goods API + Payment
   Request**, which Bubblewrap supports with "Play Billing" enabled. Gate the
   Pro features behind an entitlement check kept in a pref and re-checked on
   launch.
6. **Nice-to-haves that sell.**
   - Progress charts per exercise from History data.
   - Estimated 1RM next to PBs.
   - kg/lb default by locale.
   - A bigger exercise library.
   - Rest timer sound or vibration. Background notifications need Capacitor,
     so keep it foreground-only for now.

## 5. Monetisation (needs your decision)

Options, simplest first:
- **Paid upfront (£2–5):** no billing code, but low downloads.
- **Free + one-time "Pro" unlock** (recommended to start): free logging,
  plans and history. Pro unlocks things like unlimited folders/blocks, the
  desktop builder export, progress charts, themes and plan sharing.
- **Coach / programme model:** coaches and gyms sell or share programmes
  through the existing plans file and link import, and you charge coaches.
  This fits the import/export and desktop builder you already have, but it
  probably needs accounts later.
- **Subscription:** best long-term revenue, but needs ongoing new value to
  justify it.

## 6. Suggested order

1. Domain + Cloudflare Pages; keep GitHub Pages redirecting.
2. Code: section 4 items 1, 3 and 4. Privacy policy and terms pages.
3. Play developer account; PWABuilder/Bubblewrap build; asset links.
4. Closed test with 12+ gym members for 14 days, and fix their feedback.
5. Decide monetisation; add Play Billing; production release.
6. Later: Capacitor for native features, then the Apple App Store.

## Verification

- **TWA:** test with the Bubblewrap build on a real Android phone. Check the
  app opens with no URL bar (which confirms asset links), the install gate
  never shows, data survives an app restart and an update, and a WhatsApp
  `#plans=` link opens in the app.
- **Asset links:** Google's statement list tester at
  `https://developers.google.com/digital-asset-links/tools/generator`.
- **Code changes:** add tests in `tests/` (e.g. the gate treats a TWA
  referrer as installed; the starter programme imports cleanly) and run
  `node --test`.
- **Store forms:** Play Console's pre-launch report, which tests on real
  devices automatically.
