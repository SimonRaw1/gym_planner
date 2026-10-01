/* Backup round trips through the real docs/app.js: export, import with
 * backupToData(), reload with localData(), and the migrations older backups
 * rely on. Run with `node --test tests/`. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./load-app");

/** Objects from the app's vm realm, as plain objects from this one. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A backup as the current app exports it. */
function currentBackup() {
  return {
    version: 1,
    nextIds: { exercise: 4, plan: 3, session: 3, set: 6, group: 3, folder: 2 },
    exercises: [
      { id: 1, name: "Back Squat", muscle_group: "legs", equipment: "barbell", notes: "" },
      { id: 2, name: "Bench Press", muscle_group: "chest", equipment: "barbell", notes: "" },
      { id: 3, name: "Cossack Squat", muscle_group: "legs", equipment: "bodyweight", notes: "slow" },
    ],
    plans: [
      {
        id: 1,
        name: "Day 1",
        notes: "",
        group_id: 2,
        created_at: "2026-09-01 08:00:00",
        items: [
          { exercise_id: 1, target_sets: 3, target_reps: 5, target_rpe: 8, rest_seconds: 180 },
          { exercise_id: 2, target_sets: 3, target_reps: 8, target_rpe: null, rest_seconds: 120 },
        ],
      },
      { id: 2, name: "Mobility", notes: "", group_id: null, folder_id: 1, created_at: "2026-09-02 08:00:00", items: [] },
    ],
    groups: [
      { id: 1, name: "Strength block", parent_id: null, folder_id: 1 },
      { id: 2, name: "Week 1", parent_id: 1 },
    ],
    folders: [{ id: 1, uid: "f-nationals", name: "Nationals Prep" }],
    sessions: [
      {
        id: 1,
        plan_id: 1,
        name: "Day 1",
        started_at: "2026-09-03 07:00:00",
        finished_at: "2026-09-03 08:00:00",
        notes: "felt good",
        items: [
          { exercise_id: 1, target_sets: 3, target_reps: 5, target_rpe: 8, rest_seconds: 180 },
          { exercise_id: 2, target_sets: 3, target_reps: 8, target_rpe: null, rest_seconds: 120 },
        ],
        sets: [
          { id: 1, exercise_id: 1, weight: 60, reps: 5, rpe: null, warmup: true, logged_at: "2026-09-03 07:05:00" },
          { id: 2, exercise_id: 1, weight: 100, reps: 5, rpe: 8, warmup: false, logged_at: "2026-09-03 07:10:00" },
          { id: 5, exercise_id: 2, weight: 72.5, reps: 8, rpe: 9, warmup: false, logged_at: "2026-09-03 07:30:00" },
        ],
      },
      {
        id: 2,
        plan_id: null,
        name: "New session",
        started_at: "2026-09-05 07:00:00",
        finished_at: null,
        notes: "",
        items: [{ exercise_id: 3, target_sets: 0, target_reps: 0, target_rpe: null, rest_seconds: 90 }],
        sets: [],
      },
    ],
    last_export: "2026-08-30 10:00:00",
    exported_at: "2026-09-06T09:15:42.123Z",
  };
}

/** A backup from after blocks and weeks but before folders. */
function beforeFoldersBackup() {
  const backup = currentBackup();
  delete backup.folders;
  delete backup.nextIds.folder;
  delete backup.plans[1].folder_id;
  delete backup.groups[0].folder_id;
  return backup;
}

/** A version 1 backup from before plan groups, nextIds in backups, session
 * exercise lists, and with lists left off where they were empty. */
