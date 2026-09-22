import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("./theme.js", import.meta.url), "utf8");
function browser({ readyState = "loading", stored = null, dark = false, legacy = false, blocked = false } = {}) {
  const events = {};
  const attributes = {};
  const button = { setAttribute: (key, value) => { attributes[key] = value; }, addEventListener: (name, handler) => { events[name] = handler; } };
  const document = { readyState, documentElement: { dataset: {} }, querySelector: () => button, addEventListener: (name, handler) => { events[name] = handler; } };
  const media = { matches: dark, [legacy ? "addListener" : "addEventListener"]: (...args) => { events.systemChange = args.at(-1); } };
  const storage = new Map(stored ? [["portfel-gpw-theme", stored]] : []);
  runInNewContext(script, { document, window: { matchMedia: () => media }, localStorage: {
    getItem: (key) => { if (blocked) throw Error("Storage blocked"); return storage.get(key); },
    setItem: (key, value) => { if (blocked) throw Error("Storage blocked"); storage.set(key, value); },
  } });
  if (readyState === "loading") events.DOMContentLoaded();
  return { events, attributes, document, storage, media, theme: () => document.documentElement.dataset.theme };
}

for (const readyState of ["loading", "complete"]) {
  for (const legacy of [false, true]) {
    const page = browser({ readyState, legacy });
    assert.equal(page.theme(), "light");
    page.events.click();
    assert.equal(page.theme(), "dark");
    assert.equal(page.attributes["aria-label"], "Włącz jasny motyw");
    assert.equal(browser({ stored: page.storage.get("portfel-gpw-theme") }).theme(), "dark");
    page.events.click();
    assert.equal(page.theme(), "light");
    assert.equal(page.attributes["aria-label"], "Włącz ciemny motyw");
  }
}
const system = browser({ dark: true });
assert.equal(system.theme(), "dark");
system.media.matches = false;
system.events.systemChange();
assert.equal(system.theme(), "light");
const manual = browser({ stored: "light", dark: true });
manual.events.systemChange();
assert.equal(manual.theme(), "light");
const blocked = browser({ blocked: true });
blocked.events.click();
assert.equal(blocked.theme(), "dark");
console.log("Testy przełączania motywu: OK");
