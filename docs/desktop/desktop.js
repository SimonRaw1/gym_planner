/* Raw Muscle Plan Builder: a desktop page for writing plans with a keyboard
 * and a wide screen, then exporting them as a plans file (or link) for
 * Plans › Import plans on the phone. It doesn't touch the phone app's data:
 * the work in progress is kept in this browser's localStorage.
 *
 * The export is the phone's plans file shape (kind "gym-planner-plans",
 * version 1; see plansToExport() in ../app.js), so the phone matches folders,
 * blocks, weeks and plans by uid on a later import. */

const STORE = "desktop-plans";
const MUSCLE_GROUPS = ["chest", "back", "legs", "shoulders", "arms", "core", "cardio", "other"];
const LINK_KEY = "#plans=";

const $ = (sel) => document.querySelector(sel);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function newUid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

/* The work in progress. A plan's `place` is "" (no folder), "f:<folder uid>"
 * or "w:<week uid>"; a block's `folder` is a folder uid or null. */
const empty = () => ({ folders: [], blocks: [], weeks: [], plans: [], selected: null, open: [] });
let state = load();

function load() {
  try {
    return { ...empty(), ...JSON.parse(localStorage.getItem(STORE)) };
  } catch {
    return empty();
  }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    toast("Couldn't save in this browser; export before closing");
  }
}

// Same colours as the phone when it's been used in this browser.
try {
  const theme = JSON.parse(localStorage.getItem("theme"));
  if (theme) document.documentElement.dataset.theme = theme === "default" ? "spicy" : theme;
} catch {
  // Keep Raw Muscle.
}

let toastTimer = null;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

const seed = (name) =>
  SEED_EXERCISES.find(([n]) => n.toLowerCase() === String(name).trim().toLowerCase());

const newItem = () => ({ name: "", muscle_group: "other", equipment: "", sets: 3, reps: 10, rpe: "", rest: 90 });

const planById = (uid) => state.plans.find((p) => p.uid === uid);

/* Folders, blocks and weeks start collapsed; `state.open` holds the uids of
 * the expanded ones. */
const isOpen = (uid) => state.open.includes(uid);

/** Expand whatever holds a plan at `place` (and anything in `extra`), so a
 * plan just made or moved is in view. */
function reveal(place, ...extra) {
  const uids = [...extra];
  const week = place.startsWith("w:") && state.weeks.find((w) => `w:${w.uid}` === place);
  const block = week && state.blocks.find((b) => b.uid === week.block);
  if (week) uids.push(week.uid, block?.uid, block?.folder);
  if (place.startsWith("f:")) uids.push(place.slice(2));
  uids.filter(Boolean).forEach((uid) => isOpen(uid) || state.open.push(uid));
}
const plansAt = (place) => state.plans.filter((p) => p.place === place);

