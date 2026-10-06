/* The Train page's stats: Recent PBs and the heaviest sets. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./load-app");

const plain = (value) => JSON.parse(JSON.stringify(value));
const ts = (daysAgo, minute = 0) =>
  new Date(Date.now() - daysAgo * 86400000 + minute * 60000).toISOString().slice(0, 19).replace("T", " ");

/** A phone with workouts: each is [days ago, [[exercise, kg, reps, warmup?], ...]]. */
async function phoneWith(workouts) {
  const app = loadApp();
  const data = plain(await app.run("localData()"));
  const id = (name) => data.exercises.find((e) => e.name === name).id;
  let setId = 1;
  data.sessions = workouts.map(([daysAgo, sets], i) => ({
    id: i + 1,
    plan_id: null,
    name: `Workout ${i + 1}`,
    started_at: ts(daysAgo),
    finished_at: ts(daysAgo, 60),
    notes: "",
    items: [],
    sets: sets.map(([name, weight, reps, warmup = false], n) => ({
      id: setId++,
      exercise_id: id(name),
      set_index: n + 1,
      reps,
      weight,
      rpe: null,
      warmup,
      logged_at: ts(daysAgo, n),
    })),
  }));
  data.nextIds.session = workouts.length + 1;
  data.nextIds.set = setId;
  app.context.edited = data;
  await app.run("writeLocalData(edited)");
  return app;
}

const pbs = async (app) =>
  plain(await app.run('api("/stats")')).recent_pbs.map((pb) => `${pb.name} ${pb.weight}x${pb.reps}`);

test("a PB beats every earlier set of that exercise; the first time isn't one", async () => {
  const app = await phoneWith([
    [20, [["Back Squat", 100, 5], ["Bicep Curl", 15, 10]]],
    [2, [["Back Squat", 90, 5], ["Back Squat", 105, 3], ["Lateral Raise", 10, 12]]],
    [1, [["Back Squat", 120, 1, true], ["Bicep Curl", 15, 12]]], // a warm-up, and only equal
  ]);
  assert.deepEqual(await pbs(app), ["Back Squat 105x3"]);
});

test("PBs older than a week drop off", async () => {
  const app = await phoneWith([
    [30, [["Deadlift", 140, 5]]],
    [8, [["Deadlift", 150, 5]]],
  ]);
  assert.deepEqual(await pbs(app), []);
});

test("newest PBs first, and the latest per exercise counts", async () => {
  const app = await phoneWith([
    [20, [["Bicep Curl", 10, 10], ["Lateral Raise", 8, 10], ["Face Pull", 20, 10], ["Leg Curl", 40, 10]]],
    [5, [["Bicep Curl", 12, 10], ["Lateral Raise", 9, 10]]],
    [3, [["Face Pull", 25, 10], ["Bicep Curl", 14, 8]]],
    [1, [["Leg Curl", 45, 10]]],
  ]);
  assert.deepEqual(await pbs(app), ["Leg Curl 45x10", "Bicep Curl 14x8", "Face Pull 25x10", "Lateral Raise 9x10"]);
});

test("in a session's PBs, Squat, Bench and Deadlift come first", async () => {
  const app = await phoneWith([
    [20, [["Bicep Curl", 10, 10], ["Lateral Raise", 8, 10], ["Back Squat", 100, 5], ["Face Pull", 20, 10]]],
    [1, [["Bicep Curl", 12, 10], ["Lateral Raise", 9, 10], ["Face Pull", 25, 10], ["Back Squat", 110, 5]]],
  ]);
  const shown = await pbs(app);
  assert.equal(shown.length, 4);
  assert.equal(shown[0], "Back Squat 110x5");
});

test("Heaviest Lifts lists every exercise, heaviest first", async () => {
  const app = await phoneWith([
    [2, [["Deadlift", 180, 3], ["Back Squat", 150, 3], ["Bench Press", 110, 3], ["Overhead Press", 70, 3]]],
  ]);
  const best = plain(await app.run('api("/stats")')).personal_bests;
  assert.deepEqual(best.map((b) => b.name), ["Deadlift", "Back Squat", "Bench Press", "Overhead Press"]);
});
