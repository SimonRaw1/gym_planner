/* Raw Muscle Gym Tracker front end.
 *
 * Deliberately dependency-free: one state object, a render per view, and click
 * delegation off the document. Small enough to read in one sitting, which is the
 * point for a personal app.
 */

const state = {
  view: "train",
  exercises: [],
  plans: [],
  folders: [], // optional top level: a folder holds blocks and plans
  groups: [], // blocks (parent_id null) and the weeks inside them
  openGroups: new Set(loadPref("open-groups", [])), // plan cards dropped down ("p<id>")
  building: false, // Plans tab in build mode (vs. just viewing and starting)
  session: null,
  // Exercises marked Done in the running session, and which of those are
  // expanded again: { session, done: [exercise ids], open: [exercise ids] }.
  finished: loadPref("finished-exercises", null),
  inSession: false, // the session screen is showing (vs. just running)
  history: [],
  historyExercise: null, // exercise id the History list is filtered to
  hideWarmups: loadPref("hide-warmups", false), // in that filtered list
  unit: loadPref("unit", "kg"), // how weights are shown and typed; stored in kg
  draft: null, // plan being edited in the sheet
  pendingPlans: null, // parsed plans file waiting for Add new / Overwrite
  rest: null, // { until: epochMs, timer: intervalId }
};

/* Small display preferences live in localStorage, apart from the workout
 * data; losing them is harmless. */
function loadPref(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the preference just won't stick.
  }
}

/* Colour themes, from DaisyUI's palettes plus Raw Muscle (the logo's red,
 * black and white, and the default) and Spicy (the app's original look); the
 * CSS for each lives in app.css under [data-theme]. */
const THEMES = [
  ["rawmuscle", "Raw Muscle"],
  ["spicy", "Spicy"],
  ["dark", "Dark"],
  ["night", "Night"],
  ["dracula", "Dracula"],
  ["synthwave", "Synthwave"],
  ["forest", "Forest"],
  ["coffee", "Coffee"],
  ["sunset", "Sunset"],
  ["light", "Light"],
  ["cupcake", "Cupcake"],
  ["emerald", "Emerald"],
  ["nord", "Nord"],
];

function applyTheme(name) {
  const theme = THEMES.some(([id]) => id === name) ? name : "rawmuscle";
  document.documentElement.dataset.theme = theme;
  // Match the phone's status bar to the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.content =
      theme === "spicy"
        ? "#12151c"
        : getComputedStyle(document.documentElement)
            .getPropertyValue("--bg")
            .trim();
  return theme;
}

/* The original look was saved as "default" before it was renamed Spicy and
 * Raw Muscle became the default; keep those phones on the colours they chose. */
if (loadPref("theme", null) === "default") savePref("theme", "spicy");
applyTheme(loadPref("theme", "rawmuscle"));

function saveOpenGroups() {
  savePref("open-groups", [...state.openGroups]);
}

/** The Done marks for the running session; another session starts clean. */
function finishedExercises() {
  const session = state.session?.id ?? null;
  if (state.finished?.session !== session)
    state.finished = { session, done: [], open: [] };
  return state.finished;
}

/** Change the Done marks for one exercise, then save and redraw. */
function markExercise(id, change) {
  const f = finishedExercises();
  change(f, Number(id));
  savePref("finished-exercises", f);
  renderActiveSession();
}

const without = (ids, id) => ids.filter((x) => x !== id);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/** Ask before something that can't be undone, in a SweetAlert2 dialog
 * (docs/vendor/sweetalert2) dressed in the app's colours. `yes` labels the
 * confirm button; resolves true when it's tapped. */
async function ask(text, yes = "Delete") {
  const { isConfirmed } = await Swal.fire({
    text,
    showCancelButton: true,
    confirmButtonText: yes,
    cancelButtonText: "Cancel",
    reverseButtons: true,
    focusCancel: true,
    buttonsStyling: false,
    customClass: {
      popup: "swal-app",
      confirmButton: "btn danger",
      cancelButton: "btn ghost",
    },
  });
  return isConfirmed;
}

// --------------------------------------------------------------- utilities

// SEED_EXERCISES, the starter exercise list, is in exercises.js (shared with
// the desktop plan builder).

const LOCAL_DB = "gym-planner-local";
const LOCAL_STORE = "state";
let localDbPromise;
let dataCache = null; // the one copy of the data; IndexedDB is written after every change

function nowTs() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function openLocalDb() {
  if (localDbPromise) return localDbPromise;
  localDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(LOCAL_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return localDbPromise;
}

async function readLocalData() {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(LOCAL_STORE)
      .objectStore(LOCAL_STORE)
      .get("data");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeLocalData(data) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(LOCAL_STORE, "readwrite")
      .objectStore(LOCAL_STORE)
      .put(data, "data");
    request.onsuccess = () => {
      dataCache = data;
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

async function localData() {
  if (dataCache) return dataCache;
  let data = await readLocalData();
  if (data) return (dataCache = data);
  data = {
    version: 1,
    nextIds: { exercise: 1, plan: 1, session: 1, set: 1 },
    exercises: SEED_EXERCISES.map(([name, muscle_group, equipment]) => ({
      id: 0,
      name,
      muscle_group,
      equipment,
      notes: "",
    })),
    plans: [],
    sessions: [],
  };
  data.exercises.forEach((exercise) => {
    exercise.id = data.nextIds.exercise++;
  });
  await writeLocalData(data);
  return data;
}

function bodyOf(options) {
  return typeof options.body === "string"
    ? JSON.parse(options.body)
    : options.body || {};
}

const ITEM_FIELDS = [
  "exercise_id",
  "target_sets",
  "target_reps",
  "target_rpe",
  "rest_seconds",
];
const plainItem = (item) =>
  Object.fromEntries(ITEM_FIELDS.map((key) => [key, item[key]]));
const blankItem = (exerciseId) => ({
  exercise_id: exerciseId,
  target_sets: 0,
  target_reps: 0,
  target_rpe: null,
  rest_seconds: 90,
});

/** A session's exercise list, in order. Sessions store their own list; ones
 * logged before that existed fall back to their plan, then their sets. */
function sessionItems(data, session) {
  const plan = data.plans.find((item) => item.id === session.plan_id);
  const items = session.items
    ? session.items.map(plainItem)
    : plan
      ? plan.items.map(plainItem)
      : [];
  const listed = new Set(items.map((item) => item.exercise_id));
  session.sets.forEach((set) => {
    if (!listed.has(set.exercise_id)) {
      listed.add(set.exercise_id);
      items.push(blankItem(set.exercise_id));
    }
  });
  return items;
}

function findSession(data, id) {
  const session = data.sessions.find((item) => item.id === Number(id));
  if (!session) throw new Error("Session not found");
  return session;
}

function sessionDetail(data, id) {
  const session = findSession(data, id);
  const items = sessionItems(data, session).map((item) => ({
    ...item,
    ...data.exercises.find((e) => e.id === item.exercise_id),
  }));
  const previous = {};
  items.forEach((item) => {
    const previousSet = data.sessions
      .filter(
        (other) =>
          other.id !== id &&
          other.sets.some((set) => set.exercise_id === item.exercise_id),
      )
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0]
      ?.sets.filter((set) => set.exercise_id === item.exercise_id)
      .sort((a, b) => b.weight - a.weight)[0];
    if (previousSet) {
      const previousSession = data.sessions.find((other) =>
        other.sets.includes(previousSet),
      );
      previous[item.exercise_id] = {
        ...previousSet,
        started_at: previousSession.started_at,
      };
    }
  });
  const sets = session.sets.map((set) => ({
    ...set,
    name:
      data.exercises.find((e) => e.id === set.exercise_id)?.name ||
      "Unknown exercise",
  }));
  return { ...session, sets, items, previous };
}

const maxId = (items) =>
  items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);

/** Plan groups and folders arrived after version 1 data, so older data has
 * none. Everything without a folder_id simply sits outside any folder. */
function ensureGroups(data) {
  if (!Array.isArray(data.groups)) data.groups = [];
  if (!data.nextIds.group) data.nextIds.group = maxId(data.groups) + 1;
  if (!Array.isArray(data.folders)) data.folders = [];
  if (!data.nextIds.folder) data.nextIds.folder = maxId(data.folders) + 1;
}

/** Natural order, so "Week 10" comes after "Week 9". */
const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });

/** The order set by dragging, then natural order for anything never dragged
 * (older data, and new items, which go last). */
const byOrder = (a, b) =>
  (a.position ?? Infinity) - (b.position ?? Infinity) || byName(a, b);

/** A dragged order for one list of siblings: each id's index becomes its
 * position. Ids that don't exist are skipped. */
function setOrder(items, ids) {
  ids.forEach((id, i) => {
    const item = items.find((it) => it.id === Number(id));
    if (item) item.position = i;
  });
}

/** Moved somewhere else: its old position means nothing there, so it goes
 * last until it's dragged into place. */
const spotOf = (it) => `${it.group_id ?? ""}/${it.folder_id ?? ""}`;
function leftItsList(item, before) {
  if (spotOf(item) !== before) delete item.position;
}

/** Plans live in a week (a group with a parent block) or in no group. */
function weekId(data, id) {
  const week = data.groups.find((g) => g.id === Number(id));
  return week && week.parent_id != null ? week.id : null;
}

/** A folder id that exists, else null (no folder). */
function folderId(data, id) {
  if (id == null || id === "") return null;
  return data.folders.find((f) => f.id === Number(id))?.id ?? null;
}

function findFolder(data, id) {
  const folder = data.folders.find((f) => f.id === Number(id));
  if (!folder) throw new Error("Folder not found");
  return folder;
}

/** The folder a plan is in: its block's folder when it's in a week, else its
 * own folder_id. */
function planFolderId(data, plan) {
  const week = data.groups.find(
    (g) => g.id === plan.group_id && g.parent_id != null,
  );
  if (week) {
    const block = data.groups.find((g) => g.id === week.parent_id);
    return block?.folder_id ?? null;
  }
  return plan.folder_id ?? null;
}

function findGroup(data, id) {
  const group = data.groups.find((g) => g.id === Number(id));
  if (!group) throw new Error("Group not found");
  return group;
}

