# AGENTS.md

## Project overview

A phone-first gym tracker built as an offline PWA. There is no server: static
files in docs/ are hosted on GitHub Pages, and all data lives in the phone
browser's IndexedDB. Anyone can install it from the link; each person's data
stays on their own phone, with no accounts.

## Quick start

- Local test: python -m http.server 8000 -d docs, then open http://localhost:8000
- Tests: node --test (Node 20+, no dependencies; tests/ loads docs/app.js in a fake browser)
- Deploy: push to main; GitHub Pages serves docs/ at https://simonraw1.github.io/gym_planner/

## Architecture

- docs/index.html: single-page UI shell
- docs/vendor/sweetalert2/: SweetAlert2 (MIT), kept locally for the dialogs
- docs/exercises.js: SEED_EXERCISES, the starter exercise list, shared by both pages
- docs/app.js: client state, rendering, and the IndexedDB data layer (the `api()` function emulates the old REST routes locally)
- docs/app.css: phone-first styling
- docs/sw.js: service worker that caches the shell for offline use
- docs/desktop/: the desktop plan builder (served at /gym_planner/desktop/). Writes
  plans with a keyboard and exports the phone's plans file or link; keeps its
  work in localStorage and never touches the app's IndexedDB data
- docs/manifest.webmanifest, docs/icons/: PWA install metadata
- tests/: backup round-trip and migration tests for the data layer
- tools/make_icons.py: regenerates the icons from tools/logo.png (needs Pillow)

## Conventions

- Keep the app dependency-free and fully offline. No CDNs, no network calls.
  The one library is SweetAlert2 (dialogs), saved in docs/vendor/sweetalert2/
  and cached by sw.js; use ask() in app.js rather than confirm()/prompt().
- Use relative URLs everywhere; the site is served under /gym_planner/.
- Bump CACHE in docs/sw.js whenever a shell file changes.
- Data is one JSON object in IndexedDB (version, nextIds, exercises, plans, sessions, last_export). Keep changes backward compatible with existing backups, or bump version and migrate in both localData() and backupToData(). Add a sample of the old shape to tests/backup.test.js when you do.
- Backup is manual: Export shares a JSON file (for Google Drive), Import replaces all data.
- Export plans shares a .txt plans file, or copies a plans link (as does the
  desktop builder's Copy link): the plans export, deflate-compressed and
  base64url-encoded after `#plans=`, so it never reaches the server. Keep that
  format readable by unpackPlans() when the export shape changes.
- A plans file lists its plans and, under `structure`, its folders, blocks and
  weeks (so empty ones travel too). Both are optional on import, so files
  from before `structure` still work; keep it that way.
- Weights are stored in kg. The kg/lb setting (localStorage pref `unit`) only
  changes display and entry: show weights with fmtWeight() and unitLabel(), and
  convert typed weights with toKg().
- Keep the UI mobile-first; don't assume a desktop browser.
- Do not add accounts, a backend, or cloud sync unless the user explicitly asks.
