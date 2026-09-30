# gym_planner

A gym app for your phone. It installs to the home screen, works with no
connection, and keeps everything on the phone.

Build plans, start a workout, log sets with your thumb, see what you lifted last
time.

## Get the app

Anyone can use it. Open this link on your phone:

<https://simonraw1.github.io/gym_planner/>

The Train page shows an **Install the app** card:

- **Android (Chrome):** tap **Install**. The app then shows up on the home screen and in the app drawer.
- **iPhone:** tap **How to install** for the steps: **Share** &rarr; **Add to
  Home Screen** &rarr; **Add**. Please do install it on iPhone. Safari may clear
  the storage of a site that isn't on the home screen and hasn't been opened for
  a week, which would erase your workouts.

If you closed the card, use the browser menu instead (&#8942; &rarr; **Install
app** in Chrome, **Share** &rarr; **Add to Home Screen** in Safari). After that
the app opens full screen and runs without any connection.

There are no accounts and nothing is sent anywhere. Your workouts are stored
only on your phone, so each person's data is separate.

## Backing up to Google Drive

Workouts are stored only in the phone's browser storage (IndexedDB). If the app
is uninstalled or the browser data cleared, they are gone, so back up now and
then from the **History** tab:

- **Export data** opens the share sheet with a backup file (JSON saved as .txt). Pick **Drive**
  (Android) or **Save to Files &rarr; Google Drive** (iPhone).
- **Import data** opens the file picker. Choose the backup from Google Drive.
  Importing replaces everything currently on the phone.

## Using it

- **Train** — start from a plan or go freestyle. Each exercise shows its target,
  what you managed last time, and a log box (weight, reps, RPE, and a **Warm up**
  tick box; warm-up sets show as W and don't count toward the target). Logging a set
  starts the rest timer in the header. An unfinished session is kept, so you can
  lock the phone or close the app and pick up where you were. The phone's back
  button leaves the workout without ending it, returning to the tab you started
  it from; **Continue session** on the Train tab takes you back in. On Plans or
  History, back returns to the Train start page rather than closing the app. Only one
  session runs at a time. While a session is running the screen stays on (where
  the browser supports it; battery saver can prevent it).
- **Reorder or remove exercises** — press the &#8942;&#8942; grip on an exercise
  (in a workout or the plan editor) and drag. Drop it where you want it, or onto
  the trash bin that appears at the bottom to delete it. Removing an exercise
  from a workout also removes the sets logged for it, after asking.
- **Plans** — a plan is a named, ordered list of exercises with target sets,
  reps, RPE and rest. Editing a plan never touches workouts already logged.
  Group plans with **+ New block** (e.g. Block 1), then **+ Week** inside it;
  put a plan in a week with **+ Plan** there or the Week picker in the plan
  editor. Deleting a block or week keeps its plans under Other plans.
  **Export plans** shares just your plans as a file; **Import plans** adds the
  plans from such a file to your list (nothing is replaced; missing exercises
  are created).
- **History** — past sessions with set count and total volume; tap one to see
  every set. Pick an exercise in the filter to see every time you did it, newest
  first; tick **Hide warm-up sets** to see working sets only.
- **Settings** (bottom of History) — **Weight unit** switches between kg and
  lb. Weights are always stored in kg, so a backup restores correctly whichever
  unit either phone uses.

## Layout

```
docs/index.html          the single page (all three tabs)
docs/app.js              state, IndexedDB data layer, rendering, backup import/export
docs/app.css             phone-first styling
docs/sw.js               service worker (caches the app for offline use)
docs/manifest.webmanifest
docs/icons/              PWA icons
tools/make_icons.py      regenerates the icons from tools/logo.png (needs Pillow)
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