function oldBackup() {
  return {
    version: 1,
    exercises: [
      { id: 1, name: "Back Squat", muscle_group: "legs", equipment: "barbell", notes: "" },
      { id: 7, name: "Deadlift", muscle_group: "back", equipment: "barbell", notes: "" },
    ],
    plans: [
      {
        id: 4,
        name: "Legs",
        notes: "",
        created_at: "2025-01-01 08:00:00",
        items: [{ exercise_id: 1, target_sets: 5, target_reps: 5, rest_seconds: 180 }],
      },
      { id: 9, name: "Empty", notes: "", created_at: "2025-01-02 08:00:00" },
    ],
    sessions: [
      {
        id: 3,
        plan_id: 4,
        name: "Legs",
        started_at: "2025-01-03 07:00:00",
        finished_at: "2025-01-03 08:00:00",
        notes: "",
        sets: [
          { id: 10, exercise_id: 1, weight: 90, reps: 5, rpe: null, logged_at: "2025-01-03 07:10:00" },
          { id: 11, exercise_id: 7, weight: 140, reps: 3, rpe: null, logged_at: "2025-01-03 07:40:00" },
        ],
      },
      {
        id: 5,
        plan_id: null,
        name: "Abandoned",
        started_at: "2025-01-04 07:00:00",
        finished_at: "2025-01-04 07:01:00",
        notes: "",
      },
    ],
  };
}

/** Import the backup the way the Import button does, then reload the app. */
async function restore(app, backup) {
  const json = JSON.stringify(backup);
  app.context.importJson = json;
  await app.run("writeLocalData(backupToData(JSON.parse(importJson)))");
  app.reload();
  return plain(await app.run("localData()"));
}

/** Press Export and read back the shared file. */
async function exportBackup(app) {
  const before = app.shared.length;
  await app.run('actions["export-data"]()');
  assert.equal(app.shared.length, before + 1, "export shared one file");
  return JSON.parse(await app.shared.at(-1).text());
}

test("a current backup survives import and reload unchanged", async () => {
  const app = loadApp();
  await app.run("localData()"); // a phone that already has seed data
  const backup = currentBackup();
  const data = await restore(app, backup);

  const { exported_at, last_export, ...rest } = backup;
  assert.deepEqual(data, { ...rest, last_export: "2026-09-06 09:15:42" });
  assert.equal(app.stored.size, 1, "everything lives in one record");
});

test("export then import is a round trip, and stable when repeated", async () => {
  const app = loadApp();
  const first = await restore(app, currentBackup());

  const exported = await exportBackup(app);
  assert.match(exported.exported_at, /^\d{4}-\d\d-\d\dT/);
  const { exported_at, ...exportedData } = exported;
  assert.deepEqual(exportedData, first, "the export is the data on the phone");

  const phone2 = loadApp();
  const second = await restore(phone2, exported);
  const { last_export: a, ...firstData } = first;
  const { last_export: b, ...secondData } = second;
  assert.deepEqual(secondData, firstData);
  assert.equal(b, exported_at.slice(0, 19).replace("T", " "));

  const third = await restore(loadApp(), await exportBackup(phone2));
  delete third.last_export;
  assert.deepEqual(third, secondData);
});