function planSummary(data, plan) {
  const last = data.sessions
    .filter((session) => session.plan_id === plan.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const finished = data.sessions
    .filter((session) => session.plan_id === plan.id && session.finished_at)
    .sort((a, b) => b.finished_at.localeCompare(a.finished_at))[0];
  return {
    ...plan,
    exercise_count: plan.items.length,
    last_done: last?.started_at || null,
    completed_at: finished?.finished_at || null,
  };
}

async function api(path, options = {}) {
  const data = await localData();
  const method = options.method || "GET";
  const body = bodyOf(options);
  const match = (pattern) => path.match(pattern);
  let result = null;
  ensureGroups(data);

  if (path === "/exercises" && method === "GET")
    result = [...data.exercises].sort(
      (a, b) =>
        a.muscle_group.localeCompare(b.muscle_group) ||
        a.name.localeCompare(b.name),
    );
  else if (path === "/exercises" && method === "POST") {
    if (
      data.exercises.some(
        (item) => item.name.toLowerCase() === body.name.trim().toLowerCase(),
      )
    )
      throw new Error("That exercise already exists");
    const exercise = {
      id: data.nextIds.exercise++,
      name: body.name.trim(),
      muscle_group: body.muscle_group || "other",
      equipment: body.equipment || "",
      notes: body.notes || "",
    };
    data.exercises.push(exercise);
    result = exercise;
  } else if (path === "/plans" && method === "GET")
    result = data.plans
      .map((plan) => planSummary(data, plan))
      .sort(byOrder);
  else if (path === "/plans" && method === "POST") {
    const plan = {
      id: data.nextIds.plan++,
      uid: newUid(),
      name: body.name.trim(),
      notes: body.notes || "",
      group_id: weekId(data, body.group_id),
      folder_id: null,
      created_at: nowTs(),
      items: body.items || [],
    };
    // A plan in a week is in its block's folder; only loose plans keep one.
    if (plan.group_id == null) plan.folder_id = folderId(data, body.folder_id);
    data.plans.push(plan);
    result = plan;
  } else if (match(/^\/plans\/(\d+)$/) && method === "GET") {
    const plan = data.plans.find(
      (item) => item.id === Number(match(/^\/plans\/(\d+)$/)[1]),
    );
    if (!plan) throw new Error("Plan not found");
    result = {
      ...plan,
      items: plan.items.map((item) => ({
        ...item,
        ...data.exercises.find((e) => e.id === item.exercise_id),
      })),
    };
  } else if (match(/^\/plans\/(\d+)$/) && method === "PUT") {
    const plan = data.plans.find(
      (item) => item.id === Number(match(/^\/plans\/(\d+)$/)[1]),
    );
    if (!plan) throw new Error("Plan not found");
    const before = spotOf(plan);
    Object.assign(plan, {
      name: body.name.trim(),
      notes: body.notes || "",
      group_id: weekId(data, body.group_id),
      items: body.items || [],
    });
    plan.folder_id =
      plan.group_id == null ? folderId(data, body.folder_id) : null;
    leftItsList(plan, before);
    result = plan;
  } else if (match(/^\/plans\/(\d+)\/place$/) && method === "PUT") {
    // Move a plan into a week, a folder (outside weeks), or neither.
    const plan = data.plans.find(
      (item) => item.id === Number(match(/^\/plans\/(\d+)\/place$/)[1]),
    );
    if (!plan) throw new Error("Plan not found");
    const before = spotOf(plan);
    plan.group_id = weekId(data, body.group_id);
    plan.folder_id =
      plan.group_id == null ? folderId(data, body.folder_id) : null;
    leftItsList(plan, before);
    result = plan;
  } else if (path === "/plans/order" && method === "PUT") {
    setOrder(data.plans, body.ids || []);
    result = null;
  } else if (path === "/groups/order" && method === "PUT") {
    setOrder(data.groups, body.ids || []);
    result = null;
  } else if (match(/^\/plans\/(\d+)$/) && method === "DELETE") {
    const id = Number(match(/^\/plans\/(\d+)$/)[1]);
    data.plans = data.plans.filter((plan) => plan.id !== id);
    result = null;
  } else if (path === "/groups" && method === "GET")
    result = [...data.groups].sort(byOrder);
  else if (path === "/groups" && method === "POST") {
    const parent =
      body.parent_id == null ? null : findGroup(data, body.parent_id);
    if (parent && parent.parent_id != null)
      throw new Error("Weeks can only go inside a block");
    const group = {
      id: data.nextIds.group++,
      uid: newUid(),
      name: body.name.trim(),
      parent_id: parent ? parent.id : null,
    };
    // Blocks can sit in a folder; weeks go wherever their block is.
    if (!parent) group.folder_id = folderId(data, body.folder_id);
    data.groups.push(group);
    result = group;
  } else if (match(/^\/groups\/(\d+)$/) && method === "PUT") {
    const group = findGroup(data, match(/^\/groups\/(\d+)$/)[1]);
    group.name = body.name.trim();
    if (group.parent_id == null && "folder_id" in body) {
      const before = group.folder_id ?? null;
      group.folder_id = folderId(data, body.folder_id);
      if (group.folder_id !== before) delete group.position;
    }
    result = group;
  } else if (match(/^\/groups\/(\d+)$/) && method === "DELETE") {
    // A block takes its weeks with it; their plans move to "Other plans".
    const id = Number(match(/^\/groups\/(\d+)$/)[1]);
    const gone = new Set(
      data.groups
        .filter((g) => g.id === id || g.parent_id === id)
        .map((g) => g.id),
    );
    // Out of the week, but still in the folder its block was in.
    data.plans.forEach((plan) => {
      if (!gone.has(plan.group_id)) return;
      plan.folder_id = planFolderId(data, plan);
      plan.group_id = null;
    });
    data.groups = data.groups.filter((g) => !gone.has(g.id));
  } else if (path === "/folders" && method === "GET")
    result = [...data.folders].sort(byOrder);
  else if (path === "/folders/order" && method === "PUT") {
    setOrder(data.folders, body.ids || []);
    result = null;
  }
  else if (path === "/folders" && method === "POST") {
    const folder = {
      id: data.nextIds.folder++,
      uid: newUid(),
      name: body.name.trim(),
    };
    data.folders.push(folder);
    result = folder;
  } else if (match(/^\/folders\/(\d+)$/) && method === "PUT") {
    const folder = findFolder(data, match(/^\/folders\/(\d+)$/)[1]);
    folder.name = body.name.trim();
    result = folder;
  } else if (match(/^\/folders\/(\d+)\/copy$/) && method === "POST") {
    // A full copy under a new name: blocks, weeks and plans, each with a new
    // uid so a plans import never mistakes the copy for the original.
    const from = findFolder(data, match(/^\/folders\/(\d+)\/copy$/)[1]);
    const folder = {
      id: data.nextIds.folder++,
      uid: newUid(),
      name: body.name?.trim() || `${from.name} (copy)`,
    };
    data.folders.push(folder);
    const copyPlan = (plan, place) =>
      data.plans.push({
        ...structuredClone(plan),
        id: data.nextIds.plan++,
        uid: newUid(),
        created_at: nowTs(),
        ...place,
      });
    const blocks = data.groups.filter(
      (g) => g.parent_id == null && g.folder_id === from.id,
    );
    blocks.forEach((block) => {
      const blockCopy = {
        ...block,
        id: data.nextIds.group++,
        uid: newUid(),
        folder_id: folder.id,
      };
      data.groups.push(blockCopy);
      data.groups
        .filter((g) => g.parent_id === block.id)
        .forEach((week) => {
          const weekCopy = {
            ...week,
            id: data.nextIds.group++,
            uid: newUid(),
            parent_id: blockCopy.id,
          };
          data.groups.push(weekCopy);
          data.plans
            .filter((p) => p.group_id === week.id)
            .forEach((plan) => copyPlan(plan, { group_id: weekCopy.id, folder_id: null }));
        });
    });
    data.plans
      .filter((p) => p.group_id == null && p.folder_id === from.id)
      .forEach((plan) => copyPlan(plan, { group_id: null, folder_id: folder.id }));
    result = folder;
  } else if (match(/^\/folders\/(\d+)$/) && method === "DELETE") {
    // Only the folder goes; its blocks and plans move out of it.
    const id = Number(match(/^\/folders\/(\d+)$/)[1]);
    data.folders = data.folders.filter((f) => f.id !== id);
    [...data.groups, ...data.plans].forEach((item) => {
      if (item.folder_id === id) item.folder_id = null;
    });
  } else if (path === "/sessions/active" && method === "GET") {
    const session = data.sessions
      .filter((item) => !item.finished_at)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    result = session ? sessionDetail(data, session.id) : null;
  } else if (path === "/sessions" && method === "POST") {
    const plan = data.plans.find((item) => item.id === body.plan_id);
    const session = {
      id: data.nextIds.session++,
      plan_id: body.plan_id || null,
      name: body.name?.trim() || plan?.name || "New session",
      started_at: nowTs(),
      finished_at: null,
      notes: "",
      items: (plan?.items || []).map(plainItem),
      sets: [],
    };
    data.sessions.push(session);
    result = sessionDetail(data, session.id);
  } else if (match(/^\/sessions\/(\d+)$/) && method === "GET")
    result = sessionDetail(data, Number(match(/^\/sessions\/(\d+)$/)[1]));
  else if (match(/^\/sessions\/(\d+)\/items$/) && method === "POST") {
    const session = findSession(data, match(/^\/sessions\/(\d+)\/items$/)[1]);
    session.items = sessionItems(data, session);
    if (!session.items.some((item) => item.exercise_id === body.exercise_id))
      session.items.push(blankItem(body.exercise_id));
    result = sessionDetail(data, session.id);
  } else if (match(/^\/sessions\/(\d+)\/items$/) && method === "PUT") {
    const session = findSession(data, match(/^\/sessions\/(\d+)\/items$/)[1]);
    const items = sessionItems(data, session);
    const rank = new Map(
      body.exercise_ids.map((exerciseId, i) => [exerciseId, i]),
    );
    session.items = items.sort(
      (a, b) =>
        (rank.get(a.exercise_id) ?? Infinity) -
        (rank.get(b.exercise_id) ?? Infinity),
    );
    result = sessionDetail(data, session.id);
  } else if (
    match(/^\/sessions\/(\d+)\/items\/(\d+)$/) &&
    method === "DELETE"
  ) {
    const [, sessionId, exerciseId] = match(
      /^\/sessions\/(\d+)\/items\/(\d+)$/,
    ).map(Number);
    const session = findSession(data, sessionId);
    session.items = sessionItems(data, session).filter(
      (item) => item.exercise_id !== exerciseId,
    );
    session.sets = session.sets.filter((set) => set.exercise_id !== exerciseId);
    result = sessionDetail(data, session.id);
  } else if (match(/^\/sessions\/(\d+)\/sets$/) && method === "POST") {
    const session = data.sessions.find(
      (item) => item.id === Number(match(/^\/sessions\/(\d+)\/sets$/)[1]),
    );
    if (!session) throw new Error("Session not found");
    session.sets.push({ id: data.nextIds.set++, ...body, logged_at: nowTs() });
    result = sessionDetail(data, session.id);
  } else if (match(/^\/sets\/(\d+)$/) && method === "DELETE") {
    const id = Number(match(/^\/sets\/(\d+)$/)[1]);
    data.sessions.forEach((session) => {
      session.sets = session.sets.filter((set) => set.id !== id);
    });
  } else if (match(/^\/sessions\/(\d+)\/finish$/) && method === "POST") {
    const session = data.sessions.find(
      (item) => item.id === Number(match(/^\/sessions\/(\d+)\/finish$/)[1]),
    );
    if (!session) throw new Error("Session not found");
    session.finished_at = nowTs();
    session.notes = body.notes || "";
    result = sessionDetail(data, session.id);
  } else if (match(/^\/sessions\/(\d+)$/) && method === "DELETE") {
    const id = Number(match(/^\/sessions\/(\d+)$/)[1]);
    data.sessions = data.sessions.filter((session) => session.id !== id);
  } else if (path === "/history" && method === "GET") {
    result = [...data.sessions]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .map((session) => ({
        ...session,
        set_count: session.sets.length,
        exercise_count: new Set(session.sets.map((set) => set.exercise_id))
          .size,
        volume: session.sets.reduce(
          (sum, set) => sum + set.reps * set.weight,
          0,
        ),
      }));
  } else if (path === "/stats" && method === "GET") {
    const cutoff = Date.now() - 7 * 86400000;
    const recent = data.sessions.filter(
      (session) => parseTs(session.started_at).getTime() >= cutoff,
    );
    const sets = recent.flatMap((session) => session.sets);
    const best = data.exercises
      .map((exercise) => ({
        name: exercise.name,
        weight: Math.max(
          0,
          ...data.sessions.flatMap((session) =>
            session.sets
              .filter((set) => set.exercise_id === exercise.id)
              .map((set) => set.weight),
          ),
        ),
      }))
      .filter((item) => item.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    result = {
      sessions_7d: recent.length,
      sets_7d: sets.length,
      reps_7d: sets.reduce((sum, set) => sum + set.reps, 0),
      personal_bests: best,
      recent_pbs: recentPbs(data, cutoff),
    };
  } else throw new Error("Unknown local data request");
  if (method !== "GET") await writeLocalData(data);
  return result;
}

/* The big lifts lead Recent PBs when a session sets more than will fit. */
const BIG_LIFTS = /^(back squat|squat|bench press|bench|deadlift)$/i;

/** Recent PBs: working sets heavier than every earlier set of that exercise
 * (so not the first time it's done) since `cutoff`, the latest per exercise.
 * Newest session first, its Squat, Bench and Deadlift ahead of the rest; the
 * Train page shows as many as fit. */
function recentPbs(data, cutoff) {
  const sets = data.sessions
    .flatMap((session) =>
      session.sets.filter((set) => !set.warmup).map((set) => ({ set, session })),
    )
    .sort(
      (a, b) =>
        a.session.started_at.localeCompare(b.session.started_at) || a.set.id - b.set.id,
    );
  const heaviest = new Map(); // exercise id → heaviest weight so far
  const latest = new Map(); // exercise id → its latest PB
  sets.forEach(({ set, session }) => {
    const before = heaviest.get(set.exercise_id);
    if (before !== undefined && set.weight > before)
      latest.set(set.exercise_id, { set, session });
    if (before === undefined || set.weight > before) heaviest.set(set.exercise_id, set.weight);
  });
  const nameOf = (id) => data.exercises.find((e) => e.id === id)?.name || "Unknown exercise";
  return [...latest.values()]
    .filter(({ set, session }) => parseTs(set.logged_at || session.started_at).getTime() >= cutoff)
    .map(({ set, session }) => ({
      name: nameOf(set.exercise_id),
      weight: set.weight,
      reps: set.reps,
      at: set.logged_at || session.started_at,
      session: session.started_at,
      order: set.id,
    }))
    .sort(
      (a, b) =>
        b.session.localeCompare(a.session) ||
        BIG_LIFTS.test(b.name) - BIG_LIFTS.test(a.name) ||
        b.order - a.order,
    )
    .map(({ name, weight, reps, at }) => ({ name, weight, reps, at }));
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** Timestamps are stored as naive UTC strings; turn them into local Dates. */
function parseTs(ts) {
  if (!ts) return null;
  return new Date(ts.replace(" ", "T") + "Z");
}

function dayLabel(ts) {
  const d = parseTs(ts);
  if (!d) return "";
  const today = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Backups older than this are flagged in Settings. */
const BACKUP_STALE_DAYS = 14;

/** "Last backup" line for Settings, from the stored last_export. */
function lastBackupLine(lastExport, now = new Date()) {
  const d = parseTs(lastExport);
  if (!d) return { text: "Never backed up", stale: true };
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.max(0, Math.round((midnight(now) - midnight(d)) / 86400000));
  const ago =
    days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return { text: `Last backup ${ago}`, stale: days > BACKUP_STALE_DAYS };
}

function renderLastBackup() {
  const el = $("#last-backup");
  if (!el) return;
  const { text, stale } = lastBackupLine(dataCache?.last_export);
  el.textContent = text;
  el.classList.toggle("warn", stale);
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/* Weights are stored in kg whatever the unit setting, so backups don't depend
 * on it; only what is shown and typed is converted. */
const LB_PER_KG = 2.20462262;

function unitLabel() {
  return state.unit === "lb" ? "lb" : "kg";
}

/** A stored (kg) weight in the display unit. */
function fmtWeight(kg) {
  const n = num(state.unit === "lb" ? kg * LB_PER_KG : kg);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** A typed weight, in the display unit, as kg. Left unrounded so that 225 lb
 * shows back as 225, not 225.01. */
function toKg(value) {
  return state.unit === "lb" ? value / LB_PER_KG : value;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let toastTimer = null;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2200);
}

function buzz(ms = 12) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ------------------------------------------------------------------ sheet

/** `foot` is the sheet's main button; it sits below the scrolling body so it
 * stays on screen however long the form is. */
function openSheet(title, html, foot = "") {
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = html;
  $("#sheet-foot").innerHTML = foot;
  $("#sheet-foot").hidden = !foot;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  fitSheet();
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-body").innerHTML = "";
  $("#sheet-foot").innerHTML = "";
  document.body.style.overflow = "";
  state.draft = null;
  state.pendingPlans = null;
}

/* A phone keyboard covers the bottom of the screen without shrinking the
 * layout, so a sheet pinned to the bottom ends up behind it. Size the sheet's
 * backdrop to the visual viewport (what is still showing) instead. */
function fitSheet() {
  const vv = window.visualViewport;
  const backdrop = $("#sheet");
  if (!vv || backdrop.hidden) return;
  backdrop.style.top = `${vv.offsetTop}px`;
  backdrop.style.height = `${vv.height}px`;
  const focused = document.activeElement;
  if (focused?.matches("input, select, textarea") && backdrop.contains(focused))
    focused.scrollIntoView({ block: "nearest" });
}

window.visualViewport?.addEventListener("resize", fitSheet);
window.visualViewport?.addEventListener("scroll", fitSheet);

// ------------------------------------------------------------ drag to sort

/* Press a grip handle and drag: other cards make room where it would land,
 * and a trash bin appears at the bottom of the screen. Dropping on the bin
 * calls onDelete(index); dropping anywhere else calls onMove(from, to).
 * Pointer events cover touch and mouse; the handle has touch-action: none so
 * the page doesn't scroll instead. */

let drag = null;

function dragItems(list) {
  return Array.from(list.children).filter((node) =>
    node.matches("[data-drag-item]"),
  );
}

document.addEventListener("pointerdown", (ev) => {
  const handle = ev.target.closest("[data-drag-handle]");
  if (!handle || drag || ev.button > 0) return;
  const item = handle.closest("[data-drag-item]");
  const list = item.parentElement;
  const config = dragConfig[list.dataset.dragList];
  if (!config) return;
  ev.preventDefault();

  const rect = item.getBoundingClientRect();
  const ghost = item.cloneNode(true);
  ghost.classList.add("drag-ghost");
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
  });
  const placeholder = document.createElement("div");
  placeholder.className = "drag-placeholder";
  placeholder.style.height = `${rect.height}px`;
  item.before(placeholder);
  item.hidden = true;
  document.body.append(ghost);
  $("#toast").hidden = true;
  $("#trash").hidden = false;
  document.body.classList.add("dragging");

  drag = {
    config,
    list,
    item,
    ghost,
    placeholder,
    pointerId: ev.pointerId,
    from: dragItems(list).indexOf(item),
    offsetY: ev.clientY - rect.top,
    y: ev.clientY,
    overTrash: false,
    scroller: list.closest(".sheet-body"),
    frame: requestAnimationFrame(autoScroll),
  };
  buzz(15);
});

document.addEventListener("pointermove", (ev) => {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  drag.y = ev.clientY;
  positionDrag();
});

function positionDrag() {
  const { ghost, list, item, placeholder, y } = drag;
  // Vertical only: the card stays inside the screen while it moves.
  ghost.style.transform = `translateY(${y - drag.offsetY - parseFloat(ghost.style.top)}px)`;

  const trash = $("#trash");
  const overTrash = y >= trash.getBoundingClientRect().top;
  if (overTrash !== drag.overTrash) {
    drag.overTrash = overTrash;
    trash.classList.toggle("armed", overTrash);
    ghost.classList.toggle("doomed", overTrash);
    if (overTrash) buzz(25);
  }
  if (overTrash) return;

  const others = dragItems(list).filter((node) => node !== item);
  const before = others.find((node) => {
    const r = node.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  if (before) {
    if (placeholder.nextElementSibling !== before) before.before(placeholder);
  } else if (others.length) {
    others[others.length - 1].after(placeholder);
  }
}

/** Scroll the list while the finger sits near the top or just above the bin. */
function autoScroll() {
  if (!drag) return;
  const box = drag.scroller
    ? drag.scroller.getBoundingClientRect()
    : {
        top: $(".topbar").getBoundingClientRect().bottom,
        bottom: window.innerHeight,
      };
  const bottom = Math.min(box.bottom, $("#trash").getBoundingClientRect().top);
  const zone = 70;
  let speed = 0;
  if (drag.y < box.top + zone)
    speed = -Math.ceil((box.top + zone - drag.y) / 6);
  else if (drag.y > bottom - zone && drag.y < bottom)
    speed = Math.ceil((drag.y - (bottom - zone)) / 6);
  if (speed) {
    if (drag.scroller) drag.scroller.scrollTop += speed;
    else window.scrollBy(0, speed);
    positionDrag();
  }
  drag.frame = requestAnimationFrame(autoScroll);
}

function endDrag(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const { config, list, item, ghost, placeholder, from, overTrash } = drag;
  cancelAnimationFrame(drag.frame);
  const to = Array.from(list.children)
    .filter(
      (node) =>
        node === placeholder ||
        (node.matches("[data-drag-item]") && node !== item),
    )
    .indexOf(placeholder);
  ghost.remove();
  placeholder.remove();
  item.hidden = false;
  $("#trash").hidden = true;
  $("#trash").classList.remove("armed");
  document.body.classList.remove("dragging");
  drag = null;

  if (ev.type === "pointercancel") return;
  const run = overTrash
    ? config.onDelete(from)
    : to !== from
      ? config.onMove(from, to)
      : null;
  Promise.resolve(run).catch((err) => toast(err.message));
}

document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

// iOS shows a copy/lookup menu on a long press unless this is stopped.
document.addEventListener("contextmenu", (ev) => {
  if (drag || ev.target.closest("[data-drag-handle]")) ev.preventDefault();
});

const dragConfig = {
  session: {
    async onMove(from, to) {
      const ids = state.session.items.map((item) => item.exercise_id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      state.session = await api(`/sessions/${state.session.id}/items`, {
        method: "PUT",
        body: { exercise_ids: ids },
      });
      renderActiveSession();
    },
    async onDelete(index) {
      const item = state.session.items[index];
      const logged = state.session.sets.filter(
        (set) => set.exercise_id === item.exercise_id,
      ).length;
      if (
        logged &&
        !(await ask(
          `Remove ${item.name} and its ${logged} logged set${logged === 1 ? "" : "s"}?`,
          "Remove",
        ))
      )
        return;
      state.session = await api(
        `/sessions/${state.session.id}/items/${item.exercise_id}`,
        { method: "DELETE" },
      );
      renderActiveSession();
      toast(`${item.name} removed`);
    },
  },
  plan: {
    onMove(from, to) {
      syncDraftFromInputs();
      const items = state.draft.items;
      items.splice(to, 0, items.splice(from, 1)[0]);
      $("#sheet-body").innerHTML = planEditorHtml();
    },
    onDelete(index) {
      syncDraftFromInputs();
      state.draft.items.splice(index, 1);
      $("#sheet-body").innerHTML = planEditorHtml();
    },
  },
};

const GRIP = `<button type="button" class="drag-handle" data-drag-handle aria-label="Drag to reorder or delete">
  <svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><g fill="currentColor">
  <circle cx="3" cy="4" r="1.6"/><circle cx="9" cy="4" r="1.6"/><circle cx="3" cy="10" r="1.6"/>
  <circle cx="9" cy="10" r="1.6"/><circle cx="3" cy="16" r="1.6"/><circle cx="9" cy="16" r="1.6"/></g></svg>
</button>`;

// ------------------------------------- hold and drag to reorder or file away

/* On the Plans tab, touch and hold a plan card or a block's or folder's
 * title, then drag it and let go:
 * - over another plan (or block, or folder), it goes just above or below that
 *   one, in that one's list, so this both reorders and moves between lists;
 *   folders only reorder, as they always sit at the top;
 * - onto a folder (or, for a plan, a week) elsewhere, it goes in there, last;
 * - onto the bar at the bottom, it comes out of any folder.
 * Moving the finger before the hold completes is a normal scroll. */

const HOLD_MS = 450;
let hold = null; // a press that may become a move
let move = null; // a move in progress

document.addEventListener("pointerdown", (ev) => {
  if (drag || move || ev.button > 0) return;
  const source = state.building && ev.target.closest("[data-move]");
  // Not from a control inside it (Start, Edit…); a row that is itself a
  // button (a folder or block to tap into) can still be held.
  const control = ev.target.closest("button, input, select, a");
  if (!source || (control && control !== source)) return;
  cancelHold();
  hold = {
    source,
    pointerId: ev.pointerId,
    x: ev.clientX,
    y: ev.clientY,
    timer: setTimeout(startMove, HOLD_MS),
  };
});

function cancelHold() {
  if (hold) clearTimeout(hold.timer);
  hold = null;
}

function startMove() {
  const { source, pointerId, x, y } = hold;
  hold = null;
  const [kind, id] = source.dataset.move.split(":");
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true);
  ghost.classList.add("drag-ghost", "move-ghost");
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
  });
  document.body.append(ghost);
  source.classList.add("moving");
  $("#toast").hidden = true;
  // Folders can't go in anything, so there's nothing to take them out of.
  $("#unfile").hidden = kind === "folder";
  document.body.classList.add("dragging");
  move = {
    kind,
    id: Number(id),
    source,
    // What sits in the list: a block's whole <details>, not just its title.
    item: source.closest("[data-order]"),
    ghost,
    pointerId,
    from: dropTarget(kind, source.parentElement),
    target: null,
    dx: x - rect.left,
    dy: y - rect.top,
    x,
    y,
    frame: requestAnimationFrame(moveAutoScroll),
  };
  buzz(20);
  positionMove();
}

/** The nearest place at or above `el` that can take this kind of item. */
function dropTarget(kind, el) {
  if (kind === "folder") return null;
  for (let node = el?.closest("[data-drop]"); node; node = node.parentElement?.closest("[data-drop]")) {
    const [where] = node.dataset.drop.split(":");
    if (where !== "week" || kind === "plan") return node;
  }
  return null;
}

function positionMove() {
  const { ghost, x, y } = move;
  ghost.style.transform = `translate(${x - move.dx - parseFloat(ghost.style.left)}px, ${y - move.dy - parseFloat(ghost.style.top)}px)`;
  const under = document.elementFromPoint(x, y);
  // Over one of its own kind: above or below that one.
  const sibling = under?.closest(`[data-order^="${move.kind}:"]`);
  let target = null;
  if (sibling && sibling !== move.item) {
    const r = (sibling.querySelector(":scope > summary") || sibling).getBoundingClientRect();
    target = { el: sibling, after: y > r.top + r.height / 2 };
  } else if (!sibling) {
    const el = dropTarget(move.kind, under);
    if (el && el !== move.from) target = { el };
  }
  const same = (a, b) => a?.el === b?.el && a?.after === b?.after;
  if (same(target, move.target)) return;
  clearMoveTarget();
  move.target = target;
  if (target) {
    target.el.classList.add(
      target.after === undefined ? "drop-here" : target.after ? "drop-after" : "drop-before",
    );
    buzz(8);
  }
}

function clearMoveTarget() {
  move.target?.el.classList.remove("drop-here", "drop-before", "drop-after");
}

/** Scroll the page while the finger sits near the top or just above the bar. */
function moveAutoScroll() {
  if (!move) return;
  const top = $(".topbar").getBoundingClientRect().bottom;
  const bottom = $("#unfile").getBoundingClientRect().top;
  const zone = 70;
  let speed = 0;
  if (move.y < top + zone) speed = -Math.ceil((top + zone - move.y) / 6);
  else if (move.y > bottom - zone && move.y < bottom)
    speed = Math.ceil((move.y - (bottom - zone)) / 6);
  if (speed) {
    window.scrollBy(0, speed);
    positionMove();
  }
  move.frame = requestAnimationFrame(moveAutoScroll);
}

document.addEventListener("pointermove", (ev) => {
  if (hold && ev.pointerId === hold.pointerId) {
    // Moved before the hold finished: the finger is scrolling.
    if (Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > 10) cancelHold();
    return;
  }
  if (!move || ev.pointerId !== move.pointerId) return;
  move.x = ev.clientX;
  move.y = ev.clientY;
  positionMove();
});

// Once a move starts the page must not scroll under the finger, or the
// browser cancels the pointer.
document.addEventListener(
  "touchmove",
  (ev) => {
    if (move) ev.preventDefault();
  },
  { passive: false },
);

function endMove(ev) {
  if (hold && ev.pointerId === hold.pointerId) cancelHold();
  if (!move || ev.pointerId !== move.pointerId) return;
  const { kind, id, source, item, ghost, target } = move;
  cancelAnimationFrame(move.frame);
  clearMoveTarget();
  ghost.remove();
  source.classList.remove("moving");
  $("#unfile").hidden = true;
  document.body.classList.remove("dragging");
  move = null;
  // The release would otherwise click whatever is under it, like a summary.
  swallowClicksUntil = Date.now() + 500;
  if (ev.type === "pointercancel" || !target) return;
  const run =
    target.after === undefined
      ? moveTo(kind, id, ...target.el.dataset.drop.split(":"))
      : reorderTo(kind, id, item, target.el, target.after);
  run.catch((err) => toast(err.message));
}

/** Put the item just above or below `next` (one of its kind), in its list. */
async function reorderTo(kind, id, item, next, after) {
  const idOf = (el) => Number(el.dataset.order.split(":")[1]);
  const inList = (el) =>
    Array.from(el.parentElement.children).filter((n) =>
      n.dataset.order?.startsWith(`${kind}:`),
    );
  const ids = inList(next)
    .filter((n) => n !== item)
    .map(idOf);
  ids.splice(ids.indexOf(idOf(next)) + (after ? 1 : 0), 0, id);
  const sameList = item.parentElement === next.parentElement;
  if (sameList && inList(item).map(idOf).join() === ids.join()) return;

  if (kind === "folder") {
    await api("/folders/order", { method: "PUT", body: { ids } });
  } else if (kind === "block") {
    const block = state.groups.find((g) => g.id === id);
    const other = state.groups.find((g) => g.id === idOf(next));
    if (!block || !other) return;
    if (!sameList)
      await api(`/groups/${id}`, {
        method: "PUT",
        body: { name: block.name, folder_id: other.folder_id ?? null },
      });
    await api("/groups/order", { method: "PUT", body: { ids } });
  } else {
    const other = state.plans.find((p) => p.id === idOf(next));
    if (!other) return;
    if (!sameList)
      await api(`/plans/${id}/place`, {
        method: "PUT",
        body: { group_id: other.group_id ?? null, folder_id: other.folder_id ?? null },
      });
    await api("/plans/order", { method: "PUT", body: { ids } });
  }
  buzz(15);
  refresh();
}

let swallowClicksUntil = 0;
document.addEventListener(
  "click",
  (ev) => {
    if (Date.now() >= swallowClicksUntil) return;
    swallowClicksUntil = 0;
    ev.preventDefault();
    ev.stopPropagation();
  },
  true,
);

document.addEventListener("pointerup", endMove);
document.addEventListener("pointercancel", endMove);
document.addEventListener("contextmenu", (ev) => {
  if (move || hold) ev.preventDefault();
});

/** Put a plan or block in a folder ("folder"), a plan in a week ("week"), or
 * either in no folder ("none"). */
async function moveTo(kind, id, where, whereId) {
  whereId = Number(whereId);
  const folder = where === "folder" ? whereId : null;
  if (kind === "block") {
    const block = state.groups.find((g) => g.id === id);
    if (!block) return;
    await api(`/groups/${id}`, {
      method: "PUT",
      body: { name: block.name, folder_id: folder },
    });
  } else {
    await api(`/plans/${id}/place`, {
      method: "PUT",
      body: { group_id: where === "week" ? whereId : null, folder_id: folder },
    });
  }
  const name =
    where === "folder"
      ? state.folders.find((f) => f.id === whereId)?.name
      : where === "week"
        ? state.groups.find((g) => g.id === whereId)?.name
        : null;
  buzz(15);
  toast(name ? `Moved to ${name}` : "Moved out of folders");
  refresh();
}

// ------------------------------------------------------------- rest timer

function startRest(seconds) {
  stopRest();
  if (!seconds) return;
  state.rest = { until: Date.now() + seconds * 1000, timer: null };
  const tick = () => {
    const left = (state.rest.until - Date.now()) / 1000;
    if (left <= 0) {
      stopRest();
      $("#topbar-note").textContent = "Rest done";
      buzz([80, 60, 80]);
      setTimeout(() => {
        if (!state.rest) $("#topbar-note").textContent = "";
      }, 4000);
      return;
    }
    $("#topbar-note").textContent = `Rest ${fmtDuration(left)}`;
  };
  tick();
  state.rest.timer = setInterval(tick, 500);
}

function stopRest() {
  if (state.rest) clearInterval(state.rest.timer);
  state.rest = null;
}

// ---------------------------------------------------------- screen wake lock

/* Keep the screen on while a workout is running so the rest timer stays in
 * view. The browser drops the lock whenever the app is hidden, so it is taken
 * again on return. Where unsupported or refused (e.g. battery saver), the
 * screen just sleeps as before. */
let wakeLock = null; // WakeLockSentinel, or "pending" while being requested

async function syncWakeLock() {
  const wanted = !!state.session && document.visibilityState === "visible";
  if (wanted && !wakeLock && navigator.wakeLock) {
    wakeLock = "pending";
    try {
      const lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
      wakeLock = lock;
    } catch {
      wakeLock = null;
      return;
    }
    syncWakeLock(); // the workout may have ended while we waited
  } else if (!wanted && wakeLock && wakeLock !== "pending") {
    const lock = wakeLock;
    wakeLock = null;
    lock.release().catch(() => {});
  }
}

document.addEventListener("visibilitychange", syncWakeLock);

// ----------------------------------------------------------------- install

/* The app only runs once installed. In a browser tab the gate below is the
 * whole page: a single Install button. Chrome lets the page open its install
 * dialog; iPhone has no such hook, so there the button explains the steps. It
 * matters most on iPhone: Safari may clear an uninstalled site's storage,
 * workouts included, after 7 days unopened. localhost skips the gate so the
 * app can be tested on a desktop. */
let installPrompt = null; // Chrome's beforeinstallprompt event, kept for the button
let justInstalled = false;

const isInstalled = () =>
  matchMedia("(display-mode: standalone)").matches ||
  navigator.standalone === true;

const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS

const isGated = !isInstalled() && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);

window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();
  installPrompt = ev;
  renderInstallGate();
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  justInstalled = true;
  renderInstallGate();
});

