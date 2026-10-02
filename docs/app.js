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
  openGroups: new Set(loadPref("open-groups", [])), // expanded on the Plans tab
  session: null,
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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --------------------------------------------------------------- utilities

const SEED_EXERCISES = [
  ["Back Squat", "legs", "barbell"],
  ["Deadlift", "back", "barbell"],
  ["Bench Press", "chest", "barbell"],
  ["Overhead Press", "shoulders", "barbell"],
  ["Barbell Row", "back", "barbell"],
  ["Pull Up", "back", "bodyweight"],
  ["Chin Up", "arms", "bodyweight"],
  ["Dip", "chest", "bodyweight"],
  ["Romanian Deadlift", "legs", "barbell"],
  ["Leg Press", "legs", "machine"],
  ["Leg Curl", "legs", "machine"],
  ["Lat Pulldown", "back", "cable"],
  ["Seated Cable Row", "back", "cable"],
  ["Dumbbell Bench Press", "chest", "dumbbell"],
  ["Incline Dumbbell Press", "chest", "dumbbell"],
  ["Lateral Raise", "shoulders", "dumbbell"],
  ["Face Pull", "shoulders", "cable"],
  ["Bicep Curl", "arms", "dumbbell"],
  ["Tricep Pushdown", "arms", "cable"],
  ["Plank", "core", "bodyweight"],
  ["Hanging Leg Raise", "core", "bodyweight"],
  ["Calf Raise", "legs", "machine"],
];

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
  return {
    ...plan,
    exercise_count: plan.items.length,
    last_done: last?.started_at || null,
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
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);
    result = {
      sessions_total: data.sessions.filter((session) => session.finished_at)
        .length,
      sessions_7d: recent.length,
      volume_7d: sets.reduce((sum, set) => sum + set.reps * set.weight, 0),
      personal_bests: best,
    };
  } else throw new Error("Unknown local data request");
  if (method !== "GET") await writeLocalData(data);
  return result;
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
        !confirm(
          `Remove ${item.name} and its ${logged} logged set${logged === 1 ? "" : "s"}?`,
        )
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
  const source = ev.target.closest("[data-move]");
  if (!source || ev.target.closest("button, input, select, a")) return;
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
  // Open where it went so it can be seen there.
  if (folder) state.openGroups.add(`f${folder}`);
  if (where === "week") state.openGroups.add(whereId);
  saveOpenGroups();
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
  gate.innerHTML = justInstalled
    ? `<img class="brand-logo" src="icons/icon-192.png" alt="" />
       <h1>Raw Muscle Gym Tracker</h1>
       <p class="muted">Installed. Open <strong>Raw Muscle</strong> from your home
         screen to start.</p>`
    : `<img class="brand-logo" src="icons/icon-192.png" alt="" />
       <h1>Raw Muscle Gym Tracker</h1>
       <p class="muted">Install the app to use it. It opens full screen and
         works with no connection${isIos() ? ", and Safari won't clear your workouts" : ""}.</p>
       <button class="btn" data-action="${installPrompt ? "install-app" : "install-help"}">Install app</button>`;
}

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

function renderStats(stats) {
  const best = stats.personal_bests
    .map(
      (b) => `
    <div class="spread"><span>${esc(b.name)}</span>
    <span class="pill">${fmtWeight(b.weight)} ${unitLabel()}</span></div>`,
    )
    .join("");
  $("#stats").innerHTML = `
    <h2>Last 7 days</h2>
    <div class="row wrap" style="margin-top:8px">
      <span class="pill">${stats.sessions_7d} session${stats.sessions_7d === 1 ? "" : "s"}</span>
      <span class="pill">${fmtWeight(stats.volume_7d)} ${unitLabel()} volume</span>
      <span class="pill">${stats.sessions_total} total</span>
    </div>
    ${best ? `<h3 style="margin-top:14px">Heaviest sets</h3><div class="stack tight" style="margin-top:6px">${best}</div>` : ""}`;
}

