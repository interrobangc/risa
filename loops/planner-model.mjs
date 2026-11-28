// The model a topic's planner runs on: Fable for a registry row flagged
// `design`, else opus. `plan`, the opener and the dispatcher all ask here.
//
// CLI: node planner-model.mjs <topic> <main checkout>   prints the model
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRegistry, plannerModel } from "../backlog/registry.mjs";

export { plannerModel };

/** The planner's model for TOPIC, from MAIN's live registry; opus when it can't be read. */
export function plannerModelFor(/** @type {string} */ topic, /** @type {string} */ main) {
  try {
    const registry = parseRegistry(readFileSync(join(main, "plans/backlog.md"), "utf8"));
    if (registry.format !== "new") return plannerModel(undefined);
    return plannerModel(registry.rows.find((r) => r.topic === topic));
  } catch {
    return plannerModel(undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [topic, main] = process.argv.slice(2);
  if (!topic || !main) {
    console.error("usage: planner-model.mjs <topic> <main checkout>");
    process.exit(2);
  }
  console.log(plannerModelFor(topic, main));
}
