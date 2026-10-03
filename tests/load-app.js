/* Loads docs/app.js into a Node vm with just enough of a browser around it:
 * a do-nothing DOM, localStorage, and an in-memory IndexedDB that stores
 * structured clones, like the real one. Dependency-free on purpose. */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP = path.join(__dirname, "..", "docs", "app.js");
const EXERCISES = path.join(__dirname, "..", "docs", "exercises.js");

/** Anything the app reaches for on the DOM: callable, any property, never throws. */
function inert() {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get: (target, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined; // not a promise
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
  });
  return proxy;
}

function fakeIndexedDB(stored) {
  const later = (fn) => setTimeout(fn, 0);
  const request = (run) => {
    const req = {};
    later(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  };
  const db = {
    createObjectStore() {},
    transaction: () => ({
      objectStore: () => ({
        get: (key) => request(() => structuredClone(stored.get(key))),
        put: (value, key) =>
          request(() => void stored.set(key, structuredClone(value))),
      }),
    }),
  };
  return {
    open() {
      const req = {};
      later(() => {
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/** A fresh copy of the app. `stored` is the IndexedDB contents (a Map);
 * `prefs` the localStorage contents, as raw strings. */
function loadApp(stored = new Map(), prefs = new Map()) {
  const dom = inert();
  const shared = []; // files handed to the share sheet
  const sharedText = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    structuredClone,
    File,
    Blob,
    Response,
    URL,
    TextEncoder,
    CompressionStream,
    DecompressionStream,
    btoa,
    atob,
    document: dom,
    window: dom,
    navigator: {
      userAgent: "node",
      standalone: false,
      canShare: () => true,
      // Files shared go in `shared`; text (like a plans link) in `sharedText`.
      share: async ({ files, text }) =>
        files ? void shared.push(...files) : void sharedText.push(text),
    },
    // Not localhost: boot stops at the install gate.
    location: { hostname: "example.test", href: "https://example.test/gym_planner/", hash: "" },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    confirm: () => true,
    indexedDB: fakeIndexedDB(stored),
    localStorage: {
      getItem: (k) => (prefs.has(k) ? prefs.get(k) : null),
      setItem: (k, v) => prefs.set(k, String(v)),
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(EXERCISES, "utf8"), context, { filename: EXERCISES });
  vm.runInContext(fs.readFileSync(APP, "utf8"), context, { filename: APP });
  return {
    stored,
    prefs,
    context,
    shared,
    sharedText,
    /** Run an expression inside the app's scope (sees its let/const too). */
    run: (code) => vm.runInContext(code, context),
    /** Forget the in-memory copy, as a reload would. */
    reload() {
      vm.runInContext("dataCache = null", context);
    },
  };
}

module.exports = { loadApp };