function renderActiveSession() {
  const s = state.session;
  $("#session-name").textContent = s.name;
  $("#session-meta").textContent = sessionMeta(s);

  $("#exercise-list").innerHTML =
    s.items
      .map((item) => {
        const sets = s.sets.filter((x) => x.exercise_id === item.exercise_id);
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
      <article class="exercise" data-drag-item>
        <div class="exercise-head${done ? " done" : ""}">
          ${GRIP}
          <div class="grow">
            <h3>${esc(item.name)}</h3>
            <div class="target">${target} &middot; rest ${item.rest_seconds}s</div>
            ${
              prev
                ? `<div class="prev">Last: ${prev.reps} &times; ${fmtWeight(prev.weight)} ${unitLabel()}
              (${esc(dayLabel(prev.started_at))})</div>`
                : ""
            }
          </div>
          <span class="pill">${working}${item.target_sets ? `/${item.target_sets}` : ""}</span>
        </div>
        ${
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
      </article>`;
      })
      .join("") || '<p class="empty">Add an exercise to get going.</p>';
}

// ------------------------------------------------------------ view: plans

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Plans tab: folders first, each holding blocks and plans, then blocks
 * outside any folder (each holding weeks, each holding plans), then plans in
 * neither. Folders are optional: without any, the tab is just blocks. */
function renderPlans() {
  const weeks = new Set(
    state.groups.filter((g) => g.parent_id != null).map((g) => g.id),
  );
  const plansIn = (id) =>
    state.plans.filter((p) => (weeks.has(p.group_id) ? p.group_id : null) === id);
  const blocks = state.groups.filter((g) => g.parent_id == null);
  const blocksIn = (folderId) =>
    blocks.filter((b) => (b.folder_id ?? null) === folderId);
  const looseIn = (folderId) =>
    plansIn(null).filter((p) => (p.folder_id ?? null) === folderId);

  // Folders share openGroups with blocks and weeks, keyed "f<id>". `drop`
  // makes it a place to drop a held plan or block; `move` lets a block or
  // folder be held.
  const groupHtml = (
    group,
    inner,
    count,
    tools,
    { key = group.id, kind = "group", drop = "", move = "" } = {},
  ) => `
    <details class="group${kind === "folder" ? " folder" : ""}" data-${kind}="${group.id}"${drop ? ` data-drop="${drop}"` : ""}${move ? ` data-order="${move}"` : ""}${state.openGroups.has(key) ? " open" : ""}>
      <summary${move ? ` data-move="${move}"` : ""}>
        <span class="chev" aria-hidden="true"></span>
        <span class="grow group-name">${esc(group.name)}</span>
        <span class="pill">${count}</span>
      </summary>
      <div class="group-body stack">
        ${inner}
        <div class="row wrap">${tools}</div>
      </div>
    </details>`;
  const editTools = (group, kind = "group") => `
    <button class="btn small ghost" data-action="rename-${kind}" data-id="${group.id}">Rename</button>
    <button class="btn small danger" data-action="del-${kind}" data-id="${group.id}">Delete</button>`;

  const blockHtml = (block) => {
    const blockWeeks = state.groups.filter((g) => g.parent_id === block.id);
    const weeksHtml = blockWeeks
      .map((week) => {
        const plans = plansIn(week.id);
        return groupHtml(
          week,
          plans.map(planCardHtml).join("") ||
            '<p class="muted">No plans in this week yet.</p>',
          plural(plans.length, "plan"),
          `<button class="btn small ghost" data-action="new-plan" data-group="${week.id}">+ Plan</button>
          ${editTools(week)}`,
          { drop: `week:${week.id}` },
        );
      })
      .join("");
    return groupHtml(
      block,
      weeksHtml || '<p class="muted">No weeks in this block yet.</p>',
      plural(blockWeeks.length, "week"),
      `<button class="btn small ghost" data-action="new-week" data-parent="${block.id}">+ Week</button>
      ${editTools(block)}`,
      { move: `block:${block.id}` },
    );
  };

  const foldersHtml = state.folders
    .map((folder) => {
      const inBlocks = blocksIn(folder.id);
      const loose = looseIn(folder.id);
      const blockIds = new Set(inBlocks.map((b) => b.id));
      const count = state.plans.filter((p) => {
        const week = state.groups.find((g) => g.id === p.group_id && weeks.has(g.id));
        return week ? blockIds.has(week.parent_id) : p.folder_id === folder.id;
      }).length;
      return groupHtml(
        folder,
        inBlocks.map(blockHtml).join("") + loose.map(planCardHtml).join("") ||
          '<p class="muted">Nothing in this folder yet.</p>',
        plural(count, "plan"),
        // Adding things gets a full-width row; managing the folder the next.
        `<div class="row fill">
          <button class="btn small ghost" data-action="new-block" data-folder="${folder.id}">+ Block</button>
          <button class="btn small ghost" data-action="new-plan" data-folder="${folder.id}">+ Plan</button>
        </div>
        <div class="row">
          <button class="btn small ghost" data-action="copy-folder" data-id="${folder.id}">Duplicate</button>
          ${editTools(folder, "folder")}
        </div>`,
        {
          key: `f${folder.id}`,
          kind: "folder",
          drop: `folder:${folder.id}`,
          move: `folder:${folder.id}`,
        },
      );
    })
    .join("");

  const loose = looseIn(null);
  const looseHtml = loose.length
    ? `${blocks.length || state.folders.length ? '<h3 class="group-label">Other plans</h3>' : ""}${loose.map(planCardHtml).join("")}`
    : "";

  $("#plan-list").innerHTML =
    foldersHtml + blocksIn(null).map(blockHtml).join("") + looseHtml ||
    '<p class="empty">No plans yet.<br>A plan is a named list of exercises with targets.<br>Group plans into blocks and weeks with + New block, and blocks into folders with + New folder.</p>';
}

function planCardHtml(p) {
  return `
        <div class="card" data-move="plan:${p.id}" data-order="plan:${p.id}">
          <div class="spread">
            <div class="grow">
              <h2>${esc(p.name)}</h2>
              <span class="muted">${p.exercise_count} exercise${p.exercise_count === 1 ? "" : "s"}${
                p.last_done
                  ? ` &middot; last ${esc(dayLabel(p.last_done))}`
                  : ""
              }</span>
            </div>
          </div>
          ${p.notes ? `<p class="muted">${esc(p.notes)}</p>` : ""}
          <div class="row" style="margin-top:12px">
            <button class="btn small ghost" data-action="edit-plan" data-id="${p.id}">Edit</button>
            <button class="btn small danger" data-action="del-plan" data-id="${p.id}">Delete</button>
            <button class="btn small ghost" style="margin-left:auto" data-action="start-plan" data-id="${p.id}">Start</button>
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
  setView(state.inSession ? "train" : top);
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
    if (!confirm("Discard this session and everything logged in it?")) return;
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
      const folder = await api("/folders", { method: "POST", body: { name } });
      state.openGroups.add(`f${folder.id}`);
      saveOpenGroups();
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
    const folder = await api(`/folders/${el.dataset.id}/copy`, {
      method: "POST",
      body: { name },
    });
    state.openGroups.add(`f${folder.id}`);
    saveOpenGroups();
    closeSheet();
    toast(`Made ${name}`);
    refresh();
  },

  async "del-folder"(el) {
    const folder = state.folders.find((f) => f.id === Number(el.dataset.id));
    if (!folder) return;
    if (
      !confirm(
        `Delete the folder ${folder.name}? Its blocks and plans are kept, outside any folder.`,
      )
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
      const group = await api("/groups", {
        method: "POST",
        body: { ...body, parent_id: parentId },
      });
      // Show what was just made.
      state.openGroups.add(group.id);
      if (parentId) state.openGroups.add(parentId);
      if (group.folder_id) state.openGroups.add(`f${group.folder_id}`);
      saveOpenGroups();
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
    if (!confirm(`Delete ${what}? Its plans are kept under Other plans.`))
      return;
    await api(`/groups/${group.id}`, { method: "DELETE" });
    refresh();
  },

  async "edit-plan"(el) {
    openPlanEditor(await api(`/plans/${el.dataset.id}`));
  },

  async "del-plan"(el) {
    if (!confirm("Delete this plan? Logged workouts are kept.")) return;
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
    if (!confirm("Delete this workout for good?")) return;
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

  "export-plans"() {
    const data = dataCache;
    if (!data?.plans.length) return toast("No plans to export");
    ensureGroups(data);
    const folders = data.folders
      .map((folder) => ({
        folder,
        count: data.plans.filter((p) => planFolderId(data, p) === folder.id)
          .length,
      }))
      .filter((f) => f.count)
      .sort((a, b) => byName(a.folder, b.folder));
    if (!folders.length) return exportPlansFile(data, null);
    // A tap on the sheet starts the share, which browsers only allow right
    // after a tap.
    openSheet(
      "Export plans",
      '<p class="muted">Export every plan, or just one folder.</p>',
      `<div class="stack tight">
        <button class="btn good" data-action="export-plans-go" data-folder="">All plans (${data.plans.length})</button>
        ${folders
          .map(
            ({ folder, count }) =>
              `<button class="btn ghost" data-action="export-plans-go" data-folder="${folder.id}">${esc(folder.name)} (${count})</button>`,
          )
          .join("")}
      </div>`,
    );
  },

  async "export-plans-go"(el) {
    const data = dataCache;
    if (!data) return closeSheet();
    const folder = el.dataset.folder ? Number(el.dataset.folder) : null;
    closeSheet();
    await exportPlansFile(data, folder);
  },

  "import-plans"() {
    $("#import-plans-file").click();
  },

  async "import-plans-add"() {
    await finishPlansImport("add");
  },

  async "import-plans-replace"() {
    const count = state.plans.length;
    if (
      count &&
      !confirm(
        `Delete all ${plural(count, "plan")}, folders and blocks on this phone and use the file's list instead? Logged workouts are kept.`,
      )
    )
      return;
    await finishPlansImport("replace");
  },

  "close-sheet"() {
    closeSheet();
  },
};

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

/** Apply the plans file waiting in state.pendingPlans. */
async function finishPlansImport(mode) {
  const parsed = state.pendingPlans;
  if (!parsed) return closeSheet();
  const data = await localData();
  const { added, skipped } = importPlans(data, parsed, mode);
  await writeLocalData(data);
  closeSheet();
  toast(
    mode === "replace"
      ? `Plans replaced with ${plural(added, "plan")}`
      : added
        ? `Added ${plural(added, "new plan")}` +
          (skipped ? `, ${skipped} already here` : "")
        : "No new plans; you have them all",
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
 * With `onlyFolder` (a folder id) just that folder's plans go in the file. */
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
  return {
    kind: "gym-planner-plans",
    version: 1,
    exported_at: stamp,
    ...(only ? { folder: { uid: only.uid || null, name: only.name } } : {}),
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
function importedPlansList(imported) {
  if (imported?.kind === "gym-planner-plans" && Array.isArray(imported.plans))
    return imported.plans;
  if (
    imported?.version === 1 &&
    Array.isArray(imported.plans) &&
    Array.isArray(imported.exercises)
  )
    return plansToExport(imported, "").plans;
  throw new Error("That file has no Raw Muscle plans");
}

/** Import the plans from a plans export (or a full backup) into the local data.
 *
 * mode "add" keeps every plan on the phone and adds only the plans it doesn't
 * have yet: a plan is already here when its uid matches, or (for files from
 * before uids) when its week already has a plan of that name. Folders, blocks
 * and weeks are matched the same way, by uid, then by name. A block or folder
 * already on the phone stays where it is here, even if the file has it
 * somewhere else. Files from before folders put everything outside them.
 * mode "replace" deletes every plan, folder, block and week first and takes the file's
 * list as it is. Logged workouts are kept either way.
 *
 * Exercises are matched by name and created when missing.
 * Returns { added, skipped }. */
function importPlans(data, imported, mode = "add") {
  const plans = importedPlansList(imported);
  ensureUids(data);
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
  const importedWeekId = (path, uids, folderId) => {
    if (!Array.isArray(path) || path.length !== 2) return null;
    let parentId = null;
    for (let i = 0; i < 2; i++) {
      const name = String(path[i] || "").trim();
      if (!name) return null;
      const uid = Array.isArray(uids) ? uids[i] : null;
      const atLevel = data.groups.filter((g) =>
        i === 0 ? g.parent_id == null : g.parent_id === parentId,
      );
      let group =
        (uid && atLevel.find((g) => g.uid === uid)) ||
        atLevel.find(
          (g) =>
            g.name.toLowerCase() === name.toLowerCase() &&
            (i > 0 || (g.folder_id ?? null) === folderId),
        );
      if (group) {
        // Matched by name: take the file's uid so a later rename still matches.
        if (uid && group.uid !== uid && !uidsInUse().has(uid)) group.uid = uid;
      } else {
        group = {
          id: data.nextIds.group++,
          uid: takeUid(uid),
          name,
          parent_id: parentId,
        };
        if (i === 0) group.folder_id = folderId;
        data.groups.push(group);
      }
      parentId = group.id;
    }
    return parentId;
  };
  /** Plans side by side: the same week, or (outside weeks) the same folder. */
  const sameSpot = (p, groupId, folderId) =>
    (p.group_id ?? null) === groupId &&
    (groupId != null || (p.folder_id ?? null) === folderId);
  // Names only need to be unique within a week: every week can have "Day 1".
  const freeName = (name, groupId, folderId) => {
    const taken = new Set(
      data.plans
        .filter((p) => sameSpot(p, groupId, folderId))
        .map((p) => p.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`.toLowerCase())) n++;
    return `${name} (${n})`;
  };

  let added = 0;
  plans.forEach((plan) => {
    const name = String(plan.name || "").trim() || "Imported plan";
    const uid = typeof plan.uid === "string" && plan.uid ? plan.uid : null;
    if (uid && existingPlans.some((p) => p.uid === uid)) return;
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
      return;
    }
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
  return { added, skipped: plans.length - added };
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
    const folder = Number(ev.target.dataset?.folder);
    const id = folder ? `f${folder}` : Number(ev.target.dataset?.group);
    if (!id) return;
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
      !confirm(
        `Replace everything on this phone with this backup (${count} workout${count === 1 ? "" : "s"})?`,
      )
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
    // A dry run on a copy, to say how many are new before anything changes.
    const { added, skipped } = importPlans(
      structuredClone(await localData()),
      parsed,
    );
    openSheet(
      "Import plans",
      `<p>This file has ${parsed.folder?.name ? `the folder ${esc(String(parsed.folder.name))} with ` : ""}${plural(added + skipped, "plan")}.
        ${added ? `${added} ${added === 1 ? "is" : "are"} new.` : "You already have all of them."}</p>
      <p class="muted"><strong>Add new plans</strong> keeps your plans and adds
        only the ones you don't have, into their folders, blocks and weeks.
        <strong>Overwrite all plans</strong> deletes your plans, folders, blocks
        and weeks and uses the file's list instead. Logged workouts are kept.</p>`,
      `<div class="stack tight">
        <button class="btn good" data-action="import-plans-add">Add new plans</button>
        <button class="btn danger" data-action="import-plans-replace">Overwrite all plans</button>
      </div>`,
    );
    state.pendingPlans = parsed;
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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      toast("Offline mode unavailable");
    });
  }
  // Ask the browser not to clear our data when the phone is short on space.
  navigator.storage?.persist?.().catch(() => {});
})();
