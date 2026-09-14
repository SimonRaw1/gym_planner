# gym_planner

A gym app for your phone. It installs to the home screen, works with no
connection, and keeps everything on the phone.

Build plans, start a workout, log sets with your thumb, see what you lifted last
time.

## Installing on the phone

The app is a static site served by GitHub Pages from the [docs/](docs/) folder:

<https://simonraw1.github.io/gym_planner/>

Open that link once on the phone while online, then:

- **iPhone (Safari):** Share &rarr; **Add to Home Screen**
- **Android (Chrome):** &#8942; menu &rarr; **Install app** / **Add to Home screen**

After that it opens full-screen and runs without any connection.

## Backing up to Google Drive

Workouts are stored only in the phone's browser storage (IndexedDB). If the app
is uninstalled or the browser data cleared, they are gone, so back up now and
then from the **History** tab:

- **Export data** opens the share sheet with a JSON backup file. Pick **Drive**
  (Android) or **Save to Files &rarr; Google Drive** (iPhone).
- **Import data** opens the file picker. Choose the backup from Google Drive.
  Importing replaces everything currently on the phone.

The History tab shows when you last exported.

## Using it

- **Train** — start from a plan or go freestyle. Each exercise shows its target,
  what you managed last time, and a log box (weight, reps, RPE). Logging a set
  starts the rest timer in the header. An unfinished session is kept, so you can
  lock the phone or close the app and pick up where you were.
- **Plans** — a plan is a named, ordered list of exercises with target sets,
  reps, weight and rest. Editing a plan never touches workouts already logged.
- **History** — past sessions with set count and total volume; tap one to see
  every set.

Weights are in kg throughout. To switch to lb, change the `kg` labels in
[docs/app.js](docs/app.js).

## Layout

```
docs/index.html          the single page (all three tabs)
docs/app.js              state, IndexedDB data layer, rendering, backup import/export
docs/app.css             phone-first styling
docs/sw.js               service worker (caches the app for offline use)
docs/manifest.webmanifest
docs/icons/              PWA icons
tools/make_icons.py      regenerates the icons
```

## Changing it

Test on the PC (localhost counts as secure, so offline mode works here too):

```powershell
python -m http.server 8000 -d docs
```

then open <http://localhost:8000>.

When you change any file in `docs/`, bump `CACHE` in [docs/sw.js](docs/sw.js)
and push. The phone picks up the new version the next time the app is opened
online, and uses it from the launch after that.
