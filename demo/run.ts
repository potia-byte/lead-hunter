import { join, resolve } from "node:path";
import {
  createFixtureDiscovery,
  createFixtureFetchPage,
  createFixtureWebPreview,
  createReplayLlm,
} from "../src/adapters/fixture.js";
import { DEFAULT_LIMITS } from "../src/pipeline.js";
import { funnelOf } from "../src/report.js";
import { executeRun } from "../src/run.js";
import { DEMO_NOW, demoProfile, demoReplies, demoWorld } from "./world.js";

/**
 * npm run demo
 *
 * Runs the full pipeline on a synthetic Telegram world with a canned model.
 * No network, no keys, no Telegram. Output: output/demo/<run>/.
 */

const outDir = resolve(process.argv[2] ?? join("output", "demo"));
const discovery = createFixtureDiscovery(demoWorld);

const { directory, state, result } = await executeRun({
  outDir,
  runId: "demo",
  llm: createReplayLlm(demoReplies),
  fetchPage: createFixtureFetchPage(demoWorld),
  discovery,
  profile: demoProfile,
  webPreview: createFixtureWebPreview(demoWorld),
  limits: {
    ...DEFAULT_LIMITS,
    llmEntityQueries: 0,
    llmPostQueries: 0,
    maxEntityQueries: 10,
    maxPostQueries: 3,
  },
  now: () => DEMO_NOW,
  log: (line) => console.info(`[demo] ${line}`),
});

console.info("\nFunnel:");
for (const [key, value] of Object.entries(funnelOf(state, result)))
  console.info(`  ${key.padEnd(20)} ${value}`);

console.info("\nQualified leads:");
for (const view of result.qualified)
  console.info(
    `  ${String(view.finalScore).padStart(3)}/100  ${view.classification.businessName}  ` +
      `[${view.members.map((member) => `@${member.username}`).join(", ")}]  ` +
      `ad placements: ${view.sightings.length}, dropped claims: ${view.classification.droppedClaims}`,
  );

console.info("\nNot qualified (why):");
for (const view of result.businesses.filter(
  (item) => !result.qualified.includes(item),
))
  console.info(
    `  ${view.classification.businessName}: ${view.classification.rejectReason ?? `score ${view.finalScore} below threshold`}`,
  );
for (const [id, reason] of Object.entries(state.prefilterRejected))
  console.info(`  ${state.entities[id]?.title ?? id}: prefilter - ${reason}`);

console.info(`\nWrote ${directory} (batch.json, report.md, report.json, state.json)`);
console.info(
  `Telegram calls (fixture): ${discovery.calls.length}; the model was a canned replay, see README.`,
);
