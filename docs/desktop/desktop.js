/* Raw Muscle Plan Builder: a desktop page for writing plans with a keyboard
 * and a wide screen, then exporting them as a plans file (or link) for
 * Plans › Import plans on the phone. It doesn't touch the phone app's data:
 * the work in progress is kept in this browser's localStorage.
 *
 * The export is the phone's plans file shape (kind "gym-planner-plans",
 * version 1; see plansToExport() in ../app.js), so the phone matches folders,
 * blocks, weeks and plans by uid on a later import. */

const STORE = "desktop-plans";
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

/* The work in progress. A plan's `place` is "" (no folder), "f:<folder uid>",
 * "b:<block uid>" (straight in a block) or "w:<week uid>"; a block's `folder`
 * is a folder uid or null. */
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

const newItem = () => ({ name: "", sets: 3, reps: 10, rpe: "", rest: 90 });

const planById = (uid) => state.plans.find((p) => p.uid === uid);

/* Folders, blocks and weeks start collapsed; `state.open` holds the uids of
 * the expanded ones. */
const isOpen = (uid) => state.open.includes(uid);

/** Expand whatever holds a plan at `place` (and anything in `extra`), so a
 * plan just made or moved is in view. */
function reveal(place, ...extra) {
  const uids = [...extra];
  const { folder, block, week } = placeParts(place);
  uids.push(folder, block, week);
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

/** A copy of `week` (with copies of its plans) in block `blockUid`. */
function copyWeek(week, name, blockUid) {
  const copy = { uid: newUid(), name, block: blockUid };
  insertCopy(state.weeks, week, copy, (w) => w.block === blockUid);
  plansAt(`w:${week.uid}`).forEach((p) => state.plans.push(copyPlan(p, `w:${copy.uid}`)));
  return copy;
}

/** Put `copy` right after `original` when it lands beside it, else last. */
function insertCopy(list, original, copy, beside) {
  if (beside(original)) list.splice(list.indexOf(original) + 1, 0, copy);
  else list.push(copy);
}

/** The next free name among `names` after `name` ("Week 2" → "Week 3"). */
function freshName(name, names) {
  const taken = names.map((n) => n.toLowerCase());
  let next = nextName(name);
  while (taken.includes(next.toLowerCase())) next = nextName(next);
  return next;
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
    <div class="node plan${p.uid === state.selected ? " selected" : ""}">
      <button type="button" class="twisty grow" data-act="select" data-uid="${p.uid}">
        <span class="grow">${esc(p.name) || '<em class="muted">Untitled plan</em>'}</span>
      </button>
      ${tools(
        tool("move-plan", "Move", `data-uid="${p.uid}"`),
        tool("copy-plan", "Copy", `data-uid="${p.uid}"`),
      )}
      <span class="count">${p.items.length}</span>
    </div>`;

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
      tool("add-plan", "+ Plan", `data-place="b:${b.uid}"`),
      tool("dup-block", "Duplicate", `data-uid="${b.uid}"`),
      tool("rename-block", "Rename", `data-uid="${b.uid}"`),
      tool("del-block", "&times;", `data-uid="${b.uid}" aria-label="Delete block"`),
    ])}
      ${children(
        b,
        state.weeks.filter((w) => w.block === b.uid).map(weekHtml).join("") +
          plansAt(`b:${b.uid}`).map(planRow).join("") || '<p class="muted empty-branch">No weeks yet.</p>',
      )}
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

/** A plan's place as its folder, block and week uids (each or null). */
function placeParts(place) {
  const uid = place.slice(2);
  const week = place.startsWith("w:") ? state.weeks.find((w) => w.uid === uid) : null;
  const block = place.startsWith("b:")
    ? state.blocks.find((b) => b.uid === uid)
    : week && state.blocks.find((b) => b.uid === week.block);
  const folder = place.startsWith("f:") ? uid : block?.folder || null;
  return { folder: folder || null, block: block?.uid || null, week: week?.uid || null };
}

/** A spot ({ folder, block, week } uids) as a plan's place string. */
const placeOfSpot = (at) =>
  at.week ? `w:${at.week}` : at.block ? `b:${at.block}` : at.folder ? `f:${at.folder}` : "";

/** "Summer › Block 1 › Week 2", or "Not in a folder" at the top. */
function spotLabel(at) {
  const names = [
    state.folders.find((f) => f.uid === at.folder)?.name,
    state.blocks.find((b) => b.uid === at.block)?.name,
    state.weeks.find((w) => w.uid === at.week)?.name,
  ].filter(Boolean);
  return names.length ? names.join(" › ") : "Not in a folder";
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
      return `
      <tr data-i="${i}">
        <td class="num">${i + 1}</td>
        <td><input data-f="name" list="exercise-names" value="${esc(it.name)}" placeholder="Exercise"></td>
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
    <div><label for="plan-name">Plan name</label>
      <input id="plan-name" data-plan="name" value="${esc(plan.name)}" placeholder="Push day"></div>
    <div class="where-row">
      <span class="muted">Where</span>
      <strong class="grow">${esc(spotLabel(placeParts(plan.place)))}</strong>
      <button class="btn small ghost" data-act="move-plan" data-uid="${plan.uid}">Change</button>
    </div>
    <div><label for="plan-notes">Notes</label>
      <input id="plan-notes" data-plan="notes" value="${esc(plan.notes)}" placeholder="optional"></div>
    <table class="items">
      <thead><tr><th></th><th>Exercise</th><th>Sets</th><th>Reps</th><th>RPE</th><th>Rest (s)</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td></td><td colspan="6" class="muted">No exercises yet.</td></tr>'}</tbody>
    </table>
    <div class="editor-foot">
      <button class="btn small" data-act="item-add">+ Add exercise</button>
      <span class="grow"></span>
      <button class="btn small ghost" data-act="move-plan" data-uid="${plan.uid}">Move</button>
      <button class="btn small ghost" data-act="copy-plan" data-uid="${plan.uid}">Copy</button>
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
    return save();
  }
  const row = ev.target.closest("tr[data-i]");
  const f = ev.target.dataset.f;
  if (!row || !f) return;
  const item = plan.items[Number(row.dataset.i)];
  item[f] = ev.target.value;
  if (f === "name") renderTree(); // the exercise count
  save();
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

/* Where something goes, picked the way the tree is laid out: folders (and
 * blocks outside folders) at the top; click one to go into it, click a block
 * to see its weeks, and the button puts it wherever you are. `depth` is as
 * far down as it can go ("folder" for a block, "block" for a week, "week"
 * for a plan), `need` how far down it must be (a week needs a block). With
 * `name`, it asks for one too. Resolves { name, at } or null if cancelled. */
const LEVELS = ["top", "folder", "block", "week"];
const levelOf = (at) => (at.week ? "week" : at.block ? "block" : at.folder ? "folder" : "top");

async function askSpot({ title, yes, depth, need = "top", name, note, at }) {
  at = { folder: null, block: null, week: null, ...at };
  const field = (id) => document.getElementById(id);
  const blocksIn = (folder) => state.blocks.filter((b) => (b.folder || null) === folder);
  const view = () => {
    const level = levelOf(at);
    const deeper = LEVELS.indexOf(level) < LEVELS.indexOf(depth);
    const rows = !deeper
      ? []
      : level === "top"
        ? [...state.folders.map((f) => ["folder", f]), ...(depth === "folder" ? [] : blocksIn(null).map((b) => ["block", b]))]
        : level === "folder"
          ? blocksIn(at.folder).map((b) => ["block", b])
          : state.weeks.filter((w) => w.block === at.block).map((w) => ["week", w]);
    const empty = { top: "No folders yet.", folder: "No blocks in this folder.", block: "No weeks in this block." }[level];
    const names = spotLabel(at).split(" › ");
    const above = level === "top" ? [] : ["All plans", ...names.slice(0, -1)];
    const ok = LEVELS.indexOf(level) >= LEVELS.indexOf(need);
    Swal.getConfirmButton().disabled = !ok;
    return `
      <div class="spot-head">
        ${level === "top" ? "" : '<button type="button" class="tool spot-back" data-up aria-label="Back">&lsaquo; Back</button>'}
        <div class="grow">
          ${above.length ? `<div class="muted">${above.map(esc).join(" › ")}</div>` : ""}
          <strong>${esc(level === "top" ? "All plans" : names.at(-1))}</strong>
        </div>
      </div>
      <div class="spot-rows">${
        rows
          .map(([kind, g]) => `<button type="button" class="spot-row ${kind}" data-into="${kind}" data-uid="${g.uid}"><span class="grow">${esc(g.name)}</span><span aria-hidden="true">&rsaquo;</span></button>`)
          .join("") || (deeper ? `<p class="muted">${empty}</p>` : "")
      }</div>
      ${ok ? "" : `<p class="muted">Go into a ${need} to put it there.</p>`}`;
  };
  const { value } = await dialog({
    title,
    html: `<div class="swal-fields">
      ${name === undefined ? "" : `<label for="copy-name">Name</label>
      <input id="copy-name" class="swal2-input" value="${esc(name)}">`}
      ${note ? `<p class="muted">${note}</p>` : ""}
      <div id="spot-nav"></div>
    </div>`,
    showCancelButton: true,
    confirmButtonText: `${yes} here`,
    didOpen: () => {
      field("spot-nav").innerHTML = view();
      field("spot-nav").addEventListener("click", (ev) => {
        const into = ev.target.closest("[data-into]");
        if (into) {
          const uid = into.dataset.uid;
          if (into.dataset.into === "folder") at = { folder: uid, block: null, week: null };
          else if (into.dataset.into === "block") at = { ...at, block: uid, week: null };
          else at = { ...at, week: uid };
        } else if (ev.target.closest("[data-up]")) {
          at = at.week ? { ...at, week: null } : at.block ? { ...at, block: null } : { folder: null, block: null, week: null };
        } else return;
        field("spot-nav").innerHTML = view();
      });
      field("copy-name")?.select();
    },
    preConfirm: () => {
      const copyName = name === undefined ? undefined : field("copy-name").value.trim();
      if (copyName === "") {
        Swal.showValidationMessage("Give it a name"); // false keeps the dialog open
        return false;
      }
      return { name: copyName, at: { ...at } };
    },
  });
  return value || null;
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

  // A week's copy, with copies of its plans, in a block browsed to (by
  // default its own, right after it).
  async "dup-week"(el) {
    const week = state.weeks.find((w) => w.uid === el.dataset.uid);
    const block = state.blocks.find((b) => b.uid === week.block);
    const siblings = state.weeks.filter((w) => w.block === week.block).map((w) => w.name);
    const to = await askSpot({
      title: "Duplicate week",
      yes: "Duplicate",
      depth: "block",
      need: "block",
      name: freshName(week.name, siblings),
      note: "Copies every plan in it.",
      at: { folder: block?.folder || null, block: week.block },
    });
    if (!to) return;
    const copy = copyWeek(week, to.name, to.at.block);
    reveal(`w:${copy.uid}`);
    render();
    toast(`${to.name} added`);
  },

  // A block's copy, with its weeks and plans, in a folder browsed to (or none).
  async "dup-block"(el) {
    const block = state.blocks.find((b) => b.uid === el.dataset.uid);
    const siblings = state.blocks.filter((b) => b.folder === block.folder).map((b) => b.name);
    const to = await askSpot({
      title: "Duplicate block",
      yes: "Duplicate",
      depth: "folder",
      name: freshName(block.name, siblings),
      note: "Copies every week and plan in it.",
      at: { folder: block.folder || null },
    });
    if (!to) return;
    const folder = to.at.folder;
    const copy = { uid: newUid(), name: to.name, folder };
    insertCopy(state.blocks, block, copy, (b) => (b.folder || null) === folder);
    state.weeks
      .filter((w) => w.block === block.uid)
      .forEach((w) => copyWeek(w, w.name, copy.uid));
    plansAt(`b:${block.uid}`).forEach((p) => state.plans.push(copyPlan(p, `b:${copy.uid}`)));
    reveal(`b:${copy.uid}`);
    render();
    toast(`${to.name} added`);
  },
  // Move a plan: browse to a week, a block or a folder, and move it there.
  async "move-plan"(el) {
    const plan = planById(el.dataset.uid);
    const to = await askSpot({ title: `Move ${plan.name || "plan"}`, yes: "Move", depth: "week", at: placeParts(plan.place) });
    if (!to) return;
    plan.place = placeOfSpot(to.at);
    reveal(plan.place);
    render();
    toast("Plan moved");
  },

  // A copy of a plan under a new name, anywhere (by default beside it).
  async "copy-plan"(el) {
    const plan = planById(el.dataset.uid);
    const siblings = plansAt(plan.place).map((p) => p.name);
    const to = await askSpot({
      title: "Copy plan",
      yes: "Copy",
      depth: "week",
      name: freshName(plan.name || "Plan", siblings),
      at: placeParts(plan.place),
    });
    if (!to) return;
    const place = placeOfSpot(to.at);
    const copy = { ...copyPlan(plan, place), name: to.name };
    insertCopy(state.plans, plan, copy, (p) => p.place === place);
    state.selected = copy.uid;
    reveal(copy.place);
    render();
    toast(`${to.name} added`);
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
    if (!file.plans.length && !file.structure.blocks.length && !file.structure.folders.length)
      return toast("Add a folder, block or plan first");
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
    if (!file.plans.length && !file.structure.blocks.length && !file.structure.folders.length)
      return toast("Add a folder, block or plan first");
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
  removePlans((p) => p.place === `b:${uid}`);
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
      const parts = placeParts(p.place);
      const week = state.weeks.find((w) => w.uid === parts.week);
      const block = state.blocks.find((b) => b.uid === parts.block);
      const folder = state.folders.find((f) => f.uid === parts.folder);
      // A plan straight in a block names just the block.
      const path = block ? (week ? [block, week] : [block]) : null;
      return {
        uid: p.uid,
        name: p.name.trim(),
        notes: p.notes.trim(),
        folder: folder ? folder.name : null,
        folder_uid: folder ? folder.uid : null,
        group: path && path.map((g) => g.name),
        group_uids: path && path.map((g) => g.uid),
        items: p.items
          .filter((it) => it.name.trim())
          .map((it) => {
            const known = seed(it.name);
            const rpe = toNumber(it.rpe, null);
            return {
              exercise: {
                name: known ? known[0] : it.name.trim(),
                // Kept from an opened file; new exercises go in as "other".
                muscle_group: known ? known[1] : it.muscle_group || "other",
                equipment: known ? known[2] : it.equipment || "",
              },
              target_sets: Math.max(0, Math.round(toNumber(it.sets, 0))),
              target_reps: Math.max(0, Math.round(toNumber(it.reps, 0))),
              target_rpe: rpe != null && rpe >= 1 && rpe <= 10 ? rpe : null,
              rest_seconds: Math.max(0, Math.round(toNumber(it.rest, 90))),
            };
          }),
      };
    });
  // The folders, blocks and weeks themselves, so empty ones go too.
  const folderOf = (uid) => state.folders.find((f) => f.uid === uid);
  const structure = {
    folders: state.folders.map((f) => ({ uid: f.uid, name: f.name })),
    blocks: state.blocks.map((b) => ({
      uid: b.uid,
      name: b.name,
      folder: folderOf(b.folder)?.name ?? null,
      folder_uid: folderOf(b.folder)?.uid ?? null,
    })),
    weeks: state.weeks.map((w) => {
      const block = state.blocks.find((b) => b.uid === w.block);
      return { uid: w.uid, name: w.name, block: block?.name ?? null, block_uid: w.block };
    }),
  };
  return { kind: "gym-planner-plans", version: 1, exported_at: new Date().toISOString(), structure, plans };
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
  // Folders, blocks and weeks first (files from before this lack them), so
  // empty ones open too.
  const structure = file.structure || {};
  const listed = (key) => (Array.isArray(structure[key]) ? structure[key] : []);
  listed("folders").forEach((f) => f?.name && findOrAdd(next.folders, f.uid, String(f.name), {}));
  const fileBlocks = new Map(); // the file's block uid, or name, to the block here
  listed("blocks").forEach((b) => {
    if (!b?.name) return;
    const folder = b.folder ? findOrAdd(next.folders, b.folder_uid, String(b.folder), {}) : null;
    const block = findOrAdd(next.blocks, b.uid, String(b.name), { folder: folder ? folder.uid : null });
    if (b.uid) fileBlocks.set(`uid:${b.uid}`, block);
    fileBlocks.set(`name:${b.name}`, block);
  });
  listed("weeks").forEach((w) => {
    const block = fileBlocks.get(`uid:${w?.block_uid}`) || fileBlocks.get(`name:${w?.block}`);
    if (block && w.name) findOrAdd(next.weeks, w.uid, String(w.name), { block: block.uid });
  });
  file.plans.forEach((p) => {
    const folder = p.folder ? findOrAdd(next.folders, p.folder_uid, String(p.folder), {}) : null;
    let place = folder ? `f:${folder.uid}` : "";
    if (Array.isArray(p.group) && (p.group.length === 1 || p.group.length === 2)) {
      const uids = Array.isArray(p.group_uids) ? p.group_uids : [];
      const block = findOrAdd(next.blocks, uids[0], String(p.group[0]), { folder: folder ? folder.uid : null });
      place = `b:${block.uid}`;
      if (p.group.length === 2) {
        const week = findOrAdd(next.weeks, uids[1], String(p.group[1]), { block: block.uid });
        place = `w:${week.uid}`;
      }
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
    if ((state.plans.length || state.folders.length || state.blocks.length) && !(await sure("Replace what's here with this file's plans?", "Replace"))) return;
    state = next;
    render();
    toast(`Opened ${next.plans.length} plan${next.plans.length === 1 ? "" : "s"}`);
  } catch (err) {
    toast(err.message);
  }
});

$("#exercise-names").innerHTML = SEED_EXERCISES.map(([name]) => `<option value="${esc(name)}">`).join("");
render();
