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

/** Export all plans (Export plans › All plans) and read back the shared file. */
async function exportPlans(app) {
  app.context.el = { dataset: { folder: "" } };
  await app.run('actions["export-plans-go"](el)');
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

  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 2, updated: 0, skipped: 0 });

  // Phone A fills in more of the block and exports again.
  await addPlan(a, "Day 1", weeks["Week 2"]);
  await addPlan(a, "Day 3", weeks["Week 1"]);
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 2, updated: 0, skipped: 2 });
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
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, updated: 0, skipped: 4 });
});

test("Add new follows a renamed block, week and plan by uid, taking the plan's new name", async () => {
  const a = await phone();
  await addBlock(a, "Block 1", { "Week 1": ["Day 1"] });
  const b = await phone();
  await importPlans(b, await exportPlans(a), "add");

  await a.run(`(() => {
    dataCache.groups.forEach((g) => (g.name = g.parent_id == null ? "Strength" : "Wk 1"));
    dataCache.plans[0].name = "Heavy day";
    return writeLocalData(dataCache);
  })()`);
  // The plan's new name comes along (an update); blocks and weeks keep theirs.
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, updated: 1, skipped: 0 });
  assert.deepEqual(await layout(b), ["Block 1 / Week 1 / Heavy day"]);
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
  assert.deepEqual(await importPlans(b, old, "add"), { added: 3, updated: 0, skipped: 0 });
  assert.deepEqual(await importPlans(b, old, "add"), { added: 0, updated: 0, skipped: 3 });

  const bigger = oldPlansFile([
    ["Day 1", ["Block 1", "Week 1"]],
    ["Day 2", ["block 1", "week 1"]], // names match whatever the case
    ["Mobility", null],
  ]);
  assert.deepEqual(await importPlans(b, bigger, "add"), { added: 1, updated: 0, skipped: 2 });
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

  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, updated: 0, skipped: 1 });
  // B took A's uids, so the two now stay matched even through a rename.
  await a.run('dataCache.plans[0].name = "Heavy day"; writeLocalData(dataCache)');
  // The plan's new name comes along (an update); blocks and weeks keep theirs.
  assert.deepEqual(await importPlans(b, await exportPlans(a), "add"), { added: 0, updated: 1, skipped: 0 });
  assert.deepEqual(await layout(b), ["Block 1 / Week 1 / Heavy day"]);
});

test("Overwrite replaces every plan, block and week with the file's list", async () => {
  const a = await phone();
  await addBlock(a, "Block 1", { "Week 1": ["Day 1", "Day 2"] });
  const file = await exportPlans(a);

  const b = await phone();
  await addBlock(b, "Old block", { "Old week": ["Old plan"] });
  await addPlan(b, "Loose plan");
  const started = plain(await post(b, "/sessions", { plan_id: 1 }));

  assert.deepEqual(await importPlans(b, file, "replace"), { added: 2, updated: 0, skipped: 0 });
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
  assert.deepEqual(await importPlans(b, old, "replace"), { added: 2, updated: 0, skipped: 0 });
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
  assert.deepEqual(counts, { added: 1, updated: 0, skipped: 0 });
  assert.deepEqual(plain(await b.run("localData()")), before);
});

test("files without plans are refused", () => {
  const app = loadApp();
  app.context.bad = { hello: 1 };
  assert.throws(() => app.run("importPlans({}, bad)"), /no Raw Muscle plans/);
});

// ------------------------------------------------------------------ folders

const put = (app, path, body) =>
  app.run(`api(${JSON.stringify(path)}, { method: "PUT", body: ${JSON.stringify(body)} })`);

/** Press Export plans, pick a folder (or All plans) on the sheet, and read
 * back the shared file. */
async function exportFolder(app, folderId = null) {
  app.context.el = { dataset: { folder: folderId == null ? "" : String(folderId) } };
  await app.run('actions["export-plans-go"](el)');
  return JSON.parse(await app.shared.at(-1).text());
}

/** "Folder: Block / Week / Plan" for every plan, sorted. */
async function folderLayout(app) {
  const data = plain(await app.run("localData()"));
  const folderName = (id) => data.folders.find((f) => f.id === id)?.name;
  return data.plans
    .map((p) => {
      const week = data.groups.find((g) => g.id === p.group_id);
      const block = week && data.groups.find((g) => g.id === week.parent_id);
      const where = block ? `${block.name} / ${week.name} / ${p.name}` : p.name;
      const folder = folderName(block ? block.folder_id : p.folder_id);
      return folder ? `${folder}: ${where}` : where;
    })
    .sort();
}