function renderInstallGate() {
  document.body.classList.toggle("gated", isGated);
  const gate = $("#install-gate");
  gate.hidden = !isGated;
  if (!isGated) return;
  const plansWaiting = loadPref("pending-plans", null)
    ? isIos()
      ? `<p class="muted">Someone sent you plans. iPhone keeps the installed app
           apart from Safari, so tap <strong>Copy plans</strong>, install the app,
           then paste them in <strong>Plans › Import plans</strong>.</p>
         <button class="btn ghost" data-action="copy-pending-plans">Copy plans</button>`
      : `<p class="muted">Someone sent you plans; they'll be waiting when you open
           the app. Already have it? Open <strong>Raw Muscle</strong> from your home screen.</p>`
    : "";
  gate.innerHTML = justInstalled
    ? `<img class="brand-logo" src="icons/icon-192.png" alt="" />
       <h1>Raw Muscle Gym Tracker</h1>
       <p class="muted">Installed. Open <strong>Raw Muscle</strong> from your home
         screen to start.</p>${plansWaiting}`
    : `<img class="brand-logo" src="icons/icon-192.png" alt="" />
       <h1>Raw Muscle Gym Tracker</h1>
       <p class="muted">Install the app to use it. It opens full screen and
         works with no connection${isIos() ? ", and Safari won't clear your workouts" : ""}.</p>
       <button class="btn" data-action="${installPrompt ? "install-app" : "install-help"}">Install app</button>
       ${plansWaiting}
       ${matchMedia("(pointer: fine)").matches ? '<p class="muted">On a computer? <a href="desktop/">Build plans here</a> and send them to your phone.</p>' : ""}`;
}

// A wrench: build mode on the Plans tab.
const BUILD_ICON = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;