/** "Week 3" after "Week 2"; anything else gets " copy". */
function nextName(name) {
  const m = /^(.*?)(\d+)$/.exec(name.trim());
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${name} copy`;
}

function copyPlan(plan, place) {
  return { ...structuredClone(plan), uid: newUid(), place };
}

// ------------------------------------------------------------------ render

function render() {
  renderTree();
  renderEditor();
  save();
}

function renderTree() {
  const tools = (...buttons) => `<span class="tools">${buttons.join("")}</span>`;
  // A folder, block or week title: tap to expand or collapse it.
  const head = (kind, item, buttons) => `
      <div class="node ${kind}${isOpen(item.uid) ? " open" : ""}">
        <button type="button" class="twisty grow" data-act="toggle" data-uid="${item.uid}" aria-expanded="${isOpen(item.uid)}">
          <span class="chev" aria-hidden="true"></span><span class="grow">${esc(item.name)}</span>
        </button>
        ${tools(...buttons)}</div>`;
  const children = (item, html) => (isOpen(item.uid) ? `<div class="children">${html}</div>` : "");
  const tool = (act, label, data = "") =>
    `<button type="button" class="tool" data-act="${act}" ${data}>${label}</button>`;

  const planRow = (p) => `
    <button type="button" class="node plan${p.uid === state.selected ? " selected" : ""}" data-act="select" data-uid="${p.uid}">
      <span class="grow">${esc(p.name) || '<em class="muted">Untitled plan</em>'}</span>
      <span class="count">${p.items.length}</span>
    </button>`;

  const weekHtml = (w) => `
    <div class="branch">${head("week", w, [
      tool("add-plan", "+ Plan", `data-place="w:${w.uid}"`),
      tool("dup-week", "Duplicate", `data-uid="${w.uid}"`),
      tool("rename-week", "Rename", `data-uid="${w.uid}"`),
      tool("del-week", "&times;", `data-uid="${w.uid}" aria-label="Delete week"`),
    ])}
      ${children(w, plansAt(`w:${w.uid}`).map(planRow).join("") || '<p class="muted empty-branch">No plans yet.</p>')}
    </div>`;

  const blockHtml = (b) => `
    <div class="branch">${head("block", b, [
      tool("add-week", "+ Week", `data-uid="${b.uid}"`),
      tool("rename-block", "Rename", `data-uid="${b.uid}"`),
      tool("del-block", "&times;", `data-uid="${b.uid}" aria-label="Delete block"`),
    ])}
      ${children(b, state.weeks.filter((w) => w.block === b.uid).map(weekHtml).join("") || '<p class="muted empty-branch">No weeks yet.</p>')}
    </div>`;

  const folderHtml = (f) => `
    <div class="branch">${head("folder", f, [
      tool("add-block", "+ Block", `data-folder="${f.uid}"`),
      tool("add-plan", "+ Plan", `data-place="f:${f.uid}"`),
      tool("rename-folder", "Rename", `data-uid="${f.uid}"`),
      tool("del-folder", "&times;", `data-uid="${f.uid}" aria-label="Delete folder"`),
    ])}
      ${children(
        f,
        state.blocks.filter((b) => b.folder === f.uid).map(blockHtml).join("") +
          plansAt(`f:${f.uid}`).map(planRow).join("") || '<p class="muted empty-branch">Nothing in this folder yet.</p>',
      )}
    </div>`;

  const html =
    state.folders.map(folderHtml).join("") +
    state.blocks.filter((b) => !b.folder).map(blockHtml).join("") +
    plansAt("").map(planRow).join("");
  $("#tree").innerHTML =
    html ||
    '<p class="muted">Nothing yet. Start with + Folder, + Block or + Plan, or open a plans file exported from the phone.</p>';
}

/** Where a plan can go: nowhere, a folder, or a week (under its block). */
function placeOptions(current) {
  const opt = (value, label) =>
    `<option value="${value}"${value === current ? " selected" : ""}>${esc(label)}</option>`;
  const weeksOf = (b) =>
    state.weeks.filter((w) => w.block === b.uid).map((w) => opt(`w:${w.uid}`, `${b.name} › ${w.name}`)).join("");
  const folders = state.folders
    .map(
      (f) => `<optgroup label="${esc(f.name)}">${opt(`f:${f.uid}`, `${f.name}, no week`)}${state.blocks
        .filter((b) => b.folder === f.uid)
        .map(weeksOf)
        .join("")}</optgroup>`,
    )
    .join("");
  const loose = state.blocks
    .filter((b) => !b.folder)
    .map((b) => {
      const weeks = weeksOf(b);
      return weeks ? `<optgroup label="${esc(b.name)}">${weeks}</optgroup>` : "";
    })
    .join("");
  return opt("", "No folder or week") + folders + loose;
}

function renderEditor() {
  const plan = planById(state.selected);
  // With no plan open there's no editor, and the tree takes the width.
  $(".layout").classList.toggle("idle", !plan);
  $("#editor").hidden = !plan;
  if (!plan) {
    $("#editor").innerHTML = "";
    return;
  }
  const rows = plan.items
    .map((it, i) => {
      const known = seed(it.name);
      return `
      <tr data-i="${i}">
        <td class="num">${i + 1}</td>
        <td><input data-f="name" list="exercise-names" value="${esc(it.name)}" placeholder="Exercise"></td>
        <td><select data-f="muscle_group"${known ? " disabled" : ""}>${MUSCLE_GROUPS.map(
          (g) => `<option${g === (known ? known[1] : it.muscle_group) ? " selected" : ""}>${g}</option>`,
        ).join("")}</select></td>
        <td><input data-f="sets" type="number" min="0" value="${esc(it.sets)}"></td>
        <td><input data-f="reps" type="number" min="0" value="${esc(it.reps)}"></td>
        <td><input data-f="rpe" type="number" min="1" max="10" step="0.5" value="${esc(it.rpe)}" placeholder="–"></td>
        <td><input data-f="rest" type="number" min="0" step="15" value="${esc(it.rest)}"></td>
        <td class="row-tools">
          <button type="button" class="tool" data-act="item-up" aria-label="Move up"${i ? "" : " disabled"}>&uarr;</button>
          <button type="button" class="tool" data-act="item-down" aria-label="Move down"${i < plan.items.length - 1 ? "" : " disabled"}>&darr;</button>
          <button type="button" class="tool" data-act="item-del" aria-label="Remove">&times;</button>
        </td>
      </tr>`;
    })
    .join("");
  $("#editor").innerHTML = `
    <div class="editor-grid">
      <div><label for="plan-name">Plan name</label>
        <input id="plan-name" data-plan="name" value="${esc(plan.name)}" placeholder="Push day"></div>
      <div><label for="plan-place">Folder or week</label>
        <select id="plan-place" data-plan="place">${placeOptions(plan.place)}</select></div>
    </div>
    <div><label for="plan-notes">Notes</label>
      <input id="plan-notes" data-plan="notes" value="${esc(plan.notes)}" placeholder="optional"></div>
    <table class="items">
      <thead><tr><th></th><th>Exercise</th><th>Muscle group</th><th>Sets</th><th>Reps</th><th>RPE</th><th>Rest (s)</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td></td><td colspan="7" class="muted">No exercises yet.</td></tr>'}</tbody>
    </table>
    <div class="editor-foot">
      <button class="btn small" data-act="item-add">+ Add exercise</button>
      <span class="grow"></span>
      <button class="btn small ghost" data-act="dup-plan">Duplicate plan</button>
      <button class="btn small danger" data-act="del-plan">Delete plan</button>
    </div>`;
}

// ----------------------------------------------------------------- editing

$("#editor").addEventListener("input", (ev) => {
  const plan = planById(state.selected);
  if (!plan) return;
  const field = ev.target.dataset.plan;
  if (field) {
    plan[field] = ev.target.value;
    if (field === "name") renderTree();
    if (field === "place") {
      reveal(plan.place); // keep the plan in view where it went
      renderTree();
    }
    return save();
  }
  const row = ev.target.closest("tr[data-i]");
  const f = ev.target.dataset.f;
  if (!row || !f) return;
  const item = plan.items[Number(row.dataset.i)];
  item[f] = ev.target.value;
  if (f === "name") {
    // A starter exercise brings its muscle group; anything else is picked.
    const known = seed(item.name);
    const group = row.querySelector('[data-f="muscle_group"]');
    group.disabled = !!known;
    if (known) {
      [, item.muscle_group, item.equipment] = known;
      group.value = known[1];
    } else {
      item.equipment = "";
      item.muscle_group = group.value;
    }
    renderTree(); // the exercise count
  }
  save();
});
$("#editor").addEventListener("change", (ev) => {
  if (ev.target.id === "plan-place") renderTree();
});

/** Enter in an exercise row adds the next one. */
$("#editor").addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || !ev.target.closest("tr[data-i]")) return;
  ev.preventDefault();
  actions["item-add"]();
});

/* Dialogs are SweetAlert2 (../vendor/sweetalert2), dressed in the app's
 * colours by .swal-app in ../app.css. */
const dialog = (options) =>
  Swal.fire({
    reverseButtons: true,
    buttonsStyling: false,
    cancelButtonText: "Cancel",
    customClass: { popup: "swal-app", confirmButton: "btn", cancelButton: "btn ghost" },
    ...options,
  });

/** A name, or null if cancelled or left blank. */
async function ask(question, value = "") {
  const { value: answer } = await dialog({
    title: question,
    input: "text",
    inputValue: value,
    showCancelButton: true,
    confirmButtonText: "Save",
  });
  return typeof answer === "string" ? answer.trim() || null : null;
}

/** Yes before something that can't be undone; `yes` labels the button. */
async function sure(text, yes = "Delete") {
  const { isConfirmed } = await dialog({
    text,
    showCancelButton: true,
    focusCancel: true,
    confirmButtonText: yes,
    customClass: { popup: "swal-app", confirmButton: "btn danger", cancelButton: "btn ghost" },
  });
  return isConfirmed;
}

const actions = {
  async "add-folder"() {
    const name = await ask("Folder name");
    if (!name) return;
    state.folders.push({ uid: newUid(), name });
    render();
  },
  async "add-block"(el) {
    const name = await ask("Block name", "Block 1");
    if (!name) return;
    const block = { uid: newUid(), name, folder: el.dataset.folder || null };
    const week = { uid: newUid(), name: "Week 1", block: block.uid };
    state.blocks.push(block);
    state.weeks.push(week);
    reveal(`w:${week.uid}`);
    render();
  },
  async "add-week"(el) {
    const weeks = state.weeks.filter((w) => w.block === el.dataset.uid);
    const name = await ask("Week name", weeks.length ? nextName(weeks.at(-1).name) : "Week 1");
    if (!name) return;
    const week = { uid: newUid(), name, block: el.dataset.uid };
    state.weeks.push(week);
    reveal(`w:${week.uid}`);
    render();
  },
  "add-plan"(el) {
    const plan = { uid: newUid(), name: "", notes: "", place: el.dataset.place || "", items: [newItem()] };
    state.plans.push(plan);
    state.selected = plan.uid;
    reveal(plan.place);
    render();
    $("#plan-name").focus();
  },
  select(el) {
    state.selected = el.dataset.uid;
    render();
  },
  toggle(el) {
    const uid = el.dataset.uid;
    state.open = isOpen(uid) ? state.open.filter((u) => u !== uid) : [...state.open, uid];
    render();
  },

  // A week's copy goes right after it, with copies of all its plans.
  "dup-week"(el) {
    const week = state.weeks.find((w) => w.uid === el.dataset.uid);
    const siblings = state.weeks.filter((w) => w.block === week.block).map((w) => w.name.toLowerCase());
    let name = nextName(week.name);
    while (siblings.includes(name.toLowerCase())) name = nextName(name);
    const copy = { uid: newUid(), name, block: week.block };
    state.weeks.splice(state.weeks.indexOf(week) + 1, 0, copy);
    plansAt(`w:${week.uid}`).forEach((p) => state.plans.push(copyPlan(p, `w:${copy.uid}`)));
    render();
    toast(`${name} added`);
  },
  "dup-plan"() {
    const plan = planById(state.selected);
    const copy = { ...copyPlan(plan, plan.place), name: nextName(plan.name || "Plan") };
    state.plans.splice(state.plans.indexOf(plan) + 1, 0, copy);
    state.selected = copy.uid;
    render();
    $("#plan-name").select();
  },

  async "rename-folder"(el) {
    return rename(state.folders, el.dataset.uid, "Folder name");
  },
  async "rename-block"(el) {
    return rename(state.blocks, el.dataset.uid, "Block name");
  },
  async "rename-week"(el) {
    return rename(state.weeks, el.dataset.uid, "Week name");
  },

  async "del-folder"(el) {
    const blocks = state.blocks.filter((b) => b.folder === el.dataset.uid).map((b) => b.uid);
    if (!(await sure("Delete this folder with its blocks, weeks and plans?"))) return;
    blocks.forEach(deleteBlock);
    removePlans((p) => p.place === `f:${el.dataset.uid}`);
    state.folders = state.folders.filter((f) => f.uid !== el.dataset.uid);
    render();
  },
  async "del-block"(el) {
    if (!(await sure("Delete this block with its weeks and plans?"))) return;
    deleteBlock(el.dataset.uid);
    render();
  },
  async "del-week"(el) {
    if (!(await sure("Delete this week and its plans?"))) return;
    deleteWeek(el.dataset.uid);
    render();
  },
  async "del-plan"() {
    if (!(await sure("Delete this plan?"))) return;
    removePlans((p) => p.uid === state.selected);
    render();
  },

  "item-add"() {
    const plan = planById(state.selected);
    plan.items.push(newItem());
    render();
    $("#editor tbody tr:last-child [data-f='name']").focus();
  },
  "item-up"(el) {
    moveItem(el, -1);
  },
  "item-down"(el) {
    moveItem(el, 1);
  },
  "item-del"(el) {
    planById(state.selected).items.splice(Number(el.closest("tr").dataset.i), 1);
    render();
  },

  export() {
    const file = plansFile();
    if (!file.plans.length) return toast("Name a plan first");
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `raw-muscle-plans-${file.exported_at.slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${file.plans.length} plan${file.plans.length === 1 ? "" : "s"} exported`);
  },
  async "copy-link"() {
    const file = plansFile();
    if (!file.plans.length) return toast("Name a plan first");
    const link = await plansLink(file);
    if (link.length > 60000) return toast("Too many plans for one link; export a file instead");
    await navigator.clipboard.writeText(link);
    toast("Link copied. Send it to your phone and tap it there");
  },
  import() {
    $("#import-file").click();
  },
  async clear() {
    if (!(await sure("Clear everything here and start over? Export first if you want to keep it.", "Start over"))) return;
    state = empty();
    render();
  },
};

async function rename(list, uid, question) {
  const item = list.find((x) => x.uid === uid);
  const name = await ask(question, item.name);
  if (!name) return;
  item.name = name;
  render();
}

function removePlans(test) {
  state.plans = state.plans.filter((p) => !test(p));
  if (!planById(state.selected)) state.selected = null;
}

function deleteWeek(uid) {
  removePlans((p) => p.place === `w:${uid}`);
  state.weeks = state.weeks.filter((w) => w.uid !== uid);
}

function deleteBlock(uid) {
  state.weeks.filter((w) => w.block === uid).forEach((w) => deleteWeek(w.uid));
  state.blocks = state.blocks.filter((b) => b.uid !== uid);
}

function moveItem(el, by) {
  const items = planById(state.selected).items;
  const i = Number(el.closest("tr").dataset.i);
  items.splice(i + by, 0, items.splice(i, 1)[0]);
  render();
}

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (!el || el.disabled) return;
  Promise.resolve(actions[el.dataset.act]?.(el)).catch((err) => toast(err.message));
});

// ------------------------------------------------------------ export / import

const toNumber = (value, fallback) => {
  const n = Number(value);
  return value === "" || !Number.isFinite(n) ? fallback : n;
};

/** Everything here as a phone plans file. Plans without a name, and
 * exercises without one, are left out. */
function plansFile() {
  const plans = state.plans
    .filter((p) => p.name.trim())
    .map((p) => {
      const week = p.place.startsWith("w:") ? state.weeks.find((w) => `w:${w.uid}` === p.place) : null;
      const block = week && state.blocks.find((b) => b.uid === week.block);
      const folderUid = block ? block.folder : p.place.startsWith("f:") ? p.place.slice(2) : null;
      const folder = state.folders.find((f) => f.uid === folderUid);
      return {
        uid: p.uid,
        name: p.name.trim(),
        notes: p.notes.trim(),
        folder: folder ? folder.name : null,
        folder_uid: folder ? folder.uid : null,
        group: block ? [block.name, week.name] : null,
        group_uids: block ? [block.uid, week.uid] : null,
        items: p.items
          .filter((it) => it.name.trim())
          .map((it) => {
            const known = seed(it.name);
            const rpe = toNumber(it.rpe, null);
            return {
              exercise: {
                name: known ? known[0] : it.name.trim(),
                muscle_group: known ? known[1] : it.muscle_group,
                equipment: known ? known[2] : it.equipment,
              },
              target_sets: Math.max(0, Math.round(toNumber(it.sets, 0))),
              target_reps: Math.max(0, Math.round(toNumber(it.reps, 0))),
              target_rpe: rpe != null && rpe >= 1 && rpe <= 10 ? rpe : null,
              rest_seconds: Math.max(0, Math.round(toNumber(it.rest, 90))),
            };
          }),
      };
    });
  return { kind: "gym-planner-plans", version: 1, exported_at: new Date().toISOString(), plans };
}

/** The phone's plans link for a plans file: deflated, base64url, after #plans=
 * (unpackPlans() in ../app.js reads it). */
async function plansLink(file) {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const zipped = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer();
  let bin = "";
  new Uint8Array(zipped).forEach((b) => (bin += String.fromCharCode(b)));
  const packed = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return new URL("../", location.href).href + LINK_KEY + packed;
}

/** Open a plans file (from the phone's Export plans › Send a file instead, or
 * from here) to keep working on it. Replaces what's here. */
function openPlansFile(file) {
  if (file?.kind !== "gym-planner-plans" || !Array.isArray(file.plans))
    throw new Error("That file has no Raw Muscle plans");
  const next = empty();
  const findOrAdd = (list, uid, name, extra) => {
    let item = (uid && list.find((x) => x.uid === uid)) || list.find((x) => x.name === name && Object.entries(extra).every(([k, v]) => x[k] === v));
    if (!item) list.push((item = { uid: uid || newUid(), name, ...extra }));
    return item;
  };
  file.plans.forEach((p) => {
    const folder = p.folder ? findOrAdd(next.folders, p.folder_uid, String(p.folder), {}) : null;
    let place = folder ? `f:${folder.uid}` : "";
    if (Array.isArray(p.group) && p.group.length === 2) {
      const uids = Array.isArray(p.group_uids) ? p.group_uids : [];
      const block = findOrAdd(next.blocks, uids[0], String(p.group[0]), { folder: folder ? folder.uid : null });
      const week = findOrAdd(next.weeks, uids[1], String(p.group[1]), { block: block.uid });
      place = `w:${week.uid}`;
    }
    next.plans.push({
      uid: p.uid || newUid(),
      name: String(p.name || ""),
      notes: String(p.notes || ""),
      place,
      items: (p.items || []).map((it) => ({
        name: String(it.exercise?.name || ""),
        muscle_group: it.exercise?.muscle_group || "other",
        equipment: it.exercise?.equipment || "",
        sets: it.target_sets ?? "",
        reps: it.target_reps ?? "",
        rpe: it.target_rpe ?? "",
        rest: it.rest_seconds ?? 90,
      })),
    });
  });
  return next;
}

$("#import-file").addEventListener("change", async (ev) => {
  const picked = ev.target.files[0];
  ev.target.value = "";
  if (!picked) return;
  try {
    let file;
    try {
      file = JSON.parse(await picked.text());
    } catch {
      throw new Error("That file has no Raw Muscle plans");
    }
    const next = openPlansFile(file);
    if (state.plans.length && !(await sure("Replace what's here with this file's plans?", "Replace"))) return;
    state = next;
    render();
    toast(`Opened ${next.plans.length} plan${next.plans.length === 1 ? "" : "s"}`);
  } catch (err) {
    toast(err.message);
  }
});

$("#exercise-names").innerHTML = SEED_EXERCISES.map(([name]) => `<option value="${esc(name)}">`).join("");
render();
