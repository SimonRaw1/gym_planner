const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./load-app");

const prefsWith = (theme) => new Map([["theme", JSON.stringify(theme)]]);

test("a new phone starts on the Raw Muscle theme", () => {
  const app = loadApp();
  assert.equal(app.run('applyTheme(loadPref("theme", "rawmuscle"))'), "rawmuscle");
  assert.equal(app.prefs.get("theme"), undefined);
});

test("a phone that picked the old Gym theme keeps it, renamed Spicy", () => {
  const app = loadApp(new Map(), prefsWith("default"));
  assert.equal(app.prefs.get("theme"), '"spicy"');
  assert.equal(app.run('applyTheme(loadPref("theme", "rawmuscle"))'), "spicy");
  assert.equal(app.run('THEMES.find(([id]) => id === "spicy")[1]'), "Spicy");
});

test("other saved themes are left alone, and unknown ones fall back", () => {
  assert.equal(loadApp(new Map(), prefsWith("dracula")).prefs.get("theme"), '"dracula"');
  assert.equal(loadApp().run('applyTheme("nope")'), "rawmuscle");
});