/** Phone with a "Nationals Prep" folder (a block and a loose plan in it), and
 * a block and a plan outside any folder. */
async function phoneWithFolder() {
  const app = await phone();
  const folder = plain(await post(app, "/folders", { name: "Nationals Prep" }));
  const block = plain(await post(app, "/groups", { name: "Peak", folder_id: folder.id }));
  const week = plain(await post(app, "/groups", { name: "Week 1", parent_id: block.id }));
  await addPlan(app, "Heavy singles", week.id);
  await post(app, "/plans", { name: "Openers", folder_id: folder.id, items: [] });
  await addBlock(app, "Off season", { "Week 1": ["Volume"] });
  await addPlan(app, "Mobility");
  return { app, folder };
}

test("folders hold blocks and plans, and are optional", async () => {
  const { app } = await phoneWithFolder();
  assert.deepEqual(await folderLayout(app), [
    "Mobility",
    "Nationals Prep: Openers",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
    "Off season / Week 1 / Volume",
  ]);
  const data = plain(await app.run("localData()"));
  assert.match(data.folders[0].uid, /^[0-9a-f-]{36}$/);
  const week = data.groups.find((g) => g.parent_id != null);
  assert.equal(week.folder_id, undefined, "weeks go where their block goes");
});

test("a plan put in a week leaves its folder; moving a block moves its plans", async () => {
  const { app, folder } = await phoneWithFolder();
  const data = plain(await app.run("localData()"));
  const openers = data.plans.find((p) => p.name === "Openers");
  const offWeek = data.groups.find(
    (g) => g.parent_id === data.groups.find((b) => b.name === "Off season").id,
  );
  await put(app, `/plans/${openers.id}`, {
    name: "Openers",
    group_id: offWeek.id,
    folder_id: folder.id,
    items: [],
  });
  const offSeason = data.groups.find((b) => b.name === "Off season");
  await put(app, `/groups/${offSeason.id}`, { name: "Off season", folder_id: folder.id });
  assert.deepEqual(await folderLayout(app), [
    "Mobility",
    "Nationals Prep: Off season / Week 1 / Openers",
    "Nationals Prep: Off season / Week 1 / Volume",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
  ]);
  const after = plain(await app.run("localData()"));
  assert.equal(after.plans.find((p) => p.name === "Openers").folder_id, null);
});

test("deleting a folder keeps its blocks and plans; deleting a block keeps its plans in the folder", async () => {
  const { app, folder } = await phoneWithFolder();
  const data = plain(await app.run("localData()"));
  const peak = data.groups.find((g) => g.name === "Peak");
  await app.run(`api("/groups/${peak.id}", { method: "DELETE" })`);
  assert.ok(
    (await folderLayout(app)).includes("Nationals Prep: Heavy singles"),
    "a plan from a deleted block stays in the folder",
  );
  await app.run(`api("/folders/${folder.id}", { method: "DELETE" })`);
  assert.deepEqual(await folderLayout(app), [
    "Heavy singles",
    "Mobility",
    "Off season / Week 1 / Volume",
    "Openers",
  ]);
});

test("export can take just one folder", async () => {
  const { app, folder } = await phoneWithFolder();
  const file = await exportFolder(app, folder.id);
  assert.equal(file.folder.name, "Nationals Prep");
  assert.deepEqual(file.plans.map((p) => p.name).sort(), ["Heavy singles", "Openers"]);
  assert.ok(file.plans.every((p) => p.folder === "Nationals Prep" && p.folder_uid));
  assert.match(app.shared.at(-1).name, /^raw-muscle-plans-nationals-prep-\d{4}-\d\d-\d\d\.txt$/);

  const all = await exportFolder(app);
  assert.equal(all.folder, undefined);
  assert.equal(all.plans.length, 4);
  assert.equal(all.plans.find((p) => p.name === "Mobility").folder, null);
});

