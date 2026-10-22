/* Week dates and the followed folder: the routes that set them, where Select
 * plan goes, and that dates travel in plans files and backups while copies
 * and the followed mark don't. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./load-app");

const plain = (value) => JSON.parse(JSON.stringify(value));

async function phone() {
  const app = loadApp();
  await app.run("localData()");
  return app;
}

const call = (app, method, path, body) =>
  app.run(`api(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, body: ${JSON.stringify(body ?? {})} })`).then(plain);

/** A folder with blocks of weeks: { "Block 1": 2, "Block 2": 2 } makes Week 1..n
 * in each. Returns { folder, weeks } with weeks in order. */
async function program(app, name, blocks) {
  const folder = await call(app, "POST", "/folders", { name });
  const weeks = [];
  for (const [block, count] of Object.entries(blocks)) {
    const b = await call(app, "POST", "/groups", { name: block, folder_id: folder.id });
    for (let n = 1; n <= count; n++)
      weeks.push(await call(app, "POST", "/groups", { name: `Week ${n}`, parent_id: b.id }));
  }
  return { folder, weeks };
}

const groups = (app) => app.run("localData()").then((d) => plain(d.groups));
const dates = async (app, ids) => {
  const all = await groups(app);
  return ids.map((id) => {
    const w = all.find((g) => g.id === id);
    return w.starts ? `${w.starts}..${w.ends}` : null;
  });
};

test("a week takes dates, and fill dates the weeks after it in folder order", async () => {
  const app = await phone();
  const { weeks } = await program(app, "Prep", { "Block 1": 2, "Block 2": 2 });
  const [w1, w2, w3, w4] = weeks.map((w) => w.id);

  await call(app, "PUT", `/groups/${w2}/dates`, { starts: "2026-10-12", ends: "2026-10-18", fill: true });
  assert.deepEqual(await dates(app, [w1, w2, w3, w4]), [
    null, // before it: untouched
    "2026-10-12..2026-10-18",
    "2026-10-19..2026-10-25", // into the next block
    "2026-10-26..2026-11-01", // across a month end and the clock change
  ]);

  // Without fill only that week changes; clearing takes both dates off.
  await call(app, "PUT", `/groups/${w1}/dates`, { starts: "2026-10-05", ends: "2026-10-11" });
  await call(app, "PUT", `/groups/${w3}/dates`, { starts: null, ends: null });
  assert.deepEqual(await dates(app, [w1, w2, w3, w4]), [
    "2026-10-05..2026-10-11",
    "2026-10-12..2026-10-18",
    null,
    "2026-10-26..2026-11-01",
  ]);
});

test("week dates are checked", async () => {
  const app = await phone();
  const { weeks } = await program(app, "Prep", { "Block 1": 1 });
  const put = (body) => call(app, "PUT", `/groups/${weeks[0].id}/dates`, body);
  await assert.rejects(put({ starts: "2026-10-12" }), /start and an end/);
  await assert.rejects(put({ starts: "2026-02-30", ends: "2026-03-05" }), /start and an end/);
  await assert.rejects(put({ starts: "2026-10-12", ends: "2026-10-11" }), /ends before it starts/);
  const block = (await groups(app)).find((g) => g.parent_id == null);
  await assert.rejects(call(app, "PUT", `/groups/${block.id}/dates`, { starts: "2026-10-12", ends: "2026-10-18" }), /Only weeks/);
});

test("the current week is the one whose dates hold today", async () => {
  const app = await phone();
  const is = (week, today) => app.run(`isCurrentWeek(${JSON.stringify(week)}, ${JSON.stringify(today)})`);
  const week = { starts: "2026-10-19", ends: "2026-10-25" };
  assert.equal(is(week, "2026-10-18"), false);
  assert.equal(is(week, "2026-10-19"), true);
  assert.equal(is(week, "2026-10-25"), true);
  assert.equal(is(week, "2026-10-26"), false);
  assert.equal(is({}, "2026-10-20"), false);
});

test("one folder is followed at a time", async () => {
  const app = await phone();
  const a = await program(app, "Simon", { "Block 1": 1 });
  const b = await program(app, "Rob", { "Block 1": 1 });
  await call(app, "PUT", `/folders/${a.folder.id}/follow`, { follow: true });
  await call(app, "PUT", `/folders/${b.folder.id}/follow`, { follow: true });
  let folders = await call(app, "GET", "/folders");
  assert.deepEqual(folders.filter((f) => f.following).map((f) => f.name), ["Rob"]);
  await call(app, "PUT", `/folders/${b.folder.id}/follow`, { follow: false });
  folders = await call(app, "GET", "/folders");
  assert.equal(folders.filter((f) => f.following).length, 0);
});