$('[data-action="toggle-build"]').innerHTML = BUILD_ICON;

// Two overlapping pages: copy.
const COPY_ICON = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`;

const SHARE_ICON = `<svg class="inline-icon" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/></svg>`;

// ------------------------------------------------------------ view: train

/** Set rows, warm-ups marked "W" and working sets numbered 1, 2, 3...
 * `end(set)` fills the last column. */
function setRowsHtml(sets, end = () => "<span></span>") {
  let n = 0;
  return sets
    .map(
      (x) => `
          <div class="setrow${x.warmup ? " warmup" : ""}">
            <span class="idx"${x.warmup ? ' title="Warm-up set"' : ""}>${x.warmup ? "W" : ++n}</span>
            <span>${x.reps} &times; ${fmtWeight(x.weight)} ${unitLabel()}${x.rpe != null ? ` · RPE ${x.rpe}` : ""}</span>
            ${end(x)}
          </div>`,
    )
    .join("");
}

/** The Train tab shows the session screen while one is open, otherwise the
 * start page, with a card to get back into a session still running. */
function renderTrain() {
  syncWakeLock();
  if (!state.session) closeSession();
  $("#train-idle").hidden = state.inSession;
  $("#train-active").hidden = !state.inSession;
  if (state.inSession) renderActiveSession();
  else {
    renderCurrentSession();
  }
}

function sessionMeta(s) {
  const mins = Math.round((Date.now() - parseTs(s.started_at).getTime()) / 60000);
  const volume = s.sets.reduce((sum, x) => sum + x.reps * x.weight, 0);
  return `${mins} min · ${s.sets.length} sets · ${fmtWeight(volume)} ${unitLabel()}`;
}

function renderCurrentSession() {
  const card = $("#current-session");
  const s = state.session;
  card.hidden = !s;
  if (!s) return;
  card.innerHTML = `
    <h2>Current session</h2>
    <p class="muted"><strong>${esc(s.name)}</strong> &middot; ${sessionMeta(s)}</p>
    <button class="btn good" data-action="continue-session" style="margin-top:14px">
      Continue session
    </button>`;
}

/* The Train page fills the screen and no more: Heaviest Lifts always shows
 * 3, this week's PBs fill the room left (at least 1 when there are any), and
 * any room after that goes to more heaviest-ever sets. */
function renderStats(stats) {
  const pbs = stats.recent_pbs || [];
  const best = stats.personal_bests || [];
  const pbRow = (pb) => `
      <div class="spread">
        <span><strong>${esc(pb.name)}</strong><br><span class="muted">${esc(dayLabel(pb.at))}</span></span>
        <span class="pill pb">${fmtWeight(pb.weight)} ${unitLabel()} &times; ${pb.reps}</span>
      </div>`;
  const bestRow = (b) => `
    <div class="spread"><span>${esc(b.name)}</span>
    <span class="pill">${fmtWeight(b.weight)} ${unitLabel()}</span></div>`;
  $("#recent-pbs").hidden = !pbs.length;
  $("#recent-pbs").innerHTML = `
    <h2>Recent PBs</h2>
    <div class="stack tight" style="margin-top:8px">${pbs.slice(0, 1).map(pbRow).join("")}</div>`;
  $("#heaviest").hidden = !best.length;
  $("#heaviest").innerHTML = `
    <h2>Heaviest Lifts</h2>
    <div class="stack tight" style="margin-top:8px">${best.slice(0, 3).map(bestRow).join("")}</div>`;
  $("#stats").innerHTML = `
    <h2>Last 7 days</h2>
    <div class="row wrap" style="margin-top:8px">
      <span class="pill">${plural(stats.sessions_7d, "session")}</span>
      <span class="pill">${plural(stats.sets_7d, "set")}</span>
      <span class="pill">${plural(stats.reps_7d, "rep")}</span>
    </div>`;

  // Then one row at a time while the page still fits on screen.
  const fits = () => document.documentElement.scrollHeight <= window.innerHeight;
  const fill = (list, rows, html) => {
    for (const row of rows) {
      list.insertAdjacentHTML("beforeend", html(row));
      if (!fits()) {
        list.lastElementChild.remove();
        return false;
      }
    }
    return true;
  };
  if (fill($("#recent-pbs .stack"), pbs.slice(1), pbRow))
    fill($("#heaviest .stack"), best.slice(3), bestRow);
}

function renderActiveSession() {
  const s = state.session;
  $("#session-name").textContent = s.name;
  $("#session-meta").textContent = sessionMeta(s);

  const finished = finishedExercises();
  $("#exercise-list").innerHTML =
    s.items
      .map((item) => {
        const sets = s.sets.filter((x) => x.exercise_id === item.exercise_id);
        // Done hides the log form; the card folds to its title until tapped.
        const isDone = finished.done.includes(item.exercise_id);
        const isOpen = !isDone || finished.open.includes(item.exercise_id);
        const toggle = isDone
          ? ` data-action="toggle-exercise" data-ex="${item.exercise_id}"`
          : "";
        const working = sets.filter((x) => !x.warmup).length;
        const prev = s.previous[String(item.exercise_id)];
        const done = item.target_sets > 0 && working >= item.target_sets;

        const target = item.target_sets
          ? `${item.target_sets} &times; ${item.target_reps}${
              item.target_rpe != null ? ` @ RPE ${item.target_rpe}` : ""
            }`
          : "no target";

        const last = sets[sets.length - 1];
        const fillWeight = last
          ? fmtWeight(last.weight)
          : prev
            ? fmtWeight(prev.weight)
            : "";
        const fillReps =
          item.target_reps || (last ? last.reps : prev ? prev.reps : "");
        const fillRpe = last?.rpe ?? item.target_rpe ?? prev?.rpe ?? "";

        return `
      <article class="exercise${isDone ? " finished" : ""}${isOpen ? " open" : ""}" data-drag-item>
        <div class="exercise-head${done || isDone ? " done" : ""}">
          ${GRIP}
          <div class="grow"${toggle}>
            <h3>${esc(item.name)}</h3>
            <div class="target">${target} &middot; rest ${item.rest_seconds}s</div>
            ${
              prev
                ? `<div class="prev">Last: ${prev.reps} &times; ${fmtWeight(prev.weight)} ${unitLabel()}
              (${esc(dayLabel(prev.started_at))})</div>`
                : ""
            }
          </div>
          <span class="pill"${toggle}>${working}${item.target_sets ? `/${item.target_sets}` : ""}</span>
          ${isDone ? `<button type="button" class="chev-btn"${toggle} aria-label="${isOpen ? "Collapse" : "Expand"}" aria-expanded="${isOpen}"><span class="chev" aria-hidden="true"></span></button>` : ""}
        </div>
        ${!isOpen ? "" : isDone ? `${
          sets.length
            ? `<div class="setlist">${setRowsHtml(
                sets,
                (x) => `<button class="del" data-action="del-set" data-id="${x.id}"
              aria-label="Delete set">&times;</button>`,
              )}</div>`
            : ""
        }
        <div class="exercise-foot">
          <button class="btn small ghost" data-action="add-set" data-ex="${item.exercise_id}">+ Add set</button>
        </div>` : `${
          sets.length
            ? `<div class="setlist">${setRowsHtml(
                sets,
                (x) => `<button class="del" data-action="del-set" data-id="${x.id}"
              aria-label="Delete set">&times;</button>`,
              )}</div>`
            : ""
        }
        <div class="logform" data-ex="${item.exercise_id}" data-rest="${item.rest_seconds}">
          <input type="number" inputmode="decimal" step="0.5" min="0"
            data-f="weight" placeholder="${unitLabel()}" value="${fillWeight}">
          <input type="number" inputmode="numeric" step="1" min="0"
            data-f="reps" placeholder="reps" value="${fillReps}">
          <input type="number" inputmode="decimal" step="0.5" min="1" max="10"
            data-f="rpe" placeholder="RPE" value="${fillRpe}">
          <button class="btn" data-action="log" data-ex="${item.exercise_id}">Log</button>
          <label class="check">
            <input type="checkbox" data-f="warmup"${last?.warmup ? " checked" : ""}>
            Warm up
          </label>
        </div>
        <div class="exercise-foot">
          <button class="btn small ghost" data-action="exercise-done" data-ex="${item.exercise_id}">Done</button>
        </div>`}
      </article>`;
      })
      .join("") || '<p class="empty">Add an exercise to get going.</p>';
}

// ------------------------------------------------------------ view: plans

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Plans tab: folders first, each holding blocks and plans, then blocks
 * outside any folder (each holding weeks, each holding plans), then plans in
 * neither. Folders are optional: without any, the tab is just blocks. */
/* The Plans tab opens as a viewer: plans to look through and start. Build
 * mode (the wrench by Import plans) shows everything for making and changing
 * them; anything marked .build-only is hidden outside it, and plans and
 * blocks can only be held and dragged in it. */
function setBuilding(on) {
  state.building = on;
  $("#view-plans").classList.toggle("building", on);
  const toggle = $('[data-action="toggle-build"]');
  toggle.setAttribute("aria-pressed", String(on));
  toggle.title = on ? "Done building" : "Build mode";
}

/* The Plans tab goes one level at a time. The top lists folders, blocks
 * and loose plans; tapping a folder, block or week opens it as a screen of
 * its own ("folder:<id>", "block:<id>" or "week:<id>" on the screen stack, so
 * the back button steps out again). Plans are cards whose exercises drop
 * down. */
function planDir(stack = currentStack()) {
  const dir = { folder: null, block: null, week: null };
  stack.forEach((screen) => {
    const [kind, id] = String(screen).split(":");
    if (id && Object.hasOwn(dir, kind)) dir[kind] = Number(id);
  });
  return dir;
}

function renderPlans() {
  const stack = currentStack();
  const dir = planDir(stack);
  const blocks = state.groups.filter((g) => g.parent_id == null);
  const weeks = state.groups.filter((g) => g.parent_id != null);
  const weekIds = new Set(weeks.map((w) => w.id));
  const folder = state.folders.find((f) => f.id === dir.folder);
  const block = blocks.find((b) => b.id === dir.block);
  const week = weeks.find((w) => w.id === dir.week);

  // Something opened has since been deleted: step back out to what's left.
  const found = { folder, block, week };
  const valid = stack.filter((screen) => {
    const [kind, id] = String(screen).split(":");
    return !id || !Object.hasOwn(found, kind) || found[kind];
  });
  if (valid.length !== stack.length) return navigate(valid);

  const plansInWeek = (id) => state.plans.filter((p) => p.group_id === id);
  const looseIn = (folderId) =>
    state.plans.filter((p) => !weekIds.has(p.group_id) && (p.folder_id ?? null) === folderId);
  const blocksIn = (folderId) => blocks.filter((b) => (b.folder_id ?? null) === folderId);
  const weeksOf = (blockId) => weeks.filter((w) => w.parent_id === blockId);
  const folderPlanCount = (f) => {
    const inBlocks = new Set(blocksIn(f.id).map((b) => b.id));
    return state.plans.filter((p) => {
      const w = weeks.find((g) => g.id === p.group_id);
      return w ? inBlocks.has(w.parent_id) : p.folder_id === f.id;
    }).length;
  };

  /* A folder, block or week to tap into. `drop` makes it a place to drop a
   * held plan or block; `move` lets it be held and dragged into order. */
  const row = (kind, item, count, { drop = "", move = "" } = {}) => `
    <button type="button" class="card dir-row ${kind}" data-action="open-dir" data-to="${kind}:${item.id}"${drop ? ` data-drop="${drop}"` : ""}${move ? ` data-move="${move}" data-order="${move}"` : ""}>
      <span class="grow group-name">${esc(item.name)}</span>
      <span class="pill">${count}</span>
      <span class="chev" aria-hidden="true"></span>
    </button>`;
  const folderRow = (f) =>
    row("folder", f, plural(folderPlanCount(f), "plan"), { drop: `folder:${f.id}`, move: `folder:${f.id}` });
  const blockRow = (b) => row("block", b, plural(weeksOf(b.id).length, "week"), { move: `block:${b.id}` });
  const weekRow = (w) => {
    const plans = plansInWeek(w.id);
    const done = plans.filter((p) => p.completed_at).length;
    return row("week", w, done ? `${done}/${plans.length} done` : plural(plans.length, "plan"), {
      drop: `week:${w.id}`,
    });
  };

  // The opened folder, block or week: back, where it sits, and its tools.
  const head = (title, crumbs, count, tools) => `
    <div class="dir-head">
      <button type="button" class="back-btn" data-action="plans-back" aria-label="Back">
        <span class="chev" aria-hidden="true"></span></button>
      <div class="grow">
        ${crumbs.length ? `<div class="crumbs">${crumbs.map(esc).join(" › ")}</div>` : ""}
        <h2>${esc(title)}</h2>
      </div>
      <span class="pill">${count}</span>
    </div>
    <div class="row wrap build-only">${tools}</div>`;
  const editTools = (item, kind = "group") => `
    <button class="btn small ghost" data-action="rename-${kind}" data-id="${item.id}">Rename</button>
    <button class="btn small danger" data-action="del-${kind}" data-id="${item.id}">Delete</button>`;
  const label = (text) => `<h3 class="group-label">${text}</h3>`;
  const empty = (text) => `<p class="muted dir-empty">${text}</p>`;

  let html;
  if (week) {
    const parent = blocks.find((b) => b.id === week.parent_id);
    const inFolder = state.folders.find((f) => f.id === parent?.folder_id);
    const plans = plansInWeek(week.id);
    html =
      head(week.name, [inFolder?.name, parent?.name].filter(Boolean), plural(plans.length, "plan"), `
        <button class="btn small ghost" data-action="new-plan" data-group="${week.id}">+ Plan</button>
        ${editTools(week)}`) +
      (plans.map(planCardHtml).join("") || empty("No plans in this week yet."));
  } else if (block) {
    const inFolder = state.folders.find((f) => f.id === block.folder_id);
    const blockWeeks = weeksOf(block.id);
    html =
      head(block.name, inFolder ? [inFolder.name] : [], plural(blockWeeks.length, "week"), `
        <button class="btn small ghost" data-action="new-week" data-parent="${block.id}">+ Week</button>
        ${editTools(block)}`) +
      (blockWeeks.map(weekRow).join("") || empty("No weeks in this block yet."));
  } else if (folder) {
    const inBlocks = blocksIn(folder.id);
    const loose = looseIn(folder.id);
    html =
      head(folder.name, [], plural(folderPlanCount(folder), "plan"), `
        <button class="btn small ghost" data-action="new-block" data-folder="${folder.id}">+ Block</button>
        <button class="btn small ghost" data-action="new-plan" data-folder="${folder.id}">+ Plan</button>
        <button class="btn small ghost" data-action="copy-folder" data-id="${folder.id}">Duplicate</button>
        ${editTools(folder, "folder")}`) +
      (inBlocks.map(blockRow).join("") +
        (loose.length ? (inBlocks.length ? label("Plans") : "") + loose.map(planCardHtml).join("") : "") ||
        empty("Nothing in this folder yet."));
  } else {
    const topBlocks = blocksIn(null);
    const loose = looseIn(null);
    html =
      state.folders.map(folderRow).join("") +
      topBlocks.map(blockRow).join("") +
      (loose.length
        ? (topBlocks.length || state.folders.length ? label("Other plans") : "") + loose.map(planCardHtml).join("")
        : "");
    html ||= state.building
      ? '<p class="empty">No plans yet.<br>A plan is a named list of exercises with targets.<br>Group plans into blocks and weeks with + New block, and blocks into folders with + New folder.</p>'
      : `<p class="empty">No plans yet.<br>Import plans someone sent you, or tap ${BUILD_ICON} to make your own.</p>`;
  }
  // The page's + New buttons are for the top level only.
  $("#view-plans").classList.toggle("in-dir", !!(week || block || folder));
  $("#plan-list").innerHTML = html;
}

/** A plan card: its title drops down to show the exercises (open ones are kept
 * in openGroups as "p<id>"); Edit, Delete and Start stay in view.
 *
 * A plan in a week is a one-off: once a workout from it is finished it shows
 * "Completed <date>" in the accent colour, and Copy (to do it again under a
 * new name) takes the place of Edit and Start. */
function planCardHtml(p) {
  const completed = p.group_id != null && p.completed_at;
  const count = `${p.exercise_count} exercise${p.exercise_count === 1 ? "" : "s"}`;
  const meta = completed
    ? `${count}<br>Completed ${esc(dayLabel(p.completed_at).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase()))}`
    : p.group_id == null && p.last_done
      ? `${count} &middot; last ${esc(dayLabel(p.last_done))}`
      : count;
  const exercises = p.items
    .map((it) => {
      const name = state.exercises.find((e) => e.id === it.exercise_id)?.name || "Unknown exercise";
      const target = it.target_sets
        ? `${it.target_sets} &times; ${it.target_reps}${it.target_rpe != null ? ` @ RPE ${it.target_rpe}` : ""}`
        : "no target";
      return `<li><span class="grow">${esc(name)}</span><span class="muted">${target}</span></li>`;
    })
    .join("");
  return `
        <div class="card plan-card${completed ? " completed" : ""}" data-move="plan:${p.id}" data-order="plan:${p.id}">
          <details data-plan="${p.id}"${state.openGroups.has(`p${p.id}`) ? " open" : ""}>
            <summary>
              <span class="chev" aria-hidden="true"></span>
              <div class="grow">
                <h2>${esc(p.name)}</h2>
                <span class="muted">${meta}</span>
              </div>
            </summary>
            ${exercises ? `<ol class="plan-exercises">${exercises}</ol>` : '<p class="muted">No exercises yet.</p>'}
          </details>
          ${p.notes ? `<p class="muted">${esc(p.notes)}</p>` : ""}
          <div class="row${completed ? " build-only" : ""}" style="margin-top:12px">
            ${completed ? "" : `<button class="btn small ghost build-only" data-action="edit-plan" data-id="${p.id}">Edit</button>`}
            <button class="btn small danger build-only" data-action="del-plan" data-id="${p.id}">Delete</button>
            ${completed
              ? `<button class="btn small ghost build-only" style="margin-left:auto" data-action="copy-plan" data-id="${p.id}">Copy</button>`
              : `<button class="btn small view-only" style="margin-left:auto" data-action="start-plan" data-id="${p.id}">Start</button>`}
          </div>
        </div>`;
}

function planEditorHtml() {
  const d = state.draft;
  const items = d.items
    .map(
      (it, i) => `
    <div class="card" data-idx="${i}" data-drag-item>
      <div class="spread">
        ${GRIP}
        <strong class="grow">${esc(it.name)}</strong>
        <button class="btn small subtle" data-action="draft-remove" data-idx="${i}" aria-label="Remove">&times;</button>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="field"><label>Sets</label>
          <input type="number" inputmode="numeric" min="1" data-idx="${i}" data-f="target_sets" value="${it.target_sets}"></div>
        <div class="field"><label>Reps</label>
          <input type="number" inputmode="numeric" min="1" data-idx="${i}" data-f="target_reps" value="${it.target_reps}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="field"><label>RPE</label>
          <input type="number" inputmode="decimal" step="0.5" min="1" max="10" data-idx="${i}" data-f="target_rpe" value="${it.target_rpe ?? ""}"></div>
        <div class="field"><label>Rest (s)</label>
          <input type="number" inputmode="numeric" min="0" data-idx="${i}" data-f="rest_seconds" value="${it.rest_seconds}"></div>
      </div>
    </div>`,
    )
    .join("");

  return `
    <div class="stack">
      <div><label>Plan name</label>
        <input id="draft-name" value="${esc(d.name)}" placeholder="Push day"></div>
      <div><label>Notes</label>
        <input id="draft-notes" value="${esc(d.notes)}" placeholder="optional"></div>
      ${placeSelectHtml(d.group_id, d.folder_id)}
      ${items ? `<div class="stack" data-drag-list="plan">${items}</div>` : '<p class="muted">No exercises yet.</p>'}
      <button class="btn ghost" data-action="draft-add">+ Add exercise</button>
    </div>`;
}

const PLAN_SAVE =
  '<button class="btn good" data-action="draft-save">Save plan</button>';

/** Where the plan sits: a week (listed under its block), a folder without a
 * week, or neither. Values are "w<week id>", "f<folder id>" or "". */
function placeSelectHtml(groupId, folderId) {
  const blocks = state.groups.filter((g) => g.parent_id == null);
  const weekOptions = (block) =>
    state.groups
      .filter((g) => g.parent_id === block.id)
      .map(
        (w) =>
          `<option value="w${w.id}"${w.id === groupId ? " selected" : ""}>${esc(block.name)} › ${esc(w.name)}</option>`,
      )
      .join("");
  const folders = state.folders
    .map((folder) => {
      const inFolder = blocks
        .filter((b) => b.folder_id === folder.id)
        .map(weekOptions)
        .join("");
      const here = groupId == null && folderId === folder.id;
      return `<optgroup label="${esc(folder.name)}">
        <option value="f${folder.id}"${here ? " selected" : ""}>${esc(folder.name)}, no week</option>${inFolder}</optgroup>`;
    })
    .join("");
  const unfoldered = blocks
    .filter((b) => b.folder_id == null)
    .map((block) => {
      const options = weekOptions(block);
      return options ? `<optgroup label="${esc(block.name)}">${options}</optgroup>` : "";
    })
    .join("");
  if (!folders && !unfoldered) return "";
  const label = state.folders.length ? "Folder or week" : "Week";
  return `
      <div><label for="draft-group">${label}</label>
        <select id="draft-group"><option value="">None</option>${folders}${unfoldered}</select></div>`;
}

function openPlanEditor(plan, groupId = null, folderId = null) {
  state.draft = plan
    ? {
        id: plan.id,
        name: plan.name,
        notes: plan.notes,
        group_id: plan.group_id ?? null,
        folder_id: plan.folder_id ?? null,
        items: plan.items.map((it) => ({
          exercise_id: it.exercise_id,
          name: it.name,
          target_sets: it.target_sets,
          target_reps: it.target_reps,
          target_rpe: it.target_rpe ?? null,
          rest_seconds: it.rest_seconds,
        })),
      }
    : {
        id: null,
        name: "",
        notes: "",
        group_id: groupId,
        folder_id: groupId == null ? folderId : null,
        items: [],
      };
  openSheet(plan ? "Edit plan" : "New plan", planEditorHtml(), PLAN_SAVE);
}

/** Pull the sheet's inputs into the draft before any re-render or save. */
function syncDraftFromInputs() {
  const d = state.draft;
  if (!d) return;
  const nameEl = $("#draft-name");
  const notesEl = $("#draft-notes");
  if (nameEl) d.name = nameEl.value;
  if (notesEl) d.notes = notesEl.value;
  const groupEl = $("#draft-group");
  if (groupEl) {
    const [kind, id] = [groupEl.value[0], Number(groupEl.value.slice(1))];
    d.group_id = kind === "w" ? id : null;
    d.folder_id = kind === "f" ? id : null;
  }
  $$("#sheet-body input[data-idx]").forEach((input) => {
    const item = d.items[Number(input.dataset.idx)];
    if (!item) return;
    const field = input.dataset.f;
    if (field === "target_rpe") {
      item.target_rpe = input.value === "" ? null : num(input.value);
    } else {
      item[field] =
        parseInt(input.value, 10) || (field === "rest_seconds" ? 0 : 1);
    }
  });
}

function redrawDraft() {
  syncDraftFromInputs();
  $("#sheet-body").innerHTML = planEditorHtml();
}

/** Name a new folder, block or week, or rename one. `attrs` tell the save
 * action which; `extra` is any fields under the name. */
function openGroupSheet(
  title,
  name,
  attrs,
  { action = "group-save", extra = "", placeholder = "" } = {},
) {
  openSheet(
    title,
    `
    <div><label for="group-name">Name</label>
      <input id="group-name" value="${esc(name)}" maxlength="80"
        placeholder="${esc(placeholder)}"
        enterkeyhint="done" data-enter="${action}"></div>${extra}`,
    `<button class="btn good" data-action="${action}" ${attrs}>Save</button>`,
  );
  $("#group-name").select();
}

/** Which folder a block sits in; nothing to pick until a folder exists. */
function folderSelectHtml(folderId) {
  if (!state.folders.length) return "";
  return `
    <div><label for="group-folder">Folder</label>
      <select id="group-folder"><option value="">No folder</option>${state.folders
        .map(
          (f) =>
            `<option value="${f.id}"${f.id === folderId ? " selected" : ""}>${esc(f.name)}</option>`,
        )
        .join("")}</select></div>`;
}

// ---------------------------------------------------------- exercise picker

function openExercisePicker(onPick) {
  state.onPick = onPick;
  const list = state.exercises
    .map(
      (e) => `
    <button class="picker-item" data-action="pick-exercise" data-id="${e.id}">
      <span class="grow">${esc(e.name)}</span>
      <span class="pill">${esc(e.muscle_group)}</span>
    </button>`,
    )
    .join("");
  openSheet(
    "Choose exercise",
    `
    <div class="stack">
      <input id="ex-search" placeholder="Search or type a new name" autocomplete="off">
      <button class="btn ghost" data-action="new-exercise">+ Create new exercise</button>
      <div id="ex-list" class="stack tight">${list}</div>
    </div>`,
  );
  $("#ex-search").addEventListener("input", (ev) => {
    const q = ev.target.value.toLowerCase();
    $$("#ex-list .picker-item").forEach((btn) => {
      btn.hidden = !btn.textContent.toLowerCase().includes(q);
    });
  });
}

// ---------------------------------------------------------- view: history

function renderHistoryFilter() {
  const logged = new Set(
    state.history.flatMap((s) => s.sets.map((x) => x.exercise_id)),
  );
  const options = state.exercises
    .filter((e) => logged.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!options.some((e) => e.id === state.historyExercise))
    state.historyExercise = null;
  $("#hide-warmups-row").hidden = state.historyExercise === null;
  $("#hide-warmups").checked = state.hideWarmups;
  $("#history-filter").innerHTML =
    '<option value="">All workouts</option>' +
    options
      .map(
        (e) =>
          `<option value="${e.id}"${e.id === state.historyExercise ? " selected" : ""}>${esc(e.name)}</option>`,
      )
      .join("");
}

/** Every session containing one exercise, newest first, with just its sets
 * (less the warm-ups, if hidden). */
function renderExerciseHistory(exerciseId) {
  const sessions = state.history
    .map((s) => ({
      ...s,
      sets: s.sets.filter(
        (x) =>
          x.exercise_id === exerciseId && !(state.hideWarmups && x.warmup),
      ),
    }))
    .filter((s) => s.sets.length);
  if (!sessions.length) {
    $("#history-list").innerHTML =
      '<p class="empty">Only warm-up sets logged for this exercise.</p>';
    return;
  }
  $("#history-list").innerHTML = sessions
    .map((s) => {
      const top = Math.max(...s.sets.map((x) => x.weight));
      return `
        <button class="card" style="text-align:left;width:100%;cursor:pointer"
          data-action="show-session" data-id="${s.id}">
          <div class="spread">
            <div class="grow">
              <h2>${esc(dayLabel(s.started_at))}</h2>
              <span class="muted">${esc(s.name)} &middot; ${s.sets.length} set${s.sets.length === 1 ? "" : "s"}</span>
            </div>
            <span class="pill">top ${fmtWeight(top)} ${unitLabel()}</span>
          </div>
          <div class="stack tight" style="margin-top:8px">
            ${setRowsHtml(s.sets)}
          </div>
        </button>`;
    })
    .join("");
}

function renderUnitButtons() {
  $$('[data-action="set-unit"]').forEach((btn) => {
    const on = btn.dataset.unit === unitLabel();
    btn.classList.toggle("ghost", !on);
    btn.setAttribute("aria-pressed", String(on));
  });
}

function themeDots() {
  return `<span class="theme-dots" aria-hidden="true"><i style="background:var(--accent)"></i><i
    style="background:var(--surface-2)"></i><i style="background:var(--good)"></i></span>`;
}

/* The Theme row shows the current palette; tapping it opens the swatches. */
function renderThemePicker() {
  const current = document.documentElement.dataset.theme;
  const label = THEMES.find(([id]) => id === current)[1];
  $("#theme-toggle").innerHTML = `${themeDots()}<span>${label}</span><span aria-hidden="true">&#9662;</span>`;
  $$('[data-action="set-theme"]').forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.value === current));
  });
}

