/* Gym Planner front end.
 *
 * Deliberately dependency-free: one state object, a render per view, and click
 * delegation off the document. Small enough to read in one sitting, which is the
 * point for a personal app.
 */

const state = {
  view: "train",
  exercises: [],
  plans: [],
  groups: [], // blocks (parent_id null) and the weeks inside them
  openGroups: loadOpenGroups(), // group ids expanded on the Plans tab
  session: null,
  inSession: false, // the session screen is showing (vs. just running)
  sessionFrom: "train", // tab the back button returns to from the session
  history: [],
  historyExercise: null, // exercise id the History list is filtered to
  draft: null, // plan being edited in the sheet
  rest: null, // { until: epochMs, timer: intervalId }
};

function loadOpenGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem("open-groups") || "[]"));
  } catch {
    return new Set();
  }
}

function saveOpenGroups() {
  try {
    localStorage.setItem("open-groups", JSON.stringify([...state.openGroups]));
  } catch {
    // Only remembers which groups are expanded; fine to lose.
  }
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

/** Plan groups arrived after version 1 data, so older data has none. */
function ensureGroups(data) {
  if (!Array.isArray(data.groups)) data.groups = [];
  if (!data.nextIds.group) data.nextIds.group = maxId(data.groups) + 1;
}

/** Natural order, so "Week 10" comes after "Week 9". */
const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });

/** Plans live in a week (a group with a parent block) or in no group. */
function weekId(data, id) {
  const week = data.groups.find((g) => g.id === Number(id));
  return week && week.parent_id != null ? week.id : null;
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
      .sort(byName);
  else if (path === "/plans" && method === "POST") {
    const plan = {
      id: data.nextIds.plan++,
      name: body.name.trim(),
      notes: body.notes || "",
      group_id: weekId(data, body.group_id),
      created_at: nowTs(),
      items: body.items || [],
    };
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
    Object.assign(plan, {
      name: body.name.trim(),
      notes: body.notes || "",
      group_id: weekId(data, body.group_id),
      items: body.items || [],
    });
    result = plan;
  } else if (match(/^\/plans\/(\d+)$/) && method === "DELETE") {
    const id = Number(match(/^\/plans\/(\d+)$/)[1]);
    data.plans = data.plans.filter((plan) => plan.id !== id);
    result = null;
  } else if (path === "/groups" && method === "GET")
    result = [...data.groups].sort(byName);
  else if (path === "/groups" && method === "POST") {
    const parent =
      body.parent_id == null ? null : findGroup(data, body.parent_id);
    if (parent && parent.parent_id != null)
      throw new Error("Weeks can only go inside a block");
    const group = {
      id: data.nextIds.group++,
      name: body.name.trim(),
      parent_id: parent ? parent.id : null,
    };
    data.groups.push(group);
    result = group;
  } else if (match(/^\/groups\/(\d+)$/) && method === "PUT") {
    const group = findGroup(data, match(/^\/groups\/(\d+)$/)[1]);
    group.name = body.name.trim();
    result = group;
  } else if (match(/^\/groups\/(\d+)$/) && method === "DELETE") {
    // A block takes its weeks with it; their plans move to "Other plans".
    const id = Number(match(/^\/groups\/(\d+)$/)[1]);
    const gone = new Set(
      data.groups
        .filter((g) => g.id === id || g.parent_id === id)
        .map((g) => g.id),
    );
    data.groups = data.groups.filter((g) => !gone.has(g.id));
    data.plans.forEach((plan) => {
      if (gone.has(plan.group_id)) plan.group_id = null;
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

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function fmtWeight(w) {
  const n = num(w);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
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

// ------------------------------------------------------------ view: train

/** The Train tab shows the session screen while one is open, otherwise the
 * start page, with a card to get back into a session still running. */
function renderTrain() {
  if (!state.session) closeSession();
  $("#train-idle").hidden = state.inSession;
  $("#train-active").hidden = !state.inSession;
  if (state.inSession) renderActiveSession();
  else renderCurrentSession();
}

function sessionMeta(s) {
  const mins = Math.round((Date.now() - parseTs(s.started_at).getTime()) / 60000);
  const volume = s.sets.reduce((sum, x) => sum + x.reps * x.weight, 0);
  return `${mins} min · ${s.sets.length} sets · ${fmtWeight(volume)} kg`;
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
    <span class="pill">${fmtWeight(b.weight)} kg</span></div>`,
    )
    .join("");
  $("#stats").innerHTML = `
    <h2>Last 7 days</h2>
    <div class="row wrap" style="margin-top:8px">
      <span class="pill">${stats.sessions_7d} session${stats.sessions_7d === 1 ? "" : "s"}</span>
      <span class="pill">${fmtWeight(stats.volume_7d)} kg volume</span>
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
        const prev = s.previous[String(item.exercise_id)];
        const done = item.target_sets > 0 && sets.length >= item.target_sets;

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
                ? `<div class="prev">Last: ${prev.reps} &times; ${fmtWeight(prev.weight)} kg
              (${esc(dayLabel(prev.started_at))})</div>`
                : ""
            }
          </div>
          <span class="pill">${sets.length}${item.target_sets ? `/${item.target_sets}` : ""}</span>
        </div>
        ${
          sets.length
            ? `<div class="setlist">${sets
                .map(
                  (x, i) => `
          <div class="setrow">
            <span class="idx">${i + 1}</span>
            <span>${x.reps} &times; ${fmtWeight(x.weight)} kg${x.rpe != null ? ` · RPE ${x.rpe}` : ""}</span>
            <button class="del" data-action="del-set" data-id="${x.id}"
              aria-label="Delete set">&times;</button>
          </div>`,
                )
                .join("")}</div>`
            : ""
        }
        <div class="logform" data-ex="${item.exercise_id}" data-rest="${item.rest_seconds}">
          <input type="number" inputmode="decimal" step="0.5" min="0"
            data-f="weight" placeholder="kg" value="${fillWeight}">
          <input type="number" inputmode="numeric" step="1" min="0"
            data-f="reps" placeholder="reps" value="${fillReps}">
          <input type="number" inputmode="decimal" step="0.5" min="1" max="10"
            data-f="rpe" placeholder="RPE" value="${fillRpe}">
          <button class="btn" data-action="log" data-ex="${item.exercise_id}">Log</button>
        </div>
      </article>`;
      })
      .join("") || '<p class="empty">Add an exercise to get going.</p>';
}

// ------------------------------------------------------------ view: plans

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Plans tab: blocks, each holding weeks, each holding plans. Plans outside
 * any week are listed after the blocks. */
function renderPlans() {
  const weeks = new Set(
    state.groups.filter((g) => g.parent_id != null).map((g) => g.id),
  );
  const plansIn = (id) =>
    state.plans.filter((p) => (weeks.has(p.group_id) ? p.group_id : null) === id);
  const blocks = state.groups.filter((g) => g.parent_id == null);
  const loose = plansIn(null);

  const groupHtml = (group, inner, count, tools) => `
    <details class="group" data-group="${group.id}"${state.openGroups.has(group.id) ? " open" : ""}>
      <summary>
        <span class="chev" aria-hidden="true"></span>
        <span class="grow group-name">${esc(group.name)}</span>
        <span class="pill">${count}</span>
      </summary>
      <div class="group-body stack">
        ${inner}
        <div class="row wrap">${tools}</div>
      </div>
    </details>`;
  const editTools = (group) => `
    <button class="btn small ghost" data-action="rename-group" data-id="${group.id}">Rename</button>
    <button class="btn small danger" data-action="del-group" data-id="${group.id}">Delete</button>`;

  const blocksHtml = blocks
    .map((block) => {
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
          );
        })
        .join("");
      return groupHtml(
        block,
        weeksHtml || '<p class="muted">No weeks in this block yet.</p>',
        plural(blockWeeks.length, "week"),
        `<button class="btn small ghost" data-action="new-week" data-parent="${block.id}">+ Week</button>
        ${editTools(block)}`,
      );
    })
    .join("");

  const looseHtml = loose.length
    ? `${blocks.length ? '<h3 class="group-label">Other plans</h3>' : ""}${loose.map(planCardHtml).join("")}`
    : "";

  $("#plan-list").innerHTML =
    blocksHtml + looseHtml ||
    '<p class="empty">No plans yet.<br>A plan is a named list of exercises with targets.<br>Group plans into blocks and weeks with + New block.</p>';
}

function planCardHtml(p) {
  return `
        <div class="card">
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
      ${weekSelectHtml(d.group_id)}
      ${items ? `<div class="stack" data-drag-list="plan">${items}</div>` : '<p class="muted">No exercises yet.</p>'}
      <button class="btn ghost" data-action="draft-add">+ Add exercise</button>
    </div>`;
}

const PLAN_SAVE =
  '<button class="btn good" data-action="draft-save">Save plan</button>';

/** Which week the plan sits in, with weeks listed under their block. */
function weekSelectHtml(groupId) {
  const blocks = state.groups.filter((g) => g.parent_id == null);
  const options = blocks
    .map((block) => {
      const weeks = state.groups.filter((g) => g.parent_id === block.id);
      if (!weeks.length) return "";
      return `<optgroup label="${esc(block.name)}">${weeks
        .map(
          (w) =>
            `<option value="${w.id}"${w.id === groupId ? " selected" : ""}>${esc(block.name)} › ${esc(w.name)}</option>`,
        )
        .join("")}</optgroup>`;
    })
    .join("");
  if (!options) return "";
  return `
      <div><label for="draft-group">Week</label>
        <select id="draft-group"><option value="">No week</option>${options}</select></div>`;
}

function openPlanEditor(plan, groupId = null) {
  state.draft = plan
    ? {
        id: plan.id,
        name: plan.name,
        notes: plan.notes,
        group_id: plan.group_id ?? null,
        items: plan.items.map((it) => ({
          exercise_id: it.exercise_id,
          name: it.name,
          target_sets: it.target_sets,
          target_reps: it.target_reps,
          target_rpe: it.target_rpe ?? null,
          rest_seconds: it.rest_seconds,
        })),
      }
    : { id: null, name: "", notes: "", group_id: groupId, items: [] };
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
  if (groupEl) d.group_id = groupEl.value ? Number(groupEl.value) : null;
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

/** Name a new block or week, or rename one. `attrs` tells group-save which. */
function openGroupSheet(title, name, attrs) {
  openSheet(
    title,
    `
    <div><label for="group-name">Name</label>
      <input id="group-name" value="${esc(name)}" maxlength="80"
        enterkeyhint="done" data-enter="group-save"></div>`,
    `<button class="btn good" data-action="group-save" ${attrs}>Save</button>`,
  );
  $("#group-name").select();
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
  $("#history-filter").innerHTML =
    '<option value="">All workouts</option>' +
    options
      .map(
        (e) =>
          `<option value="${e.id}"${e.id === state.historyExercise ? " selected" : ""}>${esc(e.name)}</option>`,
      )
      .join("");
}

/** Every session containing one exercise, newest first, with just its sets. */
function renderExerciseHistory(exerciseId) {
  const sessions = state.history
    .map((s) => ({
      ...s,
      sets: s.sets.filter((x) => x.exercise_id === exerciseId),
    }))
    .filter((s) => s.sets.length);
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
            <span class="pill">top ${fmtWeight(top)} kg</span>
          </div>
          <div class="stack tight" style="margin-top:8px">
            ${s.sets
              .map(
                (x, i) => `<div class="setrow"><span class="idx">${i + 1}</span>
              <span>${x.reps} &times; ${fmtWeight(x.weight)} kg${x.rpe != null ? ` · RPE ${x.rpe}` : ""}</span><span></span></div>`,
              )
              .join("")}
          </div>
        </button>`;
    })
    .join("");
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
            <span class="pill">${fmtWeight(s.volume)} kg</span>
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
        ${sets
          .map(
            (x, i) => `<div class="setrow"><span class="idx">${i + 1}</span>
          <span>${x.reps} &times; ${fmtWeight(x.weight)} kg${x.rpe != null ? ` · RPE ${x.rpe}` : ""}</span><span></span></div>`,
          )
          .join("")}
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

/* The session screen gets its own history entry, so the phone's back button
 * leaves the workout (which keeps running) and returns to the tab it was
 * opened from, instead of closing the app. */
function openSession(from) {
  state.sessionFrom = from;
  state.inSession = true;
  if (!history.state?.session) history.pushState({ session: true }, "");
  setView("train");
}

/** Leave the session screen some other way than the back button. */
function closeSession() {
  if (!state.inSession) return;
  state.inSession = false;
  // Drop our history entry; the popstate this causes finds nothing to do.
  if (history.state?.session) history.back();
}

window.addEventListener("popstate", () => {
  if (!state.inSession) return;
  state.inSession = false;
  closeSheet();
  setView(state.sessionFrom);
});

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
      [state.plans, state.groups] = await Promise.all([
        api("/plans"),
        api("/groups"),
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
    openSession(state.view);
  },

  "select-plan"() {
    setView("plans");
  },

  "continue-session"() {
    openSession("train");
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
    openSession("train");
  },

  async log(el) {
    const form = el.closest(".logform");
    const weight = num(form.querySelector('[data-f="weight"]').value);
    const reps = parseInt(form.querySelector('[data-f="reps"]').value, 10);
    const rpeInput = form.querySelector('[data-f="rpe"]').value;
    const rpe = rpeInput === "" ? null : num(rpeInput);
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
      body: { exercise_id: exerciseId, set_index: done + 1, reps, weight, rpe },
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
    openPlanEditor(null, el.dataset.group ? Number(el.dataset.group) : null);
  },

  "new-block"() {
    const count = state.groups.filter((g) => g.parent_id == null).length;
    openGroupSheet("New block", `Block ${count + 1}`, "");
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
    openGroupSheet(
      group.parent_id == null ? "Rename block" : "Rename week",
      group.name,
      `data-id="${group.id}"`,
    );
  },

  async "group-save"(el) {
    const name = $("#group-name").value.trim();
    if (!name) return toast("Give it a name");
    if (el.dataset.id) {
      await api(`/groups/${el.dataset.id}`, { method: "PUT", body: { name } });
    } else {
      const parentId = el.dataset.parent ? Number(el.dataset.parent) : null;
      const group = await api("/groups", {
        method: "POST",
        body: { name, parent_id: parentId },
      });
      // Show what was just made.
      state.openGroups.add(group.id);
      if (parentId) state.openGroups.add(parentId);
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
    closeSheet();
    refresh();
  },

  async "export-data"() {
    // No awaits before share(): browsers only allow it straight after a tap.
    const data = dataCache;
    if (!data) return toast("Nothing to export yet");
    const stamp = new Date().toISOString();
    const name = `gym-planner-backup-${stamp.slice(0, 10)}`;
    const json = JSON.stringify({ ...data, exported_at: stamp }, null, 2);
    if (!(await shareJson(name, json))) return;
    await writeLocalData({ ...data, last_export: nowTs() });
    toast("Backup exported");
  },

  "import-data"() {
    $("#import-file").click();
  },

  async "export-plans"() {
    // No awaits before share(): browsers only allow it straight after a tap.
    const data = dataCache;
    if (!data?.plans.length) return toast("No plans to export");
    const stamp = new Date().toISOString();
    const name = `gym-planner-plans-${stamp.slice(0, 10)}`;
    const json = JSON.stringify(plansToExport(data, stamp), null, 2);
    if (await shareJson(name, json)) toast("Plans exported");
  },

  "import-plans"() {
    $("#import-plans-file").click();
  },

  "close-sheet"() {
    closeSheet();
  },
};

// -------------------------------------------------------------------- wiring

document.addEventListener("click", async (ev) => {
  const tab = ev.target.closest(".tab");
  if (tab) {
    // Train keeps an open session on screen; any other tab leaves it running.
    if (tab.dataset.view !== "train") closeSession();
    return setView(tab.dataset.view);
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

/** Plans with exercises referenced by name, since ids differ between phones.
 * A plan in a week carries its place as `group: [block name, week name]`. */
function plansToExport(data, stamp) {
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const groupPath = (id) => {
    const week = groups.find((g) => g.id === id && g.parent_id != null);
    const block = week && groups.find((g) => g.id === week.parent_id);
    return block ? [block.name, week.name] : null;
  };
  return {
    kind: "gym-planner-plans",
    version: 1,
    exported_at: stamp,
    plans: data.plans.map((plan) => ({
      name: plan.name,
      notes: plan.notes || "",
      group: groupPath(plan.group_id),
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
    })),
  };
}

/** Add the plans from a plans export (or a full backup) to the local data.
 * Exercises are matched by name and created when missing; existing plans are
 * never replaced, and a clashing name gets a number. Returns how many were added. */
function addImportedPlans(data, imported) {
  let plans;
  if (imported?.kind === "gym-planner-plans" && Array.isArray(imported.plans)) {
    plans = imported.plans;
  } else if (
    imported?.version === 1 &&
    Array.isArray(imported.plans) &&
    Array.isArray(imported.exercises)
  ) {
    plans = plansToExport(imported, "").plans;
  } else {
    throw new Error("That file has no Gym Planner plans");
  }

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
  ensureGroups(data);
  /** Find or create the block and week a plan was exported from. */
  const importedWeekId = (path) => {
    if (!Array.isArray(path) || path.length !== 2) return null;
    let parentId = null;
    for (const raw of path) {
      const name = String(raw || "").trim();
      if (!name) return null;
      let group = data.groups.find(
        (g) =>
          g.parent_id === parentId &&
          g.name.toLowerCase() === name.toLowerCase(),
      );
      if (!group) {
        group = { id: data.nextIds.group++, name, parent_id: parentId };
        data.groups.push(group);
      }
      parentId = group.id;
    }
    return parentId;
  };
  // Names only need to be unique within a week: every week can have "Day 1".
  const freeName = (name, groupId) => {
    const taken = new Set(
      data.plans
        .filter((p) => (p.group_id ?? null) === groupId)
        .map((p) => p.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`.toLowerCase())) n++;
    return `${name} (${n})`;
  };

  plans.forEach((plan) => {
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
    const groupId = importedWeekId(plan.group);
    data.plans.push({
      id: data.nextIds.plan++,
      name: freeName(String(plan.name || "").trim() || "Imported plan", groupId),
      notes: plan.notes || "",
      group_id: groupId,
      created_at: nowTs(),
      items,
    });
  });
  return plans.length;
}

/** Check a parsed backup and rebuild it as a clean data object. */
function backupToData(imported) {
  const lists = ["exercises", "plans", "sessions"];
  if (
    imported?.version !== 1 ||
    !lists.every((k) => Array.isArray(imported[k]))
  ) {
    throw new Error("That file is not a Gym Planner backup");
  }
  const groups = Array.isArray(imported.groups) ? imported.groups : [];
  return {
    version: 1,
    // Derived rather than trusted, so new records can never reuse an id.
    nextIds: {
      exercise: maxId(imported.exercises) + 1,
      plan: maxId(imported.plans) + 1,
      group: maxId(groups) + 1,
      session: maxId(imported.sessions) + 1,
      set:
        maxId(imported.sessions.flatMap((session) => session.sets || [])) + 1,
    },
    exercises: imported.exercises,
    plans: imported.plans.map((plan) => ({ ...plan, items: plan.items || [] })),
    groups,
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
    const id = Number(ev.target.dataset?.group);
    if (!id) return;
    if (ev.target.open) state.openGroups.add(id);
    else state.openGroups.delete(id);
    saveOpenGroups();
  },
  true,
);

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
      throw new Error("That file is not a Gym Planner backup");
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
    state.exercises = await api("/exercises");
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
      throw new Error("That file has no Gym Planner plans");
    }
    const data = await localData();
    const added = addImportedPlans(data, parsed);
    await writeLocalData(data);
    toast(`Added ${added} plan${added === 1 ? "" : "s"}`);
    refresh();
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
  try {
    state.exercises = await api("/exercises");
  } catch (err) {
    toast("Could not open local data");
  }
  // Reopening mid-workout goes straight back into it.
  const active = await api("/sessions/active").catch(() => null);
  if (active) openSession("train");
  else setView("train");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      toast("Offline mode unavailable");
    });
  }
  // Ask the browser not to clear our data when the phone is short on space.
  navigator.storage?.persist?.().catch(() => {});
})();