test("Select plan goes to the followed folder's week for today, skipping done weeks", async () => {
  const app = await phone();
  const { folder, weeks } = await program(app, "Prep", { "Block 1": 2, "Block 2": 2 });
  const spot = async (today) => {
    const [folders, groups] = [await call(app, "GET", "/folders"), await call(app, "GET", "/groups")];
    const s = plain(app.run(`followedSpot(${JSON.stringify(folders)}, ${JSON.stringify(groups)}, ${JSON.stringify(today)})`));
    return s && (s.week ? `${s.block.name} / ${s.week.name}` : s.folder.name);
  };
  assert.equal(await spot("2026-10-20"), null, "nothing followed");

  await call(app, "PUT", `/folders/${folder.id}/follow`, { follow: true });
  assert.equal(await spot("2026-10-20"), "Block 1 / Week 1", "no dates: the first week not done");
  await call(app, "PUT", `/groups/${weeks[0].id}/done`, { done: true });
  assert.equal(await spot("2026-10-20"), "Block 1 / Week 2");

  await call(app, "PUT", `/groups/${weeks[0].id}/dates`, { starts: "2026-10-05", ends: "2026-10-11", fill: true });
  assert.equal(await spot("2026-10-20"), "Block 2 / Week 1", "dated for today");
  await call(app, "PUT", `/groups/${weeks[2].id}/done`, { done: true });
  assert.equal(await spot("2026-10-20"), "Block 2 / Week 2", "today's week finished early: the next");
  assert.equal(await spot("2026-09-01"), "Block 1 / Week 2", "before it starts: the first not done");
});

test("copies of a week, block or folder have no dates and aren't followed", async () => {
  const app = await phone();
  const { folder, weeks } = await program(app, "Prep", { "Block 1": 2 });
  await call(app, "PUT", `/groups/${weeks[0].id}/dates`, { starts: "2026-10-05", ends: "2026-10-11", fill: true });
  await call(app, "PUT", `/folders/${folder.id}/follow`, { follow: true });
  await call(app, "POST", `/folders/${folder.id}/copy`, { name: "Prep 2" });
  const block = (await groups(app)).find((g) => g.parent_id == null);
  await call(app, "POST", `/groups/${weeks[0].id}/copy`, { name: "Week 1 again", parent_id: block.id });

  const data = plain(await app.run("localData()"));
  const copy = data.folders.find((f) => f.name === "Prep 2");
  assert.ok(!copy.following);
  const dated = data.groups.filter((g) => g.starts);
  assert.deepEqual(dated.map((g) => g.id).sort(), weeks.map((w) => w.id).sort(), "only the originals are dated");
});

test("week dates travel in plans files; a file without them keeps the phone's", async () => {
  const a = await phone();
  const { folder, weeks } = await program(a, "Prep", { "Block 1": 2 });
  await call(a, "PUT", `/groups/${weeks[0].id}/dates`, { starts: "2026-10-05", ends: "2026-10-11", fill: true });
  await call(a, "PUT", `/folders/${folder.id}/follow`, { follow: true });
  const file = plain(a.run("plansToExport(dataCache, '')"));
  assert.deepEqual(
    file.structure.weeks.map((w) => [w.name, w.starts, w.ends]),
    [["Week 1", "2026-10-05", "2026-10-11"], ["Week 2", "2026-10-12", "2026-10-18"]],
  );
  assert.ok(!("following" in file.structure.folders[0]), "following stays on the phone");

  // A new phone takes the dates.
  const b = await phone();
  b.context.file = file;
  b.run('importPlans(dataCache, file, "add")');
  assert.deepEqual(
    (await groups(b)).filter((g) => g.parent_id != null).map((g) => [g.starts, g.ends]),
    [["2026-10-05", "2026-10-11"], ["2026-10-12", "2026-10-18"]],
  );

  // New dates in a later file move them; an undated file leaves them be.
  const moved = structuredClone(file);
  moved.structure.weeks[1].starts = "2026-10-13";
  moved.structure.weeks[1].ends = "2026-10-19";
  b.context.file = moved;
  b.run('importPlans(dataCache, file, "add")');
  const undated = structuredClone(file);
  undated.structure.weeks.forEach((w) => {
    delete w.starts;
    delete w.ends;
  });
  b.context.file = undated;
  b.run('importPlans(dataCache, file, "add")');
  assert.deepEqual(
    (await groups(b)).filter((g) => g.parent_id != null).map((g) => g.starts),
    ["2026-10-05", "2026-10-13"],
  );
});

test("week dates and the followed folder survive a backup", async () => {
  const app = await phone();
  const { folder, weeks } = await program(app, "Prep", { "Block 1": 1 });
  await call(app, "PUT", `/groups/${weeks[0].id}/dates`, { starts: "2026-10-05", ends: "2026-10-11" });
  await call(app, "PUT", `/folders/${folder.id}/follow`, { follow: true });
  const restored = plain(app.run("backupToData(JSON.parse(JSON.stringify(dataCache)))"));
  const week = restored.groups.find((g) => g.id === weeks[0].id);
  assert.deepEqual([week.starts, week.ends], ["2026-10-05", "2026-10-11"]);
  assert.equal(restored.folders.find((f) => f.id === folder.id).following, true);
});