test("Export plans offers a file or a link for all plans and each folder", async () => {
  const { app } = await phoneWithFolder();
  await app.run('actions["export-plans"]()');
  assert.equal(app.shared.length + app.copied.length, 0, "nothing until a choice is tapped");
  app.context.el = { dataset: { folder: "" } };
  await app.run('actions["copy-plans-link"](el)');
  assert.match(app.copied[0], /^https:\/\/example\.test\/gym_planner\/#plans=[\w-]+$/);
});
test("importing a folder file recreates the folder, and repeats add nothing", async () => {
  const { app: a, folder } = await phoneWithFolder();
  const file = await exportFolder(a, folder.id);
  const b = await phone();
  await addPlan(b, "Mine");

  assert.deepEqual(await importPlans(b, file, "add"), { added: 2, updated: 0, skipped: 0 });
  assert.deepEqual(await importPlans(b, file, "add"), { added: 0, updated: 0, skipped: 2 });
  assert.deepEqual(await folderLayout(b), [
    "Mine",
    "Nationals Prep: Openers",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
  ]);

  // A rename on phone A still matches by uid.
  await put(a, `/folders/${folder.id}`, { name: "Nationals 2027" });
  assert.deepEqual(await importPlans(b, await exportFolder(a, folder.id), "add"), {
    added: 0,
    updated: 0,
    skipped: 2,
  });
  const data = plain(await b.run("localData()"));
  assert.equal(data.folders.length, 1, "no duplicate folder");
});

test("a file from before folders imports outside any folder", async () => {
  const { app: b } = await phoneWithFolder();
  const old = oldPlansFile([
    ["Openers", null], // same name as the folder's loose plan, but not in it
    ["Day 1", ["Peak", "Week 1"]], // a block named like the folder's, outside it
  ]);
  assert.deepEqual(await importPlans(b, old, "add"), { added: 2, updated: 0, skipped: 0 });
  const layout = await folderLayout(b);
  assert.ok(layout.includes("Openers"));
  assert.ok(layout.includes("Nationals Prep: Openers"));
  assert.ok(layout.includes("Peak / Week 1 / Day 1"));
});

test("Overwrite with a folder file replaces folders too", async () => {
  const { app: a, folder } = await phoneWithFolder();
  const file = await exportFolder(a, folder.id);
  const { app: b } = await phoneWithFolder();
  await post(b, "/folders", { name: "Other folder" });
  assert.deepEqual(await importPlans(b, file, "replace"), { added: 2, updated: 0, skipped: 0 });
  const data = plain(await b.run("localData()"));
  assert.deepEqual(data.folders.map((f) => f.name), ["Nationals Prep"]);
  assert.deepEqual(await folderLayout(b), [
    "Nationals Prep: Openers",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
  ]);
});

test("a plan can be moved into a week, a folder, or neither", async () => {
  const { app, folder } = await phoneWithFolder();
  const data = plain(await app.run("localData()"));
  const mobility = data.plans.find((p) => p.name === "Mobility");
  const peakWeek = data.groups.find(
    (g) => g.parent_id === data.groups.find((b) => b.name === "Peak").id,
  );
  const place = (body) => put(app, `/plans/${mobility.id}/place`, body);

  await place({ group_id: null, folder_id: folder.id });
  assert.ok((await folderLayout(app)).includes("Nationals Prep: Mobility"));
  await place({ group_id: peakWeek.id, folder_id: folder.id });
  assert.ok((await folderLayout(app)).includes("Nationals Prep: Peak / Week 1 / Mobility"));
  await place({ group_id: null, folder_id: null });
  assert.ok((await folderLayout(app)).includes("Mobility"));
  const after = plain(await app.run("localData()"));
  const moved = after.plans.find((p) => p.id === mobility.id);
  assert.deepEqual([moved.group_id, moved.folder_id], [null, null]);
  assert.equal(moved.items.length, 1, "its exercises are untouched");
});

test("plans and blocks keep the order they're dragged into", async () => {
  const app = await phone();
  for (const name of ["A", "B", "C"]) await addPlan(app, name);
  await addBlock(app, "Block 1", {});
  await addBlock(app, "Block 2", {});
  const names = async (path) => plain(await app.run(`api("${path}")`)).map((x) => x.name);
  assert.deepEqual(await names("/plans"), ["A", "B", "C"], "by name until dragged");

  const ids = plain(await app.run("localData()")).plans.map((p) => p.id); // A, B, C
  await put(app, "/plans/order", { ids: [ids[2], ids[0], ids[1]] });
  assert.deepEqual(await names("/plans"), ["C", "A", "B"]);
  await addPlan(app, "Aardvark");
  assert.deepEqual(await names("/plans"), ["C", "A", "B", "Aardvark"], "new plans go last");

  const blocks = plain(await app.run("localData()")).groups.map((g) => g.id);
  await put(app, "/groups/order", { ids: [blocks[1], blocks[0]] });
  assert.deepEqual(await names("/groups"), ["Block 2", "Block 1"]);

  // Moving a plan to another list drops its old position there.
  const folder = plain(await post(app, "/folders", { name: "F" }));
  await put(app, `/plans/${ids[2]}/place`, { group_id: null, folder_id: folder.id });
  const c = plain(await app.run("localData()")).plans.find((p) => p.id === ids[2]);
  assert.equal(c.position, undefined);
  // A block's position goes too when it changes folder.
  await put(app, `/groups/${blocks[0]}`, { name: "Block 1", folder_id: folder.id });
  const b1 = plain(await app.run("localData()")).groups.find((g) => g.id === blocks[0]);
  assert.equal(b1.position, undefined);
});

test("folders keep the order they're dragged into, and it survives a backup", async () => {
  const app = await phone();
  for (const name of ["F1", "F2", "F3"]) await post(app, "/folders", { name });
  const names = async () => plain(await app.run('api("/folders")')).map((f) => f.name);
  assert.deepEqual(await names(), ["F1", "F2", "F3"], "by name until dragged");

  const ids = plain(await app.run("localData()")).folders.map((f) => f.id);
  await put(app, "/folders/order", { ids: [ids[2], ids[0], ids[1]] });
  assert.deepEqual(await names(), ["F3", "F1", "F2"]);
  await post(app, "/folders", { name: "Aardvark" });
  assert.deepEqual(await names(), ["F3", "F1", "F2", "Aardvark"], "new folders go last");

  const backup = plain(await app.run("localData()"));
  const fresh = await phone();
  await fresh.run(`writeLocalData(backupToData(${JSON.stringify(backup)}))`);
  const freshNames = plain(await fresh.run('api("/folders")')).map((f) => f.name);
  assert.deepEqual(freshNames, ["F3", "F1", "F2", "Aardvark"]);
});

test("duplicating a folder copies its blocks, weeks and plans with new uids", async () => {
  const { app, folder } = await phoneWithFolder();
  const copy = plain(await post(app, `/folders/${folder.id}/copy`, { name: "Nationals 2027" }));
  assert.deepEqual(await folderLayout(app), [
    "Mobility",
    "Nationals 2027: Openers",
    "Nationals 2027: Peak / Week 1 / Heavy singles",
    "Nationals Prep: Openers",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
    "Off season / Week 1 / Volume",
  ]);
  const data = plain(await app.run("localData()"));
  const uids = [...data.plans, ...data.groups, ...data.folders].map((x) => x.uid);
  assert.equal(new Set(uids).size, uids.length, "every uid is unique");
  const ids = data.plans.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);

  // Editing the copy leaves the original alone.
  const copied = data.plans.find(
    (p) => p.name === "Heavy singles" && p.id !== data.plans.find((q) => q.name === "Heavy singles").id,
  );
  await app.run(`dataCache.plans.find((p) => p.id === ${copied.id}).items[0].target_reps = 1`);
  const original = plain(await app.run("localData()")).plans.find((p) => p.name === "Heavy singles");
  assert.equal(original.items[0].target_reps, 5);

  // A file of the original still adds nothing new when imported back; the copy is separate.
  const file = await exportFolder(app, folder.id);
  assert.deepEqual(await importPlans(app, file, "add"), { added: 0, updated: 0, skipped: 2 });
  const copyFile = await exportFolder(app, copy.id);
  assert.ok(copyFile.plans.every((p) => !file.plans.some((q) => q.uid === p.uid)));
});