function renderHistory() {
  renderHistoryFilter();
  if (state.historyExercise !== null)
    return renderExerciseHistory(state.historyExercise);
  $("#history-list").innerHTML = state.history.length
    ? state.history
        .map(
          (s) => `
        <button class="card" style="text-align:left;width:100%;cursor:pointer"
          data-action="show-session" data-id="${s.id}">
          <div class="spread">
            <div class="grow">
              <h2>${esc(s.name)}</h2>
              <span class="muted">${esc(dayLabel(s.started_at))} &middot;
                ${s.exercise_count} exercises &middot; ${s.set_count} sets</span>
            </div>
            <span class="pill">${fmtWeight(s.volume)} ${unitLabel()}</span>
          </div>
          ${s.finished_at ? "" : '<p class="muted">in progress</p>'}
        </button>`,
        )
        .join("")
    : '<p class="empty">Nothing logged yet.</p>';
}

async function showSessionDetail(id) {
  const s = await api(`/sessions/${id}`);
  const byExercise = new Map();
  s.sets.forEach((x) => {
    if (!byExercise.has(x.name)) byExercise.set(x.name, []);
    byExercise.get(x.name).push(x);
  });
  const body =
    Array.from(byExercise.entries())
      .map(
        ([name, sets]) => `
    <div class="card">
      <h3>${esc(name)}</h3>
      <div class="stack tight" style="margin-top:8px">
        ${setRowsHtml(sets)}
      </div>
    </div>`,
      )
      .join("") || '<p class="muted">No sets logged.</p>';

  openSheet(
    `${s.name} — ${dayLabel(s.started_at)}`,
    `
    <div class="stack">
      ${s.notes ? `<p class="muted">${esc(s.notes)}</p>` : ""}
      ${body}
      <button class="btn danger" data-action="del-session" data-id="${s.id}">Delete session</button>
    </div>`,
  );
}

// ------------------------------------------------------------------ router

const TITLES = { train: "Train", plans: "Plans", history: "History" };

function setView(view) {
  state.view = view;
  $("#topbar-title").textContent = TITLES[view];
  $$(".view").forEach((v) => {
    v.hidden = v.id !== `view-${view}`;
  });
  $$(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view),
  );
  window.scrollTo(0, 0);
  refresh();
}

/* Screens stack up from the Train start page, one browser history entry
 * each, so the phone's back button steps back through them instead of
 * closing the app: Plans or History go back to Train, and a session (which
 * keeps running) goes back to wherever it was started. A stack is a list of
 * screens above the start page, e.g. ["plans", "session"]. */

const currentStack = () => history.state?.stack || [];
let pendingStack = null; // to push once a history.go() back has landed

function navigate(stack) {
  const from = currentStack();
  let keep = 0;
  while (keep < from.length && from[keep] === stack[keep]) keep++;
  if (keep === from.length) {
    pushScreens(stack, keep);
  } else if (keep === from.length - 1 && stack.length === from.length) {
    history.replaceState({ stack }, "");
    showScreen(stack);
  } else {
    // Back down to the shared part first; popstate finishes the job.
    pendingStack = keep < stack.length ? stack : null;
    history.go(keep - from.length);
  }
}

