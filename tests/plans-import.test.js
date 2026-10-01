/* Plans export and import through the real docs/app.js: "Add new plans" adds
 * only what the phone doesn't have, matched by uid (or by week and name for
 * files from before uids), and "Overwrite all plans" swaps in the file's list. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./load-app");

const plain = (value) => JSON.parse(JSON.stringify(value));

/** A phone with seed data. */
async function phone() {
  const app = loadApp();
  await app.run("localData()");
  return app;
}

const post = (app, path, body) =>
  app.run(`api(${JSON.stringify(path)}, { method: "POST", body: ${JSON.stringify(body)} })`);

/** A block with weeks, each holding the named plans. Returns the week ids. */
async function addBlock(app, block, weeks) {
  const b = plain(await post(app, "/groups", { name: block }));
  const ids = {};
  for (const [week, plans] of Object.entries(weeks)) {
    const w = plain(await post(app, "/groups", { name: week, parent_id: b.id }));
    ids[week] = w.id;
    for (const name of plans) await addPlan(app, name, w.id);
  }
  return ids;
}

const addPlan = (app, name, groupId = null) =>
  post(app, "/plans", {
    name,
    group_id: groupId,
    items: [{ exercise_id: 1, target_sets: 3, target_reps: 5, target_rpe: null, rest_seconds: 120 }],
  });

/** Press Export plans and read back the shared file. */
async function exportPlans(app) {
  await app.run('actions["export-plans"]()');
  return JSON.parse(await app.shared.at(-1).text());
}

async function importPlans(app, file, mode) {
  app.context.file = file;
  const result = plain(app.run(`importPlans(dataCache, file, ${JSON.stringify(mode)})`));
  await app.run("writeLocalData(dataCache)");
  return result;
}

/** "Block / Week / Plan" for every plan, sorted, to compare phones. */
async function layout(app) {
  const data = plain(await app.run("localData()"));
  const name = (id) => data.groups.find((g) => g.id === id)?.name;
  return data.plans
    .map((p) => {
      const week = data.groups.find((g) => g.id === p.group_id);
      return week ? `${name(week.parent_id)} / ${week.name} / ${p.name}` : p.name;
    })
    .sort();
}

test("new plans and groups get a uid, and export carries them", async () => {
  const app = await phone();
  await addBlock(app, "Block 1", { "Week 1": ["Day 1"] });
  const file = await exportPlans(app);
  const [plan] = file.plans;
  assert.match(plan.uid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(plan.group, ["Block 1", "Week 1"]);
  assert.equal(plan.group_uids.length, 2);
  assert.ok(plan.group_uids.every((uid) => /^[0-9a-f-]{36}$/.test(uid)));
});

test("plans made before uids get one on export, kept on the phone", async () => {
  const app = await phone();
  await addPlan(app, "Legs");
  await app.run("delete dataCache.plans[0].uid; writeLocalData(dataCache)");
  const first = await exportPlans(app);
  assert.ok(first.plans[0].uid);
  app.reload();
  const second = await exportPlans(app);
  assert.equal(second.plans[0].uid, first.plans[0].uid, "same uid every export");
});

test("Add new imports only the plans the phone doesn't have", async () => {
  const a = await phone();
  const weeks = await addBlock(a, "Block 1", { "Week 1": ["Day 1", "Day 2"], "Week 2": [] });
  await addBlock(a, "Block 2", {});
  const b = await phone();
  await addPlan(b, "My own plan");

  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 2, skipped: 0 });

  // Phone A fills in more of the block and exports again.
  await addPlan(a, "Day 1", weeks["Week 2"]);
  await addPlan(a, "Day 3", weeks["Week 1"]);
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 2, skipped: 2 });
  assert.deepEqual(await layout(b), [
    "Block 1 / Week 1 / Day 1",
    "Block 1 / Week 1 / Day 2",
    "Block 1 / Week 1 / Day 3",
    "Block 1 / Week 2 / Day 1",
    "My own plan",
  ]);
  const data = plain(await b.run("localData()"));
  assert.equal(data.groups.filter((g) => g.parent_id == null).length, 1, "no duplicate block");
  assert.equal(data.groups.filter((g) => g.parent_id != null).length, 2, "no duplicate weeks");

  // Importing the same file again changes nothing.
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, skipped: 4 });
});

test("Add new follows a renamed block, week and plan by uid", async () => {
  const a = await phone();
  await addBlock(a, "Block 1", { "Week 1": ["Day 1"] });
  const b = await phone();
  await importPlans(b, await exportPlans(a), "add");

  await a.run(`(() => {
    dataCache.groups.forEach((g) => (g.name = g.parent_id == null ? "Strength" : "Wk 1"));
    dataCache.plans[0].name = "Heavy day";
    return writeLocalData(dataCache);
  })()`);
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, skipped: 1 });
  assert.deepEqual(await layout(b), ["Block 1 / Week 1 / Day 1"]);
});