test("exporting records the time on the phone", async () => {
  const app = loadApp();
  await restore(app, currentBackup());
  await exportBackup(app);
  app.reload();
  const data = await app.run("localData()");
  assert.match(data.last_export, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.notEqual(data.last_export, "2026-09-06 09:15:42");
});

test("an old backup is migrated on import", async () => {
  const app = loadApp();
  const data = await restore(app, oldBackup());

  assert.deepEqual(data.groups, []);
  assert.deepEqual(data.folders, []);
  assert.deepEqual(data.nextIds, { exercise: 8, plan: 10, group: 1, folder: 1, session: 6, set: 12 });
  assert.deepEqual(data.plans[1].items, [], "a plan with no items gets an empty list");
  assert.deepEqual(data.sessions[1].sets, [], "a session with no sets gets an empty list");
  assert.equal(data.last_export, null, "no export time without exported_at");
  assert.equal(data.sessions[0].items, undefined, "session lists are filled in lazily");
});

test("an old backup works in the app after import", async () => {
  const app = loadApp();
  await restore(app, oldBackup());

  // Sessions from before their own exercise list fall back to their plan, then their sets.
  const session = plain(await app.run('api("/sessions/3")'));
  assert.deepEqual(
    session.items.map((item) => item.exercise_id),
    [1, 7],
  );
  assert.equal(session.items[0].target_sets, 5);

  const plans = plain(await app.run('api("/plans")'));
  assert.deepEqual(plans.map((p) => p.name), ["Empty", "Legs"]);

  // New records take fresh ids, never one already in the backup.
  const group = plain(
    await app.run('api("/groups", { method: "POST", body: { name: "Block" } })'),
  );
  assert.equal(group.id, 1);
  const exercise = plain(
    await app.run('api("/exercises", { method: "POST", body: { name: "Lunge" } })'),
  );
  assert.equal(exercise.id, 8);
  const started = plain(
    await app.run('api("/sessions", { method: "POST", body: { plan_id: 4 } })'),
  );
  assert.equal(started.id, 6);
  const logged = plain(
    await app.run(
      `api("/sessions/6/sets", { method: "POST", body: { exercise_id: 1, weight: 100, reps: 5 } })`,
    ),
  );
  assert.equal(logged.sets[0].id, 12);
});

test("stale nextIds in a backup are ignored", async () => {
  const backup = currentBackup();
  backup.nextIds = { exercise: 1, plan: 1, session: 1, set: 1, group: 1, folder: 1 };
  const data = await restore(loadApp(), backup);
  assert.deepEqual(data.nextIds, { exercise: 4, plan: 3, group: 3, folder: 2, session: 3, set: 6 });
});

test("a backup from before folders imports with nothing in a folder", async () => {
  const app = loadApp();
  const data = await restore(app, beforeFoldersBackup());
  assert.deepEqual(data.folders, []);
  assert.equal(data.nextIds.folder, 1);
  assert.deepEqual(
    data.plans.map((p) => p.name),
    ["Day 1", "Mobility"],
    "every plan is kept",
  );
  assert.deepEqual(data.groups.map((g) => g.name), ["Strength block", "Week 1"]);

  // Folders work straight away on the migrated data.
  const folder = plain(
    await app.run('api("/folders", { method: "POST", body: { name: "Meet prep" } })'),
  );
  assert.equal(folder.id, 1);
  await app.run('api("/groups/1", { method: "PUT", body: { name: "Strength block", folder_id: 1 } })');
  const after = plain(await app.run("localData()"));
  assert.equal(after.groups[0].folder_id, 1);
  assert.equal(after.plans[0].group_id, 2, "Day 1 stays in its week");
});

test("files that are not backups are refused", () => {
  const app = loadApp();
  const refuse = (value) => {
    app.context.candidate = value;
    assert.throws(() => app.run("backupToData(candidate)"), /not a Gym Planner backup/);
  };
  refuse(null);
  refuse({});
  refuse({ ...currentBackup(), version: 2 });
  refuse({ ...currentBackup(), sessions: undefined });
  refuse({ kind: "gym-planner-plans", version: 1, plans: [] });
});

test("Settings says how long ago the last backup was", () => {
  const app = loadApp();
  app.context.now = new Date(2026, 9, 20, 12, 0); // local time, like the phone
  const line = (lastExport) => {
    app.context.lastExport = lastExport;
    return plain(app.run("lastBackupLine(lastExport, now)"));
  };
  const utc = (y, m, d, h) =>
    new Date(y, m, d, h).toISOString().slice(0, 19).replace("T", " ");

  assert.deepEqual(line(null), { text: "Never backed up", stale: true });
  assert.deepEqual(line(utc(2026, 9, 20, 7)), { text: "Last backup today", stale: false });
  assert.deepEqual(line(utc(2026, 9, 19, 23)), { text: "Last backup yesterday", stale: false });
  assert.deepEqual(line(utc(2026, 9, 6, 9)), { text: "Last backup 14 days ago", stale: false });
  assert.deepEqual(line(utc(2026, 9, 5, 9)), { text: "Last backup 15 days ago", stale: true });
});