/** A plans link for a phone's export, made as the desktop plan builder makes
 * it: the file deflated, base64url, after #plans=. */
async function shareLinkFor(app, folderId = null) {
  const file = await exportFolder(app, folderId);
  const packed = require("node:zlib").deflateRawSync(JSON.stringify(file)).toString("base64url");
  return `Raw Muscle plans\nhttps://example.test/gym_planner/#plans=${packed}`;
}

/** Open a plans link (or a message with one) on `app` and tap Add new plans. */
async function addFromLink(app, text) {
  app.context.pasted = text;
  await app.run("unpackPlans(packedFromText(pasted)).then((p) => offerPlansImport(p, 'link'))");
  await app.run('actions["import-plans-add"]()');
}

test("Copy link and a desktop-made link both bring plans into another phone", async () => {
  const { app, folder } = await phoneWithFolder();
  await app.run("localData()");
  app.context.el = { dataset: { folder: String(folder.id) } };
  await app.run('actions["copy-plans-link"](el)');
  const friend = await phone();
  await addFromLink(friend, `Here you go: ${app.copied.at(-1)}`);
  assert.deepEqual(await folderLayout(friend), [
    "Nationals Prep: Openers",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
  ]);
});

test("plans travel as a link: a folder, its blocks and weeks, into another phone", async () => {
  const { app, folder } = await phoneWithFolder();
  const message = await shareLinkFor(app, folder.id);

  const friend = await phone();
  await addFromLink(friend, message);
  assert.deepEqual(await folderLayout(friend), [
    "Nationals Prep: Openers",
    "Nationals Prep: Peak / Week 1 / Heavy singles",
  ]);
  // The same link again adds nothing: the uids came along.
  await addFromLink(friend, message);
  assert.equal(plain(await friend.run("localData()")).plans.length, 2);
});

