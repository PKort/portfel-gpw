import assert from "node:assert/strict";
import { removeLegacyWorker } from "./legacy-worker.js";

const base = "http://localhost:8080/index.html";
assert.equal(await removeLegacyWorker(undefined, base), false);
let removed = 0;
const registration = (scope, scriptURL, result = true) => ({
  scope, active: { scriptURL },
  unregister: async () => { removed++; return result; },
});
const root = registration("http://localhost:8080/", "http://localhost:8080/sw.js");
const other = registration("http://localhost:8080/other/", "http://localhost:8080/other/sw.js");
const worker = { controller: { scriptURL: root.active.scriptURL }, getRegistrations: async () => [root, other] };
assert.equal(await removeLegacyWorker(worker, base), true);
assert.equal(removed, 1, "Only the application scope is unregistered");
worker.getRegistrations = async () => [other];
assert.equal(await removeLegacyWorker(worker, base), false, "No reload loop after unregistration");
assert.equal(removed, 1);
worker.getRegistrations = async () => [root];
worker.controller = null;
assert.equal(await removeLegacyWorker(worker, base), false, "Uncontrolled pages do not need a reload");
worker.controller = { scriptURL: root.active.scriptURL };
worker.getRegistrations = async () => [registration(root.scope, root.active.scriptURL, false)];
assert.equal(await removeLegacyWorker(worker, base), false);
console.log("Legacy worker tests passed");