function pushScreens(stack, from) {
  for (let i = from; i < stack.length; i++)
    history.pushState({ stack: stack.slice(0, i + 1) }, "");
  showScreen(stack);
}

function showScreen(stack) {
  const top = stack[stack.length - 1] || "train";
  state.inSession = top === "session";
  // A folder, block or week opened on the Plans tab ("week:3") is Plans too.
  setView(state.inSession ? "train" : top.includes(":") ? "plans" : top);
}

window.addEventListener("popstate", () => {
  if (pendingStack) {
    const stack = pendingStack;
    pendingStack = null;
    return pushScreens(stack, currentStack().length);
  }
  closeSheet();
  showScreen(currentStack());
});

/** Leave the session screen other than by the back button: back to Train. */
function closeSession() {
  if (!state.inSession) return;
  state.inSession = false;
  navigate([]);
}

/** Only one workout at a time; a second would strand the first unfinished. */
async function ensureNoActiveSession() {
  if (await api("/sessions/active"))
    throw new Error("Finish or discard the current session first");
}

async function refresh() {
  try {
    if (state.view === "train") {
      const [session, stats] = await Promise.all([
        api("/sessions/active"),
        api("/stats"),
      ]);
      state.session = session;
      renderTrain();
      renderStats(stats);
    } else if (state.view === "plans") {
      [state.plans, state.groups, state.folders] = await Promise.all([
        api("/plans"),
        api("/groups"),
        api("/folders"),
      ]);
      renderPlans();
    } else {
      [state.history, state.exercises] = await Promise.all([
        api("/history"),
        api("/exercises"),
      ]);
      renderHistory();
    }
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------ actions

const actions = {
  async "start-plan"(el) {
    await ensureNoActiveSession();
    state.session = await api("/sessions", {
      method: "POST",
      body: { plan_id: Number(el.dataset.id) },
    });
    closeSheet();
    navigate([...currentStack(), "session"]);
  },

  "select-plan"() {
    navigate(["plans"]);
  },

  "continue-session"() {
    navigate(["session"]);
  },

  async "install-app"() {
    const prompt = installPrompt;
    installPrompt = null; // Chrome's event only opens the dialog once
    if (prompt) await prompt.prompt();
    renderInstallGate();
  },

  "install-help"() {
    if (!isIos()) {
      openSheet(
        "Install the app",
        `<p>Open your browser's menu and choose <strong>Install app</strong>
          or <strong>Add to Home screen</strong>, then open <strong>Raw Muscle</strong>
          from your home screen.</p>`,
      );
      return;
    }
    openSheet(
      "Install on iPhone",
      `
        <ol class="steps">
          <li>Tap <strong>Share</strong> ${SHARE_ICON}. In Safari it may be
            under <strong>&bull;&bull;&bull;</strong>.</li>
          <li>Tap <strong>Add to Home Screen</strong>. You may need to scroll
            down or tap <strong>View More</strong>.</li>
          <li>Tap <strong>Add</strong>, then open <strong>Raw Muscle</strong> from
            your home screen.</li>
        </ol>
        <p class="muted" style="margin-top:14px">Your workouts are kept on this
          phone only. Once the app is on the home screen, Safari won't clear
          them. Use Export data in Settings (the gear) now and then as a backup.</p>`,
    );
  },

  "open-settings"() {
    openSheet(
      "Settings",
      `
        <div class="spread">
          <span>Weight unit</span>
          <div class="row">
            <button class="btn small" data-action="set-unit" data-unit="kg">kg</button>
            <button class="btn small ghost" data-action="set-unit" data-unit="lb">lb</button>
          </div>
        </div>
        <div class="spread" style="margin-top:14px">
          <span>Theme</span>
          <button id="theme-toggle" class="theme-toggle" data-action="toggle-themes"
            aria-expanded="false" aria-controls="theme-grid"></button>
        </div>
        <div id="theme-grid" class="theme-grid" hidden>
          ${THEMES.map(
            ([id, label]) => `
            <button class="theme-swatch" data-theme="${id}" data-action="set-theme"
              data-value="${id}" aria-pressed="false">
              <span>${label}</span>${themeDots()}
            </button>`,
          ).join("")}
        </div>
        <h3 style="margin-top:20px">Data backup</h3>
        <p class="muted">Your workouts are kept on this phone only. Export now
          and then to keep a copy; Import replaces everything here.</p>
        <p id="last-backup" class="muted" style="margin-top:8px"></p>
        <div class="row" style="margin-top:10px">
          <button class="btn small ghost" data-action="export-data">Export data</button>
          <button class="btn small ghost" data-action="import-data">Import data</button>
        </div>
        <div class="brand-footer">
          <img class="brand-logo small" src="icons/icon-192.png" alt="" />
          <span>Raw Muscle Gym Tracker</span>
        </div>`,
    );
    renderUnitButtons();
    renderThemePicker();
    renderLastBackup();
  },

  "toggle-themes"() {
    const grid = $("#theme-grid");
    grid.hidden = !grid.hidden;
    $("#theme-toggle").setAttribute("aria-expanded", String(!grid.hidden));
  },

  "set-theme"(el) {
    savePref("theme", applyTheme(el.dataset.value));
    $("#theme-grid").hidden = true;
    $("#theme-toggle").setAttribute("aria-expanded", "false");
    renderThemePicker();
  },

  "set-unit"(el) {
    state.unit = el.dataset.unit === "lb" ? "lb" : "kg";
    savePref("unit", state.unit);
    renderUnitButtons();
    refresh();
  },

  async "start-freestyle"() {
    await ensureNoActiveSession();
    openSheet(
      "Name your session",
      `
        <div><label for="freestyle-name">Session name</label>
          <input id="freestyle-name" value="" placeholder="e.g. Upper body" maxlength="80"
            enterkeyhint="go" data-enter="begin-freestyle"></div>`,
      '<button class="btn" data-action="begin-freestyle">Start session</button>',
    );
    $("#freestyle-name").focus();
  },

  async "begin-freestyle"() {
    const name = $("#freestyle-name").value.trim() || "New session";
    state.session = await api("/sessions", {
      method: "POST",
      body: { plan_id: null, name },
    });
    closeSheet();
    navigate(["session"]);
  },

  async log(el) {
    const form = el.closest(".logform");
    const weight = toKg(num(form.querySelector('[data-f="weight"]').value));
    const reps = parseInt(form.querySelector('[data-f="reps"]').value, 10);
    const rpeInput = form.querySelector('[data-f="rpe"]').value;
    const rpe = rpeInput === "" ? null : num(rpeInput);
    const warmup = form.querySelector('[data-f="warmup"]').checked;
    if (!Number.isFinite(reps) || reps <= 0)
      return toast("Enter the reps first");
    if (rpe !== null && (!Number.isFinite(rpe) || rpe < 1 || rpe > 10)) {
      return toast("RPE must be between 1 and 10");
    }
    const exerciseId = Number(el.dataset.ex);
    const done = state.session.sets.filter(
      (x) => x.exercise_id === exerciseId,
    ).length;
    state.session = await api(`/sessions/${state.session.id}/sets`, {
      method: "POST",
      body: {
        exercise_id: exerciseId,
        set_index: done + 1,
        reps,
        weight,
        rpe,
        warmup,
      },
    });
    buzz();
    renderActiveSession();
    startRest(Number(form.dataset.rest));
  },

  "exercise-done"(el) {
    markExercise(el.dataset.ex, (f, id) => {
      f.done = [...without(f.done, id), id];
      f.open = without(f.open, id);
    });
  },

  "toggle-exercise"(el) {
    markExercise(el.dataset.ex, (f, id) => {
      f.open = f.open.includes(id) ? without(f.open, id) : [...f.open, id];
    });
  },

  // Back to logging: the form and Done button return.
  "add-set"(el) {
    markExercise(el.dataset.ex, (f, id) => {
      f.done = without(f.done, id);
      f.open = without(f.open, id);
    });
  },

  async "del-set"(el) {
    await api(`/sets/${el.dataset.id}`, { method: "DELETE" });
    state.session = await api(`/sessions/${state.session.id}`);
    renderActiveSession();
  },

  "add-exercise"() {
    openExercisePicker(async (exercise) => {
      state.session = await api(`/sessions/${state.session.id}/items`, {
        method: "POST",
        body: { exercise_id: exercise.id },
      });
      closeSheet();
      renderActiveSession();
    });
  },

  finish() {
    openSheet(
      "Finish workout",
      `
      <div><label for="finish-notes">How did it go?</label>
        <textarea id="finish-notes" rows="3" placeholder="optional"></textarea></div>`,
      '<button class="btn good" data-action="finish-confirm">Save workout</button>',
    );
  },

  async "finish-confirm"() {
    const notes = $("#finish-notes").value;
    await api(`/sessions/${state.session.id}/finish`, {
      method: "POST",
      body: { notes },
    });
    state.session = null;
    closeSession();
    stopRest();
    $("#topbar-note").textContent = "";
    closeSheet();
    toast("Workout saved");
    refresh();
  },

  async discard() {
    if (!(await ask("Discard this session and everything logged in it?", "Discard"))) return;
    await api(`/sessions/${state.session.id}`, { method: "DELETE" });
    state.session = null;
    closeSession();
    stopRest();
    $("#topbar-note").textContent = "";
    refresh();
  },

  "new-plan"(el) {
    openPlanEditor(
      null,
      el.dataset.group ? Number(el.dataset.group) : null,
      el.dataset.folder ? Number(el.dataset.folder) : null,
    );
  },

  "new-folder"() {
    openGroupSheet("New folder", "", "", {
      action: "folder-save",
      placeholder: "Nationals prep",
    });
  },

  "rename-folder"(el) {
    const folder = state.folders.find((f) => f.id === Number(el.dataset.id));
    if (!folder) return;
    openGroupSheet("Rename folder", folder.name, `data-id="${folder.id}"`, {
      action: "folder-save",
    });
  },

  async "folder-save"(el) {
    const name = $("#group-name").value.trim();
    if (!name) return toast("Give it a name");
    if (el.dataset.id) {
      await api(`/folders/${el.dataset.id}`, { method: "PUT", body: { name } });
    } else {
      await api("/folders", { method: "POST", body: { name } });
    }
    closeSheet();
    refresh();
  },

  "copy-folder"(el) {
    const folder = state.folders.find((f) => f.id === Number(el.dataset.id));
    if (!folder) return;
    openGroupSheet("Duplicate folder", `${folder.name} (copy)`, `data-id="${folder.id}"`, {
      action: "folder-copy",
      extra:
        '<p class="muted">Copies every block, week and plan in it. Logged workouts stay with the original.</p>',
    });
  },

  async "folder-copy"(el) {
    const name = $("#group-name").value.trim();
    if (!name) return toast("Give it a name");
    await api(`/folders/${el.dataset.id}/copy`, {
      method: "POST",
      body: { name },
    });
    closeSheet();
    toast(`Made ${name}`);
    refresh();
  },

  async "del-folder"(el) {
    const folder = state.folders.find((f) => f.id === Number(el.dataset.id));
    if (!folder) return;
    if (
      !(await ask(
        `Delete the folder ${folder.name}? Its blocks and plans are kept, outside any folder.`,
      ))
    )
      return;
    await api(`/folders/${folder.id}`, { method: "DELETE" });
    refresh();
  },

  "new-block"(el) {
    const count = state.groups.filter((g) => g.parent_id == null).length;
    const folder = el.dataset.folder ? Number(el.dataset.folder) : null;
    openGroupSheet("New block", `Block ${count + 1}`, "", {
      extra: folderSelectHtml(folder),
    });
  },

  "new-week"(el) {
    const parent = Number(el.dataset.parent);
    const count = state.groups.filter((g) => g.parent_id === parent).length;
    openGroupSheet(
      "New week",
      `Week ${count + 1}`,
      `data-parent="${parent}"`,
    );
  },

  "rename-group"(el) {
    const group = state.groups.find((g) => g.id === Number(el.dataset.id));
    if (!group) return;
    const isBlock = group.parent_id == null;
    openGroupSheet(
      isBlock ? "Rename block" : "Rename week",
      group.name,
      `data-id="${group.id}"`,
      { extra: isBlock ? folderSelectHtml(group.folder_id ?? null) : "" },
    );
  },

  async "group-save"(el) {
    const name = $("#group-name").value.trim();
    if (!name) return toast("Give it a name");
    const folderEl = $("#group-folder");
    const body = { name };
    if (folderEl) body.folder_id = folderEl.value ? Number(folderEl.value) : null;
    if (el.dataset.id) {
      await api(`/groups/${el.dataset.id}`, { method: "PUT", body });
    } else {
      const parentId = el.dataset.parent ? Number(el.dataset.parent) : null;
      await api("/groups", {
        method: "POST",
        body: { ...body, parent_id: parentId },
      });
    }
    closeSheet();
    refresh();
  },

  async "del-group"(el) {
    const group = state.groups.find((g) => g.id === Number(el.dataset.id));
    if (!group) return;
    const weeks = state.groups.filter((g) => g.parent_id === group.id).length;
    const what =
      group.parent_id == null && weeks
        ? `${group.name} and its ${plural(weeks, "week")}`
        : group.name;
    if (!(await ask(`Delete ${what}? Its plans are kept under Other plans.`)))
      return;
    await api(`/groups/${group.id}`, { method: "DELETE" });
    refresh();
  },

  async "edit-plan"(el) {
    openPlanEditor(await api(`/plans/${el.dataset.id}`));
  },

  // A copy to do a completed plan again: same exercises, a new name, and by
  // default the same week.
  "copy-plan"(el) {
    const plan = state.plans.find((p) => p.id === Number(el.dataset.id));
    if (!plan) return;
    openSheet(
      "Copy plan",
      `<div class="stack">
        <div><label for="copy-name">Name</label>
          <input id="copy-name" value="${esc(plan.name)}" maxlength="80"
            enterkeyhint="done" data-enter="copy-plan-save"></div>
        ${placeSelectHtml(plan.group_id, plan.folder_id)}
      </div>`,
      `<button class="btn good" data-action="copy-plan-save" data-id="${plan.id}">Make copy</button>`,
    );
    $("#copy-name").select();
  },

  async "copy-plan-save"() {
    const id = Number($('#sheet-foot [data-action="copy-plan-save"]').dataset.id);
    const plan = await api(`/plans/${id}`);
    const name = $("#copy-name").value.trim();
    if (!name) return toast("Give the plan a name");
    const place = $("#draft-group")?.value || "";
    const where = Number(place.slice(1));
    await api("/plans", {
      method: "POST",
      body: {
        name,
        notes: plan.notes,
        group_id: place[0] === "w" ? where : null,
        folder_id: place[0] === "f" ? where : null,
        items: plan.items.map((it) => ({
          exercise_id: it.exercise_id,
          target_sets: it.target_sets,
          target_reps: it.target_reps,
          target_rpe: it.target_rpe,
          rest_seconds: it.rest_seconds,
        })),
      },
    });
    closeSheet();
    toast(`${name} added`);
    refresh();
  },

  async "del-plan"(el) {
    if (!(await ask("Delete this plan? Logged workouts are kept."))) return;
    await api(`/plans/${el.dataset.id}`, { method: "DELETE" });
    refresh();
  },

  "draft-add"() {
    syncDraftFromInputs();
    const draft = state.draft;
    openExercisePicker((exercise) => {
      draft.items.push({
        exercise_id: exercise.id,
        name: exercise.name,
        target_sets: 3,
        target_reps: 10,
        target_rpe: null,
        rest_seconds: 90,
      });
      state.draft = draft;
      openSheet(draft.id ? "Edit plan" : "New plan", planEditorHtml(), PLAN_SAVE);
    });
  },

  "draft-remove"(el) {
    syncDraftFromInputs();
    state.draft.items.splice(Number(el.dataset.idx), 1);
    $("#sheet-body").innerHTML = planEditorHtml();
  },

  async "draft-save"() {
    syncDraftFromInputs();
    const d = state.draft;
    if (!d.name.trim()) return toast("Give the plan a name");
    if (
      d.items.some(
        (it) =>
          it.target_rpe !== null && (it.target_rpe < 1 || it.target_rpe > 10),
      )
    )
      return toast("RPE must be between 1 and 10");
    const body = {
      name: d.name,
      notes: d.notes,
      group_id: d.group_id,
      folder_id: d.folder_id,
      items: d.items.map((it) => ({
        exercise_id: it.exercise_id,
        target_sets: it.target_sets,
        target_reps: it.target_reps,
        target_rpe: it.target_rpe,
        rest_seconds: it.rest_seconds,
      })),
    };
    if (d.id) await api(`/plans/${d.id}`, { method: "PUT", body });
    else await api("/plans", { method: "POST", body });
    closeSheet();
    toast("Plan saved");
    refresh();
  },

  "pick-exercise"(el) {
    const exercise = state.exercises.find(
      (e) => e.id === Number(el.dataset.id),
    );
    if (exercise && state.onPick) return state.onPick(exercise);
  },

  "new-exercise"() {
    const typed = $("#ex-search") ? $("#ex-search").value : "";
    const onPick = state.onPick;
    openSheet(
      "New exercise",
      `
      <div class="stack">
        <div><label>Name</label><input id="nx-name" value="${esc(typed)}" placeholder="Cable fly"></div>
        <div class="row">
          <div class="field"><label>Muscle group</label>
            <select id="nx-group">
              ${[
                "chest",
                "back",
                "legs",
                "shoulders",
                "arms",
                "core",
                "cardio",
                "other",
              ]
                .map((g) => `<option value="${g}">${g}</option>`)
                .join("")}
            </select></div>
          <div class="field"><label>Equipment</label>
            <input id="nx-equip" placeholder="cable"></div>
        </div>
      </div>`,
      '<button class="btn good" data-action="new-exercise-save">Create</button>',
    );
    state.onPick = onPick;
  },

  async "new-exercise-save"() {
    const name = $("#nx-name").value.trim();
    if (!name) return toast("Name it first");
    const created = await api("/exercises", {
      method: "POST",
      body: {
        name,
        muscle_group: $("#nx-group").value,
        equipment: $("#nx-equip").value,
      },
    });
    state.exercises = await api("/exercises");
    if (state.onPick) return state.onPick(created);
  },

  "show-session"(el) {
    showSessionDetail(Number(el.dataset.id));
  },

  async "del-session"(el) {
    if (!(await ask("Delete this workout for good?"))) return;
    await api(`/sessions/${el.dataset.id}`, { method: "DELETE" });
    if (state.session?.id === Number(el.dataset.id)) {
      // Deleted the workout still running: stop keeping the screen on.
      state.session = null;
      stopRest();
      $("#topbar-note").textContent = "";
      syncWakeLock();
    }
    closeSheet();
    refresh();
  },

  async "export-data"() {
    // No awaits before share(): browsers only allow it straight after a tap.
    const data = dataCache;
    if (!data) return toast("Nothing to export yet");
    const stamp = new Date().toISOString();
    const name = `raw-muscle-backup-${stamp.slice(0, 10)}`;
    const json = JSON.stringify({ ...data, exported_at: stamp }, null, 2);
    if (!(await shareJson(name, json))) return;
    await writeLocalData({ ...data, last_export: nowTs() });
    renderLastBackup();
    toast("Backup exported");
  },

  "import-data"() {
    $("#import-file").click();
  },

  // Every plan or one folder's, as a shared file (.txt, which Chrome allows;
  // the import reads the JSON inside) or a copied link. The tap on the sheet
  // starts the share, which browsers only allow right after a tap.
  "export-plans"() {
    const data = dataCache;
    if (!data?.plans.length && !data?.folders.length && !data?.groups.length)
      return toast("No plans to export");
    openSheet(
      "Export plans",
      '<p class="muted">Tap one to share its plans file, or the copy button to copy a link to paste into a message. Either goes in on the other phone with Plans › Import plans.</p>',
      `<div class="stack tight">${exportButtons(data)}</div>`,
    );
  },

  "copy-plans-link"(el) {
    const data = dataCache;
    if (!data) return closeSheet();
    const folder = data.folders.find((f) => f.id === Number(el.dataset.folder));
    ensureUids(data);
    const link = plansLink(plansToExport(data, new Date().toISOString(), folder ? folder.id : null));
    closeSheet();
    return copyText(link).then(async () => {
      await writeLocalData(data); // keeps the uids the link was made with
      toast("Link copied; paste it into a message");
    });
  },

  async "export-plans-go"(el) {
    const data = dataCache;
    if (!data) return closeSheet();
    const folder = el.dataset.folder ? Number(el.dataset.folder) : null;
    closeSheet();
    await exportPlansFile(data, folder);
  },

  "open-dir"(el) {
    navigate([...currentStack(), el.dataset.to]);
  },

  "plans-back"() {
    navigate(currentStack().slice(0, -1));
  },

  "toggle-build"() {
    setBuilding(!state.building);
    renderPlans();
    toast(state.building ? "Build mode: make and change plans" : "Done building");
  },

  "import-plans"() {
    openSheet(
      "Import plans",
      `<div><label for="plans-link">Paste a plans link</label>
        <textarea id="plans-link" rows="3" placeholder="https://…#plans=…"></textarea></div>`,
      `<div class="stack tight">
        <button class="btn good" data-action="import-plans-link">Add from link</button>
        <button class="btn ghost" data-action="import-plans-file">Choose a file</button>
      </div>`,
    );
  },

  async "import-plans-link"() {
    const packed = packedFromText($("#plans-link").value);
    if (!packed) return toast("That isn't a plans link");
    await offerPlansImport(await unpackPlans(packed), "link");
  },

  "import-plans-file"() {
    closeSheet();
    $("#import-plans-file").click();
  },

  // The install page on iPhone: Safari can't hand plans to the installed app.
  async "copy-pending-plans"() {
    const packed = loadPref("pending-plans", null);
    if (!packed) return;
    await navigator.clipboard.writeText(linkFor(packed));
    toast("Copied. Install the app, then paste it in Plans › Import plans");
  },

  async "import-plans-add"() {
    await finishPlansImport("add");
  },

  async "import-plans-replace"() {
    const count = state.plans.length;
    if (
      count &&
      !(await ask(
        `Delete all ${plural(count, "plan")}, folders and blocks on this phone and use the file's list instead? Logged workouts are kept.`,
        "Overwrite",
      ))
    )
      return;
    await finishPlansImport("replace");
  },

  "close-sheet"() {
    closeSheet();
  },
};

/** What can be exported: every plan, then each folder that has some. */
function exportScopes(data) {
  ensureGroups(data);
  const folders = data.folders
    .map((folder) => ({
      folder,
      count: data.plans.filter((p) => planFolderId(data, p) === folder.id).length,
    }))
    .sort((a, b) => byOrder(a.folder, b.folder));
  return [{ folder: null, count: data.plans.length }, ...folders];
}

/** A row per scope: share its file, or copy its link. */
function exportButtons(data) {
  return exportScopes(data)
    .map(({ folder, count }, i) => {
      const id = folder ? folder.id : "";
      return `<div class="export-row">
        <button class="btn ${i ? "ghost" : "good"}" data-action="export-plans-go" data-folder="${id}">${folder ? esc(folder.name) : "All plans"} (${count})</button>
        <button class="btn ghost icon-only" data-action="copy-plans-link" data-folder="${id}" aria-label="Copy link" title="Copy link">${COPY_ICON}</button>
      </div>`;
    })
    .join("");
}

/** Share a plans file: every plan, or with `folderId` one folder's. No awaits
 * before share(): browsers only allow it straight after a tap. */
async function exportPlansFile(data, folderId) {
  ensureUids(data); // so the next import can tell these plans apart
  const folder = data.folders.find((f) => f.id === folderId);
  const stamp = new Date().toISOString();
  const slug = folder
    ? folder.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : "";
  const name = `raw-muscle-plans-${slug ? `${slug}-` : ""}${stamp.slice(0, 10)}`;
  const json = JSON.stringify(
    plansToExport(data, stamp, folder ? folder.id : null),
    null,
    2,
  );
  if (!(await shareJson(name, json))) return;
  await writeLocalData(data);
  toast(folder ? `${folder.name} exported` : "Plans exported");
}

/** Ask whether to add or overwrite with plans from a file or link, after a dry
 * run on a copy to say how many are new. */
async function offerPlansImport(parsed, source) {
  const { added, updated, skipped, groups } = importPlans(structuredClone(await localData()), parsed);
  const news = [
    added && `${added} ${added === 1 ? "is" : "are"} new`,
    updated && `${updated} ${updated === 1 ? "has" : "have"} changed`,
    groups && (groups === 1 ? "1 new folder, block or week" : `${groups} new folders, blocks or weeks`),
  ].filter(Boolean);
  openSheet(
    "Import plans",
    `<p>This ${source} has ${parsed.folder?.name ? `the folder ${esc(String(parsed.folder.name))} with ` : ""}${plural(added + updated + skipped, "plan")}.
      ${news.length ? `${news.join(" and ")}.` : "You already have all of them, unchanged."}</p>
    <p class="muted"><strong>Add new plans</strong> keeps your plans, adds the
      ones you don't have into their folders, blocks and weeks, and updates
      the ones that have changed.
      <strong>Overwrite all plans</strong> deletes your plans, folders, blocks
      and weeks and uses the ${source}'s list instead. Logged workouts are kept.</p>`,
    `<div class="stack tight">
      <button class="btn good" data-action="import-plans-add">Add new plans</button>
      <button class="btn danger" data-action="import-plans-replace">Overwrite all plans</button>
    </div>`,
  );
  state.pendingPlans = parsed;
}

/** Apply the plans file waiting in state.pendingPlans. */
async function finishPlansImport(mode) {
  const parsed = state.pendingPlans;
  if (!parsed) return closeSheet();
  const data = await localData();
  const { added, updated, skipped, groups } = importPlans(data, parsed, mode);
  await writeLocalData(data);
  closeSheet();
  const done = [
    added && `added ${plural(added, "new plan")}`,
    updated && `updated ${updated}`,
    groups && (groups === 1 ? "1 new folder, block or week" : `${groups} new folders, blocks or weeks`),
    skipped && `${skipped} already up to date`,
  ].filter(Boolean);
  toast(
    mode === "replace"
      ? `Plans replaced with ${plural(added, "plan")}`
      : added || updated || groups
        ? done.join(", ").replace(/^./, (c) => c.toUpperCase())
        : "Nothing new; you have them all",
  );
  refresh();
}

// -------------------------------------------------------------------- wiring

document.addEventListener("click", async (ev) => {
  const tab = ev.target.closest(".tab");
  if (tab) {
    const view = tab.dataset.view;
    // Train keeps an open session on screen; any other tab leaves it running.
    if (view === "train" && state.inSession) return refresh();
    return navigate(view === "train" ? [] : [view]);
  }

  if (ev.target.id === "sheet") return closeSheet();

  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const handler = actions[el.dataset.action];
  if (!handler) return;
  ev.preventDefault();
  try {
    await handler(el);
  } catch (err) {
    toast(err.message);
  }
});

/** Share JSON as a file (name without extension), or download it where
 * sharing files is unsupported. Resolves false if the share sheet was dismissed.
 *
 * Shared as .txt because Chrome refuses to share .json files ("Permission
 * denied"); the imports read the text either way. */
async function shareJson(name, json) {
  const file = new File([json], `${name}.txt`, { type: "text/plain" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch (err) {
      if (err.name === "AbortError") return false; // closed the share sheet
      if (err.name !== "NotAllowedError") throw err;
      // Sharing refused on this device: fall through to a plain download.
    }
  }
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// ------------------------------------------------------------ plans links

/* Plans can travel as a link (Copy link in Export plans, here or in the
 * desktop plan builder): the plans export, compressed into the part after
 * "#", which browsers never send to the server. Opening it shows the Import
 * plans sheet. A link that opens in the browser rather than the installed app
 * (or before installing) waits in localStorage ("pending-plans") until the app
 * opens. On Android the browser and the app share that storage; on iPhone
 * they don't, so there the install page offers to copy the link instead, for
 * Plans › Import plans in the app. */

const LINK_KEY = "#plans=";

/** The link for a plans export (a promise). */
async function plansLink(exported) {
  const bytes = new TextEncoder().encode(JSON.stringify(exported));
  const zipped = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer();
  let bin = "";
  new Uint8Array(zipped).forEach((b) => (bin += String.fromCharCode(b)));
  return linkFor(btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

/** Copy text that is still being made (a promise). Safari only lets a page
 * copy straight after a tap, so the promise goes to the clipboard as is where
 * it can; elsewhere it's awaited, which a tap a moment ago still covers. */
async function copyText(promise) {
  if (globalThis.ClipboardItem && navigator.clipboard.write) {
    const blob = promise.then((text) => new Blob([text], { type: "text/plain" }));
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  }
  return navigator.clipboard.writeText(await promise);
}

/** The link for packed plans (for Copy plans on an iPhone's install page). */
function linkFor(packed) {
  return new URL("./", location.href).href + LINK_KEY + packed;
}

/** The packed plans in a link, or in a message with a link in it. */
function packedFromText(text) {
  return /#plans=([\w-]+)/.exec(text || "")?.[1] ?? null;
}

async function unpackPlans(packed) {
  try {
    const bin = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
    ).text();
    return JSON.parse(text);
  } catch {
    throw new Error("That plans link is broken or cut short");
  }
}

/** Plans from a link the app was opened with go to "pending-plans", and the
 * link comes off the address so a reload doesn't offer them again. */
function keepPlansFromAddress() {
  const packed = packedFromText(location.hash);
  if (!packed) return false;
  savePref("pending-plans", packed);
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

/** Offer the plans waiting from a link, once. */
async function offerPendingPlans() {
  const packed = loadPref("pending-plans", null);
  if (!packed) return;
  savePref("pending-plans", null);
  try {
    await offerPlansImport(await unpackPlans(packed), "link");
  } catch (err) {
    toast(err.message);
  }
}

// A link tapped while the app is already open only changes the "#" part.
window.addEventListener("hashchange", () => {
  if (keepPlansFromAddress() && !isGated) offerPendingPlans();
});

/** A random id that stays with a plan, folder, block or week across phones, so an
 * import can tell what it already has. */
function newUid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

/** Plans, folders and groups made before uids get one the first time they're
 * needed. */
function ensureUids(data) {
  ensureGroups(data);
  [...data.plans, ...data.groups, ...data.folders].forEach((item) => {
    if (!item.uid) item.uid = newUid();
  });
}

/** Plans with exercises referenced by name, since ids differ between phones.
 * A plan in a week carries its place as `group: [block name, week name]`, and
 * `group_uids` the same pair by uid. A plan in a folder (directly, or through
 * its block) carries `folder` and `folder_uid`.
 *
 * With `onlyFolder` (a folder id) just that folder's plans go in the file.
 *
 * `structure` lists the folders, blocks and weeks themselves (in order), so
 * ones with no plans in yet travel too: blocks carry their folder and weeks
 * their block, by name and uid. Files from before it simply lack it. */
function plansToExport(data, stamp, onlyFolder = null) {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const folders = Array.isArray(data.folders) ? data.folders : [];
  const lookup = { groups, folders };
  const groupPath = (id) => {
    const week = groups.find((g) => g.id === id && g.parent_id != null);
    const block = week && groups.find((g) => g.id === week.parent_id);
    return block ? [block, week] : null;
  };
  const folderOf = (plan) =>
    folders.find((f) => f.id === planFolderId(lookup, plan)) || null;
  const only = onlyFolder == null ? null : folders.find((f) => f.id === onlyFolder);
  const plans =
    onlyFolder == null
      ? data.plans
      : data.plans.filter((plan) => folderOf(plan)?.id === onlyFolder);
  const inScope = (folderId) => onlyFolder == null || (folderId ?? null) === onlyFolder;
  const sorted = (list) => [...list].sort(byOrder);
  const blocks = sorted(groups.filter((g) => g.parent_id == null && inScope(g.folder_id)));
  const folderNamed = (id) => folders.find((f) => f.id === id);
  const structure = {
    folders: sorted(folders.filter((f) => inScope(f.id))).map((f) => ({ uid: f.uid || null, name: f.name })),
    blocks: blocks.map((b) => ({
      uid: b.uid || null,
      name: b.name,
      folder: folderNamed(b.folder_id)?.name ?? null,
      folder_uid: folderNamed(b.folder_id)?.uid ?? null,
    })),
    weeks: blocks.flatMap((b) =>
      sorted(groups.filter((g) => g.parent_id === b.id)).map((w) => ({
        uid: w.uid || null,
        name: w.name,
        block: b.name,
        block_uid: b.uid || null,
      })),
    ),
  };
  return {
    kind: "gym-planner-plans",
    version: 1,
    exported_at: stamp,
    ...(only ? { folder: { uid: only.uid || null, name: only.name } } : {}),
    structure,
    plans: plans.map((plan) => {
      const path = groupPath(plan.group_id);
      const folder = folderOf(plan);
      return {
        uid: plan.uid || null,
        name: plan.name,
        notes: plan.notes || "",
        folder: folder ? folder.name : null,
        folder_uid: folder ? folder.uid || null : null,
        group: path && path.map((g) => g.name),
        group_uids: path && path.map((g) => g.uid || null),
        items: plan.items.map((item) => {
          const exercise = data.exercises.find((e) => e.id === item.exercise_id);
          return {
            exercise: {
              name: exercise?.name || "Unknown exercise",
              muscle_group: exercise?.muscle_group || "other",
              equipment: exercise?.equipment || "",
            },
            target_sets: item.target_sets,
            target_reps: item.target_reps,
            target_rpe: item.target_rpe ?? null,
            rest_seconds: item.rest_seconds,
          };
        }),
      };
    }),
  };
}

/** The plans in a plans export (or a full backup), in the export shape. */
/** A plans export (or a full backup, turned into one). */
function importedPlansFile(imported) {
  if (imported?.kind === "gym-planner-plans" && Array.isArray(imported.plans))
    return imported;
  if (
    imported?.version === 1 &&
    Array.isArray(imported.plans) &&
    Array.isArray(imported.exercises)
  )
    return plansToExport(imported, "");
  throw new Error("That file has no Raw Muscle plans");
}

/** Import the plans from a plans export (or a full backup) into the local data.
 *
 * mode "add" keeps every plan on the phone and adds only the plans it doesn't
 * have yet: a plan is already here when its uid matches, or (for files from
 * before uids) when its week already has a plan of that name. A plan already
 * here is skipped when identical, else updated to the file's version. Folders, blocks
 * and weeks are matched the same way, by uid, then by name. A block or folder
 * already on the phone stays where it is here, even if the file has it
 * somewhere else. Files from before folders put everything outside them.
 * mode "replace" deletes every plan, folder, block and week first and takes the file's
 * list as it is. Logged workouts are kept either way.
 *
 * Exercises are matched by name and created when missing.
 * Returns { added, updated, skipped, groups } (groups: new folders, blocks
 * and weeks). */
function importPlans(data, imported, mode = "add") {
  const file = importedPlansFile(imported);
  const plans = file.plans;
  ensureUids(data);
  const groupsBefore = data.groups.length + data.folders.length;
  if (mode === "replace") {
    data.plans = [];
    data.groups = [];
    data.folders = [];
  }
  const existingPlans = [...data.plans];
  const uidsInUse = () =>
    new Set(
      [...data.plans, ...data.groups, ...data.folders].map((item) => item.uid),
    );
  /** The imported uid when it's usable and free here, else a new one. */
  const takeUid = (uid) =>
    typeof uid === "string" && uid && !uidsInUse().has(uid) ? uid : newUid();

  const exerciseId = (exercise) => {
    const name = String(exercise?.name || "").trim();
    if (!name) return null;
    const found = data.exercises.find(
      (e) => e.name.toLowerCase() === name.toLowerCase(),
    );
    if (found) return found.id;
    const created = {
      id: data.nextIds.exercise++,
      name,
      muscle_group: exercise.muscle_group || "other",
      equipment: exercise.equipment || "",
      notes: "",
    };
    data.exercises.push(created);
    return created.id;
  };
  /** Find or create the folder a plan was exported from. */
  const importedFolderId = (folderName, uid) => {
    const name = String(folderName || "").trim();
    if (!name) return null;
    uid = typeof uid === "string" && uid ? uid : null;
    let folder =
      (uid && data.folders.find((f) => f.uid === uid)) ||
      data.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (folder) {
      // Matched by name: take the file's uid so a later rename still matches.
      if (uid && folder.uid !== uid && !uidsInUse().has(uid)) folder.uid = uid;
    } else {
      folder = { id: data.nextIds.folder++, uid: takeUid(uid), name };
      data.folders.push(folder);
    }
    return folder.id;
  };
  /** Find or create the block and week a plan was exported from. A new block
   * goes in `folderId`; a block of the same name only matches in that folder. */
  /** Find or create a block (parentId null, in `folderId`) or a week (in
   * block `parentId`). A block of the same name only matches in that folder. */
  const importedGroupId = (rawName, uid, parentId, folderId) => {
    const name = String(rawName || "").trim();
    if (!name) return null;
    uid = typeof uid === "string" && uid ? uid : null;
    const atLevel = data.groups.filter((g) =>
      parentId == null ? g.parent_id == null : g.parent_id === parentId,
    );
    let group =
      (uid && atLevel.find((g) => g.uid === uid)) ||
      atLevel.find(
        (g) =>
          g.name.toLowerCase() === name.toLowerCase() &&
          (parentId != null || (g.folder_id ?? null) === folderId),
      );
    if (group) {
      // Matched by name: take the file's uid so a later rename still matches.
      if (uid && group.uid !== uid && !uidsInUse().has(uid)) group.uid = uid;
    } else {
      group = { id: data.nextIds.group++, uid: takeUid(uid), name, parent_id: parentId };
      if (parentId == null) group.folder_id = folderId;
      data.groups.push(group);
    }
    return group.id;
  };
  /** Find or create the block and week a plan was exported from. */
  const importedWeekId = (path, uids, folderId) => {
    if (!Array.isArray(path) || path.length !== 2) return null;
    const blockId = importedGroupId(path[0], Array.isArray(uids) ? uids[0] : null, null, folderId);
    if (blockId == null) return null;
    return importedGroupId(path[1], Array.isArray(uids) ? uids[1] : null, blockId, null);
  };

  // Folders, blocks and weeks first, so empty ones come across too.
  const structure = file.structure && typeof file.structure === "object" ? file.structure : {};
  const list = (key) => (Array.isArray(structure[key]) ? structure[key] : []);
  list("folders").forEach((f) => importedFolderId(f?.name, f?.uid));
  const blockIds = new Map(); // the file's block uid, or name, to its id here
  list("blocks").forEach((b) => {
    const folderId = b?.folder ? importedFolderId(b.folder, b.folder_uid) : null;
    const id = importedGroupId(b?.name, b?.uid, null, folderId);
    if (id == null) return;
    if (b.uid) blockIds.set(`uid:${b.uid}`, id);
    blockIds.set(`name:${String(b.name).trim().toLowerCase()}`, id);
  });
  list("weeks").forEach((w) => {
    const blockId =
      blockIds.get(`uid:${w?.block_uid}`) ?? blockIds.get(`name:${String(w?.block || "").trim().toLowerCase()}`);
    if (blockId != null) importedGroupId(w.name, w.uid, blockId, null);
  });
  /** Plans side by side: the same week, or (outside weeks) the same folder. */
  const sameSpot = (p, groupId, folderId) =>
    (p.group_id ?? null) === groupId &&
    (groupId != null || (p.folder_id ?? null) === folderId);
  // Names only need to be unique within a week: every week can have "Day 1".
  // `self` is a plan being renamed, whose own name doesn't count.
  const freeName = (name, groupId, folderId, self = null) => {
    const taken = new Set(
      data.plans
        .filter((p) => p !== self && sameSpot(p, groupId, folderId))
        .map((p) => p.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`.toLowerCase())) n++;
    return `${name} (${n})`;
  };

  const itemsOf = (plan) => {
    const items = [];
    (plan.items || []).forEach((item) => {
      const id = exerciseId(item.exercise);
      if (id === null || items.some((it) => it.exercise_id === id)) return;
      items.push({
        exercise_id: id,
        target_sets: Number(item.target_sets) || 0,
        target_reps: Number(item.target_reps) || 0,
        target_rpe: item.target_rpe == null ? null : Number(item.target_rpe),
        rest_seconds: Number(item.rest_seconds) || 0,
      });
    });
    return items;
  };
  const sameItems = (a, b) => {
    const key = (items) =>
      JSON.stringify(
        items.map((it) => [it.exercise_id, it.target_sets, it.target_reps, it.target_rpe ?? null, it.rest_seconds]),
      );
    return key(a) === key(b);
  };

  /** The file's version of a plan the phone already has: identical is
   * skipped; otherwise the phone's plan takes the file's name, notes and
   * exercises, and stays where it is (with its workout history). */
  const update = (existing, plan, name) => {
    const items = itemsOf(plan);
    const notes = plan.notes || "";
    if (existing.name === name && (existing.notes || "") === notes && sameItems(existing.items, items))
      return false;
    if (existing.name !== name)
      existing.name = freeName(name, existing.group_id ?? null, existing.folder_id ?? null, existing);
    existing.notes = notes;
    existing.items = items;
    return true;
  };

  let added = 0;
  let updated = 0;
  plans.forEach((plan) => {
    const name = String(plan.name || "").trim() || "Imported plan";
    const uid = typeof plan.uid === "string" && plan.uid ? plan.uid : null;
    const sameUid = uid && existingPlans.find((p) => p.uid === uid);
    if (sameUid) {
      if (update(sameUid, plan, name)) updated++;
      return;
    }
    const folderId = importedFolderId(plan.folder, plan.folder_uid);
    const groupId = importedWeekId(plan.group, plan.group_uids, folderId);
    // A plan in a week is in its block's folder; only loose plans keep one.
    const ownFolder = groupId == null ? folderId : null;
    const sameName = existingPlans.find(
      (p) =>
        sameSpot(p, groupId, ownFolder) &&
        p.name.toLowerCase() === name.toLowerCase(),
    );
    if (sameName) {
      if (uid && !uidsInUse().has(uid)) sameName.uid = uid;
      if (update(sameName, plan, sameName.name)) updated++;
      return;
    }
    const items = itemsOf(plan);
    data.plans.push({
      id: data.nextIds.plan++,
      uid: takeUid(uid),
      name: freeName(name, groupId, ownFolder),
      notes: plan.notes || "",
      group_id: groupId,
      folder_id: ownFolder,
      created_at: nowTs(),
      items,
    });
    added++;
  });
  return {
    added,
    updated,
    skipped: plans.length - added - updated,
    // New folders, blocks and weeks, with plans in or not.
    groups: data.groups.length + data.folders.length - groupsBefore,
  };
}

/** Check a parsed backup and rebuild it as a clean data object. */
function backupToData(imported) {
  const lists = ["exercises", "plans", "sessions"];
  if (
    imported?.version !== 1 ||
    !lists.every((k) => Array.isArray(imported[k]))
  ) {
    throw new Error("That file is not a Raw Muscle backup");
  }
  const groups = Array.isArray(imported.groups) ? imported.groups : [];
  const folders = Array.isArray(imported.folders) ? imported.folders : [];
  return {
    version: 1,
    // Derived rather than trusted, so new records can never reuse an id.
    nextIds: {
      exercise: maxId(imported.exercises) + 1,
      plan: maxId(imported.plans) + 1,
      group: maxId(groups) + 1,
      folder: maxId(folders) + 1,
      session: maxId(imported.sessions) + 1,
      set:
        maxId(imported.sessions.flatMap((session) => session.sets || [])) + 1,
    },
    exercises: imported.exercises,
    plans: imported.plans.map((plan) => ({ ...plan, items: plan.items || [] })),
    groups,
    folders,
    sessions: imported.sessions.map((session) => ({
      ...session,
      sets: session.sets || [],
    })),
    last_export: imported.exported_at
      ? imported.exported_at.slice(0, 19).replace("T", " ")
      : null,
  };
}

// The keyboard's Go/Done key on a one-field sheet presses its main button.
document.addEventListener("keydown", (ev) => {
  const action = ev.target.dataset?.enter;
  if (ev.key !== "Enter" || !action) return;
  ev.preventDefault();
  $(`#sheet-foot [data-action="${action}"]`)?.click();
});

// "toggle" doesn't bubble, so listen in the capture phase.
document.addEventListener(
  "toggle",
  (ev) => {
    const plan = Number(ev.target.dataset?.plan);
    if (!plan) return;
    const id = `p${plan}`;
    if (ev.target.open) state.openGroups.add(id);
    else state.openGroups.delete(id);
    saveOpenGroups();
  },
  true,
);

$("#hide-warmups").addEventListener("change", (ev) => {
  state.hideWarmups = ev.target.checked;
  savePref("hide-warmups", state.hideWarmups);
  renderHistory();
});

$("#history-filter").addEventListener("change", (ev) => {
  state.historyExercise = ev.target.value ? Number(ev.target.value) : null;
  renderHistory();
});

$("#import-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("That file is not a Raw Muscle backup");
    }
    const data = backupToData(parsed);
    const count = data.sessions.length;
    if (
      !(await ask(
        `Replace everything on this phone with this backup (${count} workout${count === 1 ? "" : "s"})?`,
        "Replace",
      ))
    )
      return;
    await writeLocalData(data);
    stopRest();
    $("#topbar-note").textContent = "";
    state.session = null;
    syncWakeLock();
    state.exercises = await api("/exercises");
    closeSheet();
    toast("Backup restored");
    refresh();
  } catch (err) {
    toast(err.message || "Could not import backup");
  }
});

$("#import-plans-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error("That file has no Raw Muscle plans");
    }
    await offerPlansImport(parsed, "file");
  } catch (err) {
    toast(err.message || "Could not import plans");
  }
});

// Keep the session's elapsed time honest without a full re-render.
setInterval(() => {
  if (!state.session || state.view !== "train") return;
  if (state.inSession)
    $("#session-meta").textContent = sessionMeta(state.session);
  else renderCurrentSession();
}, 30000);

(async function boot() {
  keepPlansFromAddress();
  renderInstallGate();
  if (isGated) {
    // Nothing to run until installed, but the service worker is what makes the
    // browser offer the install dialog.
    navigator.serviceWorker?.register("sw.js").catch(() => {});
    return;
  }
  try {
    state.exercises = await api("/exercises");
  } catch (err) {
    toast("Could not open local data");
  }
  // Reopening mid-workout goes straight back into it.
  const active = await api("/sessions/active").catch(() => null);
  const stack = currentStack(); // kept across a reload
  const wanted = active
    ? stack[stack.length - 1] === "session"
      ? stack
      : ["session"]
    : stack.filter((screen) => screen !== "session");
  if (wanted.join() === stack.join()) showScreen(stack);
  else navigate(wanted);
  offerPendingPlans();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      toast("Offline mode unavailable");
    });
  }
  // Ask the browser not to clear our data when the phone is short on space.
  navigator.storage?.persist?.().catch(() => {});
})();