/** A plans file as exported before uids existed. */
function oldPlansFile(plans) {
  return {
    kind: "gym-planner-plans",
    version: 1,
    exported_at: "2026-09-20T10:00:00.000Z",
    plans: plans.map(([name, group]) => ({
      name,
      notes: "",
      group,
      items: [
        {
          exercise: { name: "Back Squat", muscle_group: "legs", equipment: "barbell" },
          target_sets: 5,
          target_reps: 5,
          target_rpe: 8,
          rest_seconds: 180,
        },
      ],
    })),
  };
}

test("an older file without uids is matched by week and name", async () => {
  const b = await phone();
  const old = oldPlansFile([
    ["Day 1", ["Block 1", "Week 1"]],
    ["Day 1", ["Block 1", "Week 2"]],
    ["Mobility", null],
  ]);
  assert.deepEqual(await importPlans(b, old, "add"), { added: 3, skipped: 0 });
  assert.deepEqual(await importPlans(b, old, "add"), { added: 0, skipped: 3 });

  const bigger = oldPlansFile([
    ["Day 1", ["Block 1", "Week 1"]],
    ["Day 2", ["block 1", "week 1"]], // names match whatever the case
    ["Mobility", null],
  ]);
  assert.deepEqual(await importPlans(b, bigger, "add"), { added: 1, skipped: 2 });
  assert.deepEqual(await layout(b), [
    "Block 1 / Week 1 / Day 1",
    "Block 1 / Week 1 / Day 2",
    "Block 1 / Week 2 / Day 1",
    "Mobility",
  ]);
  const data = plain(await b.run("localData()"));
  assert.ok(data.plans.every((p) => p.uid), "imported plans get uids");
  assert.ok(data.groups.every((g) => g.uid), "created groups get uids");
});

test("a file with uids matches plans that came from an older file", async () => {
  // Phone B took phone A's plans from a file made before uids, so its copies
  // got uids of their own. A's next export (with uids) must not duplicate them.
  const a = await phone();
  await addBlock(a, "Block 1", { "Week 1": ["Day 1"] });
  const b = await phone();
  const old = await exportPlans(a);
  old.plans.forEach((p) => {
    delete p.uid;
    delete p.group_uids;
  });
  await importPlans(b, old, "add");

  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, skipped: 1 });
  // B took A's uids, so the two now stay matched even through a rename.
  await a.run('dataCache.plans[0].name = "Heavy day"; writeLocalData(dataCache)');
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, skipped: 1 });
  assert.deepEqual(await layout(b), ["Block 1 / Week 1 / Day 1"]);
});

test("Overwrite replaces every plan, block and week with the file's list", async () => {
  const a = await phone();
  await addBlock(a, "Block 1", { "Week 1": ["Day 1", "Day 2"] });
  const file = await exportPlans(a);

  const b = await phone();
  await addBlock(b, "Old block", { "Old week": ["Old plan"] });
  await addPlan(b, "Loose plan");
  const started = plain(await post(b, "/sessions", { plan_id: 1 }));

  assert.deepEqual(await importPlans(b, file, "replace"), { added: 2, skipped: 0 });
  assert.deepEqual(await layout(b), ["Block 1 / Week 1 / Day 1", "Block 1 / Week 1 / Day 2"]);
  const data = plain(await b.run("localData()"));
  assert.deepEqual(data.groups.map((g) => g.name).sort(), ["Block 1", "Week 1"]);
  assert.deepEqual(
    data.plans.map((p) => p.uid).sort(),
    file.plans.map((p) => p.uid).sort(),
    "the file's uids are kept",
  );
  assert.ok(data.plans.every((p) => p.id > 2), "new plans never reuse an old id");
  assert.equal(data.sessions.length, 1, "logged workouts are kept");
  assert.equal(data.sessions[0].id, started.id);
});

test("Overwrite takes an older file without uids too", async () => {
  const b = await phone();
  await addPlan(b, "Day 1");
  const old = oldPlansFile([["Day 1", null], ["Day 2", null]]);
  assert.deepEqual(await importPlans(b, old, "replace"), { added: 2, skipped: 0 });
  assert.deepEqual(await layout(b), ["Day 1", "Day 2"]);
});

test("the import sheet's dry run leaves the phone alone", async () => {
  const a = await phone();
  await addBlock(a, "Block 1", { "Week 1": ["Day 1"] });
  const b = await phone();
  await addPlan(b, "Mine");
  const before = plain(await b.run("localData()"));
  b.context.file = await exportPlans(a);
  const counts = plain(b.run("importPlans(structuredClone(dataCache), file)"));
  assert.deepEqual(counts, { added: 1, skipped: 0 });
  assert.deepEqual(plain(await b.run("localData()")), before);
});

test("files without plans are refused", () => {
  const app = loadApp();
  app.context.bad = { hello: 1 };
  assert.throws(() => app.run("importPlans({}, bad)"), /no Gym Planner plans/);
});
