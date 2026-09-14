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
  session: null,
  history: [],
  draft: null, // plan being edited in the sheet
  rest: null, // { until: epochMs, timer: intervalId }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --------------------------------------------------------------- utilities

const SEED_EXERCISES = [
  ["Back Squat", "legs", "barbell"], ["Deadlift", "back", "barbell"],
  ["Bench Press", "chest", "barbell"], ["Overhead Press", "shoulders", "barbell"],
  ["Barbell Row", "back", "barbell"], ["Pull Up", "back", "bodyweight"],
  ["Chin Up", "arms", "bodyweight"], ["Dip", "chest", "bodyweight"],
  ["Romanian Deadlift", "legs", "barbell"], ["Leg Press", "legs", "machine"],
  ["Leg Curl", "legs", "machine"], ["Lat Pulldown", "back", "cable"],
  ["Seated Cable Row", "back", "cable"], ["Dumbbell Bench Press", "chest", "dumbbell"],
  ["Incline Dumbbell Press", "chest", "dumbbell"], ["Lateral Raise", "shoulders", "dumbbell"],
  ["Face Pull", "shoulders", "cable"], ["Bicep Curl", "arms", "dumbbell"],
  ["Tricep Pushdown", "arms", "cable"], ["Plank", "core", "bodyweight"],
  ["Hanging Leg Raise", "core", "bodyweight"], ["Calf Raise", "legs", "machine"],
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
    request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return localDbPromise;
}

async function readLocalData() {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE).objectStore(LOCAL_STORE).get("data");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeLocalData(data) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(LOCAL_STORE, "readwrite")
      .objectStore(LOCAL_STORE).put(data, "data");
    request.onsuccess = () => { dataCache = data; resolve(); };
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
      id: 0, name, muscle_group, equipment, notes: "",
    })),
    plans: [],
    sessions: [],
  };
  data.exercises.forEach((exercise) => { exercise.id = data.nextIds.exercise++; });
  await writeLocalData(data);
  return data;
}

function bodyOf(options) {
  return typeof options.body === "string" ? JSON.parse(options.body) : (options.body || {});
}

const ITEM_FIELDS = ["exercise_id", "target_sets", "target_reps", "target_weight", "rest_seconds"];
const plainItem = (item) => Object.fromEntries(ITEM_FIELDS.map((key) => [key, item[key]]));
const blankItem = (exerciseId) => ({
  exercise_id: exerciseId, target_sets: 0, target_reps: 0, target_weight: null, rest_seconds: 90,
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
  const items = sessionItems(data, session)
    .map((item) => ({ ...item, ...data.exercises.find((e) => e.id === item.exercise_id) }));
  const previous = {};
  items.forEach((item) => {
    const previousSet = data.sessions
      .filter((other) => other.id !== id && other.sets.some((set) => set.exercise_id === item.exercise_id))
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0]?.sets
      .filter((set) => set.exercise_id === item.exercise_id)
      .sort((a, b) => b.weight - a.weight)[0];
    if (previousSet) {
      const previousSession = data.sessions.find((other) => other.sets.includes(previousSet));
      previous[item.exercise_id] = { ...previousSet, started_at: previousSession.started_at };
    }
  });
  const sets = session.sets.map((set) => ({
    ...set, name: data.exercises.find((e) => e.id === set.exercise_id)?.name || "Unknown exercise",
  }));
  return { ...session, sets, items, previous };
}