test("a broken or cut short link says so", async () => {
  const app = await phone();
  const message = await shareLinkFor((await phoneWithFolder()).app);
  app.context.cut = message.slice(0, -40);
  await assert.rejects(app.run("unpackPlans(packedFromText(cut))"), /broken or cut short/);
  assert.equal(await app.run('packedFromText("no link here")'), null);
});

test("plans from a link opened before installing wait for the app", async () => {
  const { app } = await phoneWithFolder();
  const message = await shareLinkFor(app);
  const friend = await phone();
  friend.context.message = message;
  await friend.run('savePref("pending-plans", packedFromText(message))');
  await friend.run("offerPendingPlans()");
  await friend.run('actions["import-plans-add"]()');
  assert.equal(plain(await friend.run("localData()")).plans.length, 4);
  assert.equal(await friend.run('loadPref("pending-plans", null)'), null, "offered once");
});

test("a plan carries the date its last workout was finished", async () => {
  const app = await phone();
  await addBlock(app, "Peak", { "Week 1": ["Heavy"] });
  const plan = plain(await app.run('api("/plans")'))[0];
  const completedAt = async () => plain(await app.run('api("/plans")'))[0].completed_at;
  const session = plain(await post(app, "/sessions", { plan_id: plan.id }));
  assert.equal(await completedAt(), null, "in progress isn't completed");
  await post(app, `/sessions/${session.id}/finish`, { notes: "" });
  assert.match(await completedAt(), /^\d{4}-\d{2}-\d{2}/);
});

test("Add new updates a plan that changed and skips one that didn't", async () => {
  const a = await phone();
  await addBlock(a, "Peak", { "Week 1": ["Heavy", "Light"] });
  const b = await phone();
  await importPlans(b, await exportPlans(a), "add");
  // b has done a workout from Heavy: the update must keep that history.
  const heavyOnB = plain(await b.run("localData()")).plans.find((p) => p.name === "Heavy");
  await post(b, "/sessions", { plan_id: heavyOnB.id });

  const file = await exportPlans(a);
  const heavy = file.plans.find((p) => p.name === "Heavy");
  heavy.notes = "Top single, then back-offs";
  heavy.items[0].target_reps = 1;
  heavy.items.push({
    exercise: { name: "Pause Squat", muscle_group: "legs", equipment: "barbell" },
    target_sets: 3, target_reps: 3, target_rpe: 7, rest_seconds: 180,
  });
  assert.deepEqual(await importPlans(b, file, "add"), { added: 0, updated: 1, skipped: 1 });

  const data = plain(await b.run("localData()"));
  const updated = data.plans.find((p) => p.name === "Heavy");
  assert.equal(updated.id, heavyOnB.id, "the same plan, updated in place");
  assert.equal(updated.notes, "Top single, then back-offs");
  assert.deepEqual(updated.items.map((it) => it.target_reps), [1, 3]);
  assert.equal(data.plans.length, 2);
  assert.equal(data.sessions.filter((s) => s.plan_id === heavyOnB.id).length, 1);

  // Sending the same file again changes nothing.
  assert.deepEqual(await importPlans(b, file, "add"), { added: 0, updated: 0, skipped: 2 });
});
