/** Deterministic discovery transport/space benchmark. Not an LLM relevance benchmark. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createSkillCatalogBrowser, catalogSourceHash, CATALOG_TAGS, type CatalogMetadata } from "../src/catalog.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { optimizePayload } from "../src/optimize.ts";
import { EMPTY_PROFILE } from "../src/profile.ts";

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const workTurns = 8;
const instructions = "# Fixture skill\nKeep the public API unchanged. Verify deterministic behavior.\r\n";

function fixture(count: number) {
  const skills = Array.from({ length: count }, (_, index) => ({
    name: `example-${String(index).padStart(5, "0")}`,
    description: `Inspect ${CATALOG_TAGS[index % CATALOG_TAGS.length]!.id} concerns for component ${index} and verify the resulting evidence.`,
  }));
  const metadata: CatalogMetadata = { version: 1, cards: Object.fromEntries(skills.map((skill, index) => [skill.name, {
    summary: skill.description,
    tags: [CATALOG_TAGS[index % CATALOG_TAGS.length]!.id],
    sourceHash: catalogSourceHash(skill.name, skill.description),
  }])) };
  const system = `<available_skills>\n${skills.map((skill) => `<skill><name>${skill.name}</name><description>${skill.description}</description><location>/synthetic/${skill.name}/SKILL.md</location></skill>`).join("\n")}\n</available_skills>`;
  return { skills, metadata, payload: { system, messages: [{ role: "user", content: "Separate the core from HTTP and storage so each part can be tested independently." }] } };
}

function replay(system: string, browsePages: unknown[], initialOverlay = ""): { bytes: number; requests: number } {
  const messages: unknown[] = [{ role: "user", content: "Inspect the component and make a verified change." + initialOverlay }];
  let total = 0;
  let requests = 0;
  const request = () => { total += bytes({ system, messages }); requests++; };
  for (const page of browsePages) {
    request();
    messages.push({ role: "assistant", content: [{ type: "toolCall", name: "skill_search", arguments: { action: "search", tags: ["architecture"] } }] });
    messages.push({ role: "tool", content: JSON.stringify(page) });
  }
  request();
  messages.push({ role: "assistant", content: [{ type: "toolCall", name: "skill_search", arguments: { action: "load", name: "example-00000" } }] });
  messages.push({ role: "tool", content: instructions });
  for (let turn = 0; turn < workTurns; turn++) {
    request();
    messages.push({ role: "assistant", content: `Work step ${turn}: inspect and verify the component.` });
  }
  return { bytes: total, requests };
}

console.log(`Catalog transport benchmark | ${process.platform}/${process.arch} | Node ${process.version}`);
console.log("Synthetic, preassigned tags; no provider calls. Bytes are not tokens, relevance, adherence or model latency.");
for (const count of [355, 2_000, 10_000]) {
  const { skills, metadata, payload } = fixture(count);
  const prepareStart = performance.now();
  const browser = createSkillCatalogBrowser(skills, metadata);
  const snapshotMs = performance.now() - prepareStart;
  const config = { ...DEFAULT_CONFIG, profile: { ...EMPTY_PROFILE, catalog: metadata }, catalogSnapshot: browser };
  const old = optimizePayload(payload, DEFAULT_CONFIG);
  const start = performance.now();
  const current = optimizePayload(payload, config);
  const coldMs = performance.now() - start;
  assert.ok(current.removedChars > old.removedChars, "directory must beat the old initial serialized request");
  assert.ok(current.next.system.length <= 4_000);
  assert.equal(current.addedPrefetchChars, 0);
  const page = browser.browse({ tags: ["architecture"] });
  assert.ok(page.items.some((item) => item.name === "example-00000"), "crosscutting methods are directly browsable");
  assert.ok(bytes(page) <= 3_000, "ASCII fixture page must fit complete response cap");
  const nativeReplay = replay(payload.system, []);
  // Keep the old prefetch in every historical request, so it isn't silently omitted from accounting.
  const oldOverlay = old.next.messages[0]!.content.slice(payload.messages[0]!.content.length);
  const oldReplay = replay(old.next.system, [], oldOverlay);
  const newReplay = replay(current.next.system, [page]);
  assert.ok(newReplay.bytes < oldReplay.bytes, "one browse plus load must still save across eight work requests");
  const deepReplay = replay(current.next.system, Array.from({ length: 5 }, () => page));
  const samples: number[] = [];
  for (let index = 0; index < 10; index++) {
    const started = performance.now(); optimizePayload(payload, config); samples.push(performance.now() - started);
  }
  // Enumerate every card once: no all-name prompt is needed to keep source coverage.
  let cursor: string | undefined;
  const seen = new Set<string>();
  let pages = 0;
  do {
    const next = browser.browse({ cursor, pageSize: 50 });
    for (const item of next.items) { assert.ok(!seen.has(item.name)); seen.add(item.name); }
    assert.equal(next.usedChars, JSON.stringify(next).length);
    assert.ok(next.usedChars <= 3_000);
    cursor = next.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(seen.size, count);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  console.log(JSON.stringify({ skills: count, initialBytes: { native: bytes(payload), previous: bytes(old.next), tags: bytes(current.next) }, directoryChars: current.next.system.length, pageBytes: bytes(page), completeCoverage: `${seen.size}/${count}`, enumerationPages: pages, preparationMs: { snapshot: +snapshotMs.toFixed(2), cold: +coldMs.toFixed(2), warmMean: +mean.toFixed(2) }, replay: { workRequests: workTurns, native: nativeReplay, previous: oldReplay, oneBrowse: newReplay, fiveBrowses: deepReplay }, cumulativeSavingVsPrevious: `${((1 - newReplay.bytes / oldReplay.bytes) * 100).toFixed(1)}%` }));
}