function planSummary(data, plan) {
  const last = data.sessions.filter((session) => session.plan_id === plan.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  return { ...plan, exercise_count: plan.items.length, last_done: last?.started_at || null };
}

async function api(path, options = {}) {
  const data = await localData();
  const method = options.method || "GET";
  const body = bodyOf(options);
  const match = (pattern) => path.match(pattern);
  let result = null;

  if (path === "/exercises" && method === "GET") result = [...data.exercises].sort((a, b) => a.muscle_group.localeCompare(b.muscle_group) || a.name.localeCompare(b.name));
  else if (path === "/exercises" && method === "POST") {
    if (data.exercises.some((item) => item.name.toLowerCase() === body.name.trim().toLowerCase())) throw new Error("That exercise already exists");
    const exercise = { id: data.nextIds.exercise++, name: body.name.trim(), muscle_group: body.muscle_group || "other", equipment: body.equipment || "", notes: body.notes || "" };
    data.exercises.push(exercise); result = exercise;
  } else if (path === "/plans" && method === "GET") result = data.plans.map((plan) => planSummary(data, plan)).sort((a, b) => a.name.localeCompare(b.name));
  else if (path === "/plans" && method === "POST") {
    const plan = { id: data.nextIds.plan++, name: body.name.trim(), notes: body.notes || "", created_at: nowTs(), items: body.items || [] };
    data.plans.push(plan); result = plan;
  } else if ((match(/^\/plans\/(\d+)$/)) && method === "GET") {
    const plan = data.plans.find((item) => item.id === Number(match(/^\/plans\/(\d+)$/)[1]));
    if (!plan) throw new Error("Plan not found");
    result = { ...plan, items: plan.items.map((item) => ({ ...item, ...data.exercises.find((e) => e.id === item.exercise_id) })) };
  } else if ((match(/^\/plans\/(\d+)$/)) && method === "PUT") {
    const plan = data.plans.find((item) => item.id === Number(match(/^\/plans\/(\d+)$/)[1]));
    if (!plan) throw new Error("Plan not found");
    Object.assign(plan, { name: body.name.trim(), notes: body.notes || "", items: body.items || [] }); result = plan;
  } else if ((match(/^\/plans\/(\d+)$/)) && method === "DELETE") {
    const id = Number(match(/^\/plans\/(\d+)$/)[1]); data.plans = data.plans.filter((plan) => plan.id !== id); result = null;
  } else if (path === "/sessions/active" && method === "GET") {
    const session = data.sessions.filter((item) => !item.finished_at).sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    result = session ? sessionDetail(data, session.id) : null;
  } else if (path === "/sessions" && method === "POST") {
    const plan = data.plans.find((item) => item.id === body.plan_id);
    const session = { id: data.nextIds.session++, plan_id: body.plan_id || null, name: body.name?.trim() || plan?.name || "New session", started_at: nowTs(), finished_at: null, notes: "", items: (plan?.items || []).map(plainItem), sets: [] };
    data.sessions.push(session); result = sessionDetail(data, session.id);
  } else if ((match(/^\/sessions\/(\d+)$/)) && method === "GET") result = sessionDetail(data, Number(match(/^\/sessions\/(\d+)$/)[1]));
  else if ((match(/^\/sessions\/(\d+)\/items$/)) && method === "POST") {
    const session = findSession(data, match(/^\/sessions\/(\d+)\/items$/)[1]);
    session.items = sessionItems(data, session);
    if (!session.items.some((item) => item.exercise_id === body.exercise_id)) session.items.push(blankItem(body.exercise_id));
    result = sessionDetail(data, session.id);
  } else if ((match(/^\/sessions\/(\d+)\/items$/)) && method === "PUT") {
    const session = findSession(data, match(/^\/sessions\/(\d+)\/items$/)[1]);
    const items = sessionItems(data, session);
    const rank = new Map(body.exercise_ids.map((exerciseId, i) => [exerciseId, i]));
    session.items = items.sort((a, b) => (rank.get(a.exercise_id) ?? Infinity) - (rank.get(b.exercise_id) ?? Infinity));
    result = sessionDetail(data, session.id);
  } else if ((match(/^\/sessions\/(\d+)\/items\/(\d+)$/)) && method === "DELETE") {
    const [, sessionId, exerciseId] = match(/^\/sessions\/(\d+)\/items\/(\d+)$/).map(Number);
    const session = findSession(data, sessionId);
    session.items = sessionItems(data, session).filter((item) => item.exercise_id !== exerciseId);
    session.sets = session.sets.filter((set) => set.exercise_id !== exerciseId);
    result = sessionDetail(data, session.id);
  }
  else if ((match(/^\/sessions\/(\d+)\/sets$/)) && method === "POST") {
    const session = data.sessions.find((item) => item.id === Number(match(/^\/sessions\/(\d+)\/sets$/)[1]));
    if (!session) throw new Error("Session not found");
    session.sets.push({ id: data.nextIds.set++, ...body, logged_at: nowTs() }); result = sessionDetail(data, session.id);
  } else if ((match(/^\/sets\/(\d+)$/)) && method === "DELETE") {
    const id = Number(match(/^\/sets\/(\d+)$/)[1]); data.sessions.forEach((session) => { session.sets = session.sets.filter((set) => set.id !== id); });
  } else if ((match(/^\/sessions\/(\d+)\/finish$/)) && method === "POST") {
    const session = data.sessions.find((item) => item.id === Number(match(/^\/sessions\/(\d+)\/finish$/)[1]));
    if (!session) throw new Error("Session not found"); session.finished_at = nowTs(); session.notes = body.notes || ""; result = sessionDetail(data, session.id);
  } else if ((match(/^\/sessions\/(\d+)$/)) && method === "DELETE") {
    const id = Number(match(/^\/sessions\/(\d+)$/)[1]); data.sessions = data.sessions.filter((session) => session.id !== id);
  } else if (path === "/history" && method === "GET") {
    result = [...data.sessions].sort((a, b) => b.started_at.localeCompare(a.started_at)).map((session) => ({ ...session, set_count: session.sets.length, exercise_count: new Set(session.sets.map((set) => set.exercise_id)).size, volume: session.sets.reduce((sum, set) => sum + set.reps * set.weight, 0) }));
  } else if (path === "/stats" && method === "GET") {
    const cutoff = Date.now() - 7 * 86400000;
    const recent = data.sessions.filter((session) => parseTs(session.started_at).getTime() >= cutoff);
    const sets = recent.flatMap((session) => session.sets);
    const best = data.exercises.map((exercise) => ({ name: exercise.name, weight: Math.max(0, ...data.sessions.flatMap((session) => session.sets.filter((set) => set.exercise_id === exercise.id).map((set) => set.weight))) })).filter((item) => item.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 5);
    result = { sessions_total: data.sessions.filter((session) => session.finished_at).length, sessions_7d: recent.length, volume_7d: sets.reduce((sum, set) => sum + set.reps * set.weight, 0), personal_bests: best };
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

function openSheet(title, html) {
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-body").innerHTML = "";
  document.body.style.overflow = "";
  state.draft = null;
}

// ------------------------------------------------------------ drag to sort

/* Press a grip handle and drag: other cards make room where it would land,
 * and a trash bin appears at the bottom of the screen. Dropping on the bin
 * calls onDelete(index); dropping anywhere else calls onMove(from, to).
 * Pointer events cover touch and mouse; the handle has touch-action: none so
 * the page doesn't scroll instead. */

let drag = null;

function dragItems(list) {
  return Array.from(list.children).filter((node) => node.matches("[data-drag-item]"));
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
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
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
    config, list, item, ghost, placeholder, pointerId: ev.pointerId,
    from: dragItems(list).indexOf(item),
    offsetY: ev.clientY - rect.top, y: ev.clientY, overTrash: false,
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
    : { top: $(".topbar").getBoundingClientRect().bottom, bottom: window.innerHeight };
  const bottom = Math.min(box.bottom, $("#trash").getBoundingClientRect().top);
  const zone = 70;
  let speed = 0;
  if (drag.y < box.top + zone) speed = -Math.ceil((box.top + zone - drag.y) / 6);
  else if (drag.y > bottom - zone && drag.y < bottom) speed = Math.ceil((drag.y - (bottom - zone)) / 6);
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
    .filter((node) => node === placeholder || (node.matches("[data-drag-item]") && node !== item))
    .indexOf(placeholder);
  ghost.remove();
  placeholder.remove();
  item.hidden = false;
  $("#trash").hidden = true;
  $("#trash").classList.remove("armed");
  document.body.classList.remove("dragging");
  drag = null;

  if (ev.type === "pointercancel") return;
  const run = overTrash ? config.onDelete(from) : to !== from ? config.onMove(from, to) : null;
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
        method: "PUT", body: { exercise_ids: ids },
      });
      renderActiveSession();
    },
    async onDelete(index) {
      const item = state.session.items[index];
      const logged = state.session.sets.filter((set) => set.exercise_id === item.exercise_id).length;
      if (logged && !confirm(`Remove ${item.name} and its ${logged} logged set${logged === 1 ? "" : "s"}?`)) return;
      state.session = await api(`/sessions/${state.session.id}/items/${item.exercise_id}`, { method: "DELETE" });
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

function renderTrain() {
  const idle = $("#train-idle");
  const active = $("#train-active");
  idle.hidden = !!state.session;
  active.hidden = !state.session;
  if (state.session) renderActiveSession();
  else renderIdle();
}

function renderIdle() {
  const plans = state.plans;
  $("#start-plans").innerHTML = plans.length
    ? plans
        .map(
          (p) => `
        <button class="picker-item" data-action="start-plan" data-id="${p.id}">
          <span class="grow">
            <strong>${esc(p.name)}</strong><br>
            <span class="muted">${p.exercise_count} exercise${p.exercise_count === 1 ? "" : "s"}${
              p.last_done ? ` &middot; last ${esc(dayLabel(p.last_done))}` : ""
            }</span>
          </span>
          <span class="pill">Start</span>
        </button>`,
        )
        .join("")
    : '<p class="muted">No plans yet. Build one on the Plans tab.</p>';
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
  const started = parseTs(s.started_at);
  const mins = Math.round((Date.now() - started.getTime()) / 60000);
  const volume = s.sets.reduce((sum, x) => sum + x.reps * x.weight, 0);
  $("#session-meta").textContent =
    `${mins} min · ${s.sets.length} sets · ${fmtWeight(volume)} kg`;

  $("#exercise-list").innerHTML =
    s.items
      .map((item) => {
        const sets = s.sets.filter((x) => x.exercise_id === item.exercise_id);
        const prev = s.previous[String(item.exercise_id)];
        const done = item.target_sets > 0 && sets.length >= item.target_sets;

        const target = item.target_sets
          ? `${item.target_sets} &times; ${item.target_reps}${
              item.target_weight ? ` @ ${fmtWeight(item.target_weight)} kg` : ""
            }`
          : "no target";

        const last = sets[sets.length - 1];
        const fillWeight = last
          ? fmtWeight(last.weight)
          : item.target_weight
            ? fmtWeight(item.target_weight)
            : prev
              ? fmtWeight(prev.weight)
              : "";
        const fillReps =
          item.target_reps || (last ? last.reps : prev ? prev.reps : "");
        const fillRpe = last?.rpe ?? prev?.rpe ?? "";

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

function renderPlans() {
  $("#plan-list").innerHTML = state.plans.length
    ? state.plans
        .map(
          (p) => `
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
            <button class="btn small ghost" data-action="start-plan" data-id="${p.id}">Start</button>
            <button class="btn small danger" data-action="del-plan" data-id="${p.id}">Delete</button>
          </div>
        </div>`,
        )
        .join("")
    : '<p class="empty">No plans yet.<br>A plan is a named list of exercises with targets.</p>';
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
        <div class="field"><label>Weight (kg)</label>
          <input type="number" inputmode="decimal" step="0.5" min="0" data-idx="${i}" data-f="target_weight" value="${it.target_weight ?? ""}"></div>
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
      ${items ? `<div class="stack" data-drag-list="plan">${items}</div>` : '<p class="muted">No exercises yet.</p>'}
      <button class="btn ghost" data-action="draft-add">+ Add exercise</button>
      <button class="btn good" data-action="draft-save">Save plan</button>
    </div>`;
}

function openPlanEditor(plan) {
  state.draft = plan
    ? {
        id: plan.id,
        name: plan.name,
        notes: plan.notes,
        items: plan.items.map((it) => ({
          exercise_id: it.exercise_id,
          name: it.name,
          target_sets: it.target_sets,
          target_reps: it.target_reps,
          target_weight: it.target_weight,
          rest_seconds: it.rest_seconds,
        })),
      }
    : { id: null, name: "", notes: "", items: [] };
  openSheet(plan ? "Edit plan" : "New plan", planEditorHtml());
}

/** Pull the sheet's inputs into the draft before any re-render or save. */
function syncDraftFromInputs() {
  const d = state.draft;
  if (!d) return;
  const nameEl = $("#draft-name");
  const notesEl = $("#draft-notes");
  if (nameEl) d.name = nameEl.value;
  if (notesEl) d.notes = notesEl.value;
  $$("#sheet-body input[data-idx]").forEach((input) => {
    const item = d.items[Number(input.dataset.idx)];
    if (!item) return;
    const field = input.dataset.f;
    if (field === "target_weight") {
      item.target_weight = input.value === "" ? null : num(input.value);
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

function renderBackupStatus() {
  const last = dataCache?.last_export;
  $("#backup-status").textContent = last
    ? `Last exported ${dayLabel(last)}.`
    : "Not exported yet.";
}

function renderHistory() {
  renderBackupStatus();
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

async function refresh() {
  try {
    if (state.view === "train") {
      const [plans, session, stats] = await Promise.all([
        api("/plans"),
        api("/sessions/active"),
        api("/stats"),
      ]);
      state.plans = plans;
      state.session = session;
      renderTrain();
      if (!session) renderStats(stats);
    } else if (state.view === "plans") {
      state.plans = await api("/plans");
      renderPlans();
    } else {
      state.history = await api("/history");
      renderHistory();
    }
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------------ actions

const actions = {
  async "start-plan"(el) {
    state.session = await api("/sessions", {
      method: "POST",
      body: { plan_id: Number(el.dataset.id) },
    });
    closeSheet();
    setView("train");
  },

  async "start-freestyle"() {
      openSheet('Name your session', `
        <div class="stack">
          <div><label for="freestyle-name">Session name</label>
            <input id="freestyle-name" value="" placeholder="e.g. Upper body" maxlength="80" autofocus></div>
          <button class="btn" data-action="begin-freestyle">Start session</button>
        </div>`);
      $('#freestyle-name').focus();
    },

    async "begin-freestyle"() {
      const name = $('#freestyle-name').value.trim() || 'New session';
      state.session = await api('/sessions', { method: 'POST', body: { plan_id: null, name } });
      closeSheet();
    renderTrain();
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
        method: "POST", body: { exercise_id: exercise.id },
      });
      closeSheet();
      renderActiveSession();
    });
  },

  finish() {
    openSheet(
      "Finish workout",
      `
      <div class="stack">
        <div><label>How did it go?</label>
          <textarea id="finish-notes" rows="3" placeholder="optional"></textarea></div>
        <button class="btn good" data-action="finish-confirm">Save workout</button>
      </div>`,
    );
  },

  async "finish-confirm"() {
    const notes = $("#finish-notes").value;
    await api(`/sessions/${state.session.id}/finish`, {
      method: "POST",
      body: { notes },
    });
    state.session = null;
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
    stopRest();
    $("#topbar-note").textContent = "";
    refresh();
  },

  "new-plan"() {
    openPlanEditor(null);
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
        target_weight: null,
        rest_seconds: 90,
      });
      state.draft = draft;
      openSheet(draft.id ? "Edit plan" : "New plan", planEditorHtml());
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
    const body = {
      name: d.name,
      notes: d.notes,
      items: d.items.map((it) => ({
        exercise_id: it.exercise_id,
        target_sets: it.target_sets,
        target_reps: it.target_reps,
        target_weight: it.target_weight,
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
        <button class="btn good" data-action="new-exercise-save">Create</button>
      </div>`,
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
    const name = `gym-planner-backup-${stamp.slice(0, 10)}.json`;
    const json = JSON.stringify({ ...data, exported_at: stamp }, null, 2);
    const file = new File([json], name, { type: "application/json" });

    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (err) {
        if (err.name === "AbortError") return; // closed the share sheet
        throw err;
      }
    } else {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    await writeLocalData({ ...data, last_export: nowTs() });
    renderBackupStatus();
    toast("Backup exported");
  },

  "import-data"() {
    $("#import-file").click();
  },

  "close-sheet"() {
    closeSheet();
  },
};

// -------------------------------------------------------------------- wiring

document.addEventListener("click", async (ev) => {
  const tab = ev.target.closest(".tab");
  if (tab) return setView(tab.dataset.view);

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

/** Check a parsed backup and rebuild it as a clean data object. */
function backupToData(imported) {
  const lists = ["exercises", "plans", "sessions"];
  if (imported?.version !== 1 || !lists.every((k) => Array.isArray(imported[k]))) {
    throw new Error("That file is not a Gym Planner backup");
  }
  const maxId = (items) => items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
  return {
    version: 1,
    // Derived rather than trusted, so new records can never reuse an id.
    nextIds: {
      exercise: maxId(imported.exercises) + 1,
      plan: maxId(imported.plans) + 1,
      session: maxId(imported.sessions) + 1,
      set: maxId(imported.sessions.flatMap((session) => session.sets || [])) + 1,
    },
    exercises: imported.exercises,
    plans: imported.plans.map((plan) => ({ ...plan, items: plan.items || [] })),
    sessions: imported.sessions.map((session) => ({ ...session, sets: session.sets || [] })),
    last_export: imported.exported_at ? imported.exported_at.slice(0, 19).replace("T", " ") : null,
  };
}

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
    if (!confirm(`Replace everything on this phone with this backup (${count} workout${count === 1 ? "" : "s"})?`)) return;
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

// Keep the session header's elapsed time honest without a full re-render.
setInterval(() => {
  if (state.session && state.view === "train") {
    const started = parseTs(state.session.started_at);
    const mins = Math.round((Date.now() - started.getTime()) / 60000);
    const volume = state.session.sets.reduce(
      (sum, x) => sum + x.reps * x.weight,
      0,
    );
    $("#session-meta").textContent =
      `${mins} min · ${state.session.sets.length} sets · ${fmtWeight(volume)} kg`;
  }
}, 30000);

(async function boot() {
  try {
    state.exercises = await api("/exercises");
  } catch (err) {
    toast("Could not open local data");
  }
  setView("train");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      toast("Offline mode unavailable");
    });
  }
  // Ask the browser not to clear our data when the phone is short on space.
  navigator.storage?.persist?.().catch(() => {});
})();
