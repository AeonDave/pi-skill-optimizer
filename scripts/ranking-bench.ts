/**
 * Small, hand-authored diagnostic fixture, NOT a held-out relevance benchmark.
 * No profiles generated from the queries, private catalogs, or provider calls.
 * Components share the same catalog and labels; lexical scores come from AUTO's
 * BM25F scorer, so this is an ablation, not an independent retrieval implementation.
 */
import assert from "node:assert/strict";
import { planSkillPrefetch, type RankedSkill, type Skill } from "../src/skills.ts";
import { normalizeProfile } from "../src/profile.ts";

const catalog: Skill[] = [
	["git", "Version control commits branches merges and repository history."],
	["database-migration", "PostgreSQL schema migrations and rollback validation."],
	["database-backup", "PostgreSQL backups, snapshots and recovery from data loss."],
	["browser-testing", "Playwright end-to-end browser tests, screenshots and responsive accessibility."],
	["unit-testing", "Isolated unit tests with assertions, mocks and test fixtures."],
	["incident-response", "Production outage triage using logs, metrics and service recovery."],
	["image-editing", "Digital illustration, photography, cropping and image resizing."],
	["release-packaging", "Build and package release artifacts for distribution."],
	["changelog-writing", "Write changelog entries and release notes from commit history."],
	["api-design", "Design HTTP endpoint contracts, request validation and pagination."],
	["react-performance", "Profile React rendering, component updates and frontend latency."],
	["python-profiling", "Measure Python CPU time, allocation and memory bottlenecks."],
	["localization", "Translate user interface strings and adapt locale-specific formatting."],
	["container-build", "Docker images, container layers and build cache."],
].map(([name, description]) => ({ name, description, location: `/synthetic/${name}/SKILL.md` }));

interface Case { query: string; relevant: string[] }
const cases: Case[] = [
	{ query: "git", relevant: ["git"] },
	{ query: "Please load database-migration", relevant: ["database-migration"] },
	{ query: "Validate a PostgreSQL schema rollback", relevant: ["database-migration"] },
	{ query: "Restore a PostgreSQL backup after data loss", relevant: ["database-backup"] },
	{ query: "Playwright accessibility screenshots", relevant: ["browser-testing"] },
	{ query: "Mock dependencies in an isolated unit test", relevant: ["unit-testing"] },
	{ query: "Triage a production outage from logs", relevant: ["incident-response"] },
	{ query: "digital photography", relevant: ["image-editing"] },
	{ query: "Package release artifacts", relevant: ["release-packaging"] },
	{ query: "Write release notes", relevant: ["changelog-writing"] },
	{ query: "HTTP request validation and pagination", relevant: ["api-design"] },
	{ query: "React rendering latency", relevant: ["react-performance"] },
	{ query: "Python memory allocations", relevant: ["python-profiling"] },
	{ query: "Translate locale formatting", relevant: ["localization"] },
	{ query: "Docker build cache", relevant: ["container-build"] },
	{ query: "databse-migraton", relevant: ["database-migration"] },
	{ query: "browser-testng", relevant: ["browser-testing"] },
	{ query: "changelg-writing", relevant: ["changelog-writing"] },
];
const negatives = ["", "the and of", "zqxvplm", "quokka marmalade"];
const variants = ["BM25F only", "AUTO without fuzzy", "AUTO"] as const;

function rank(query: string, variant: typeof variants[number]): RankedSkill[] {
	const plan = planSkillPrefetch(catalog, query, {
		fuzzyCandidateLimit: variant === "AUTO" ? 8 : 0,
		minTopK: 3, targetTopK: 5, maxTopK: 8,
	});
	return variant === "BM25F only"
		? plan.ranked.filter((entry) => entry.lexicalScore > 0)
			.sort((a, b) => b.lexicalScore - a.lexicalScore || a.skill.name.localeCompare(b.skill.name))
		: plan.ranked;
}

console.log(`Routing diagnostics | ${catalog.length} synthetic skills | ${cases.length} positive / ${negatives.length} no-signal cases`);
console.log("Variant | Recall@1 | Recall@5 | MRR | No-signal promotions");
for (const variant of variants) {
	let recall1 = 0;
	let recall5 = 0;
	let reciprocalRank = 0;
	for (const item of cases) {
		const ranked = rank(item.query, variant).map((entry) => entry.skill.name);
		assert.deepEqual(ranked, rank(item.query, variant).map((entry) => entry.skill.name), "determinism");
		recall1 += item.relevant.filter((name) => ranked.slice(0, 1).includes(name)).length / item.relevant.length;
		recall5 += item.relevant.filter((name) => ranked.slice(0, 5).includes(name)).length / item.relevant.length;
		const first = ranked.findIndex((name) => item.relevant.includes(name));
		reciprocalRank += first < 0 ? 0 : 1 / (first + 1);
	}
	const falsePositives = negatives.filter((query) => rank(query, variant).length > 0).length;
	console.log(`${variant} | ${(100 * recall1 / cases.length).toFixed(1)}% | ${(100 * recall5 / cases.length).toFixed(1)}% | ${(reciprocalRank / cases.length).toFixed(3)} | ${falsePositives}/${negatives.length}`);
}

// Regression gate independent of the fixture's quality averages.
const misleading = rank("digital photography", "AUTO").find((entry) => entry.skill.name === "git");
assert.equal(misleading?.exactScore ?? 0, 0, "git must not be an exact name match inside digital");
console.log("Interpretation: component diagnostics only; not a claim of best algorithm or real-user/model recall.");

// Independent exact-channel boundary fixture: a broad alias must not outrank
// stronger BM25F evidence, while domain-specific lexical retrieval still works.
const boundaryCatalog: Skill[] = [
	{ name: "arjun", description: "HTTP parameter discovery through active parameter testing to find hidden query inputs.", location: "/synthetic/web/arjun/SKILL.md" },
	{ name: "ci-stability", description: "Reliability guidance for flaky automated testing suites under parallel execution when shared mutable state, order dependence, or races cause intermittent failures.", location: "/synthetic/testing/ci-stability/SKILL.md" },
	{ name: "can-bus-modules", description: "Hardware CAN bus interface over SPI using an MCP2515 to inspect OBD-II frames.", location: "/synthetic/hardware/can-bus-modules/SKILL.md" },
];
const boundaryProfile = normalizeProfile({ queries: {
	"ci-stability": ["Fix flaky suite failures in CI when parallel workers share mutable state"],
} });
const boundaryOptions = { profile: boundaryProfile, fuzzyCandidateLimit: 0, minTopK: 1, targetTopK: 1, maxTopK: 1 };
const ciQuery = "After parallel CI starts, a regression test passes alone but fails intermittently because fixtures share mutable state.";
const ciPlan = planSkillPrefetch(boundaryCatalog, ciQuery, boundaryOptions);
const ciTarget = ciPlan.ranked.find((entry) => entry.skill.name === "ci-stability");
const aliasDistractor = ciPlan.ranked.find((entry) => entry.skill.name === "arjun");
assert.ok(ciTarget && aliasDistractor);
assert.ok(ciTarget.lexicalScore > aliasDistractor.lexicalScore);
assert.equal(aliasDistractor.exactScore, 0);
assert.equal(ciPlan.ranked[0].skill.name, "ci-stability");

const canPlan = planSkillPrefetch(boundaryCatalog, "Connect an MCP2515 over SPI to inspect CAN bus OBD-II frames", boundaryOptions);
assert.equal(canPlan.ranked[0]?.skill.name, "can-bus-modules");
const apiPlan = planSkillPrefetch(boundaryCatalog, "Fuzz HTTP query parameters to discover hidden application inputs", boundaryOptions);
assert.equal(apiPlan.ranked[0]?.skill.name, "arjun");
const exactNamePlan = planSkillPrefetch(boundaryCatalog, "Please load can-bus-modules", boundaryOptions);
assert.ok((exactNamePlan.ranked.find((entry) => entry.skill.name === "can-bus-modules")?.exactScore ?? 0) >= 8);
assert.equal(planSkillPrefetch(boundaryCatalog, "quokka marmalade", boundaryOptions).hasSignal, false);
console.log("Exact-channel boundary fixture: CI reliability wins over generic test alias; CAN hardware, HTTP parameters, exact names, and no-signal retain their expected outcomes.");

// Separate support-coverage diagnostic: reviewed tags, not generated-model quality.
const contextualCatalog: Skill[] = [
	{ name: "database-migration", description: "PostgreSQL schema migration.", location: "/synthetic/db/SKILL.md" },
	{ name: "software-architecture", description: "Boundaries, contracts and modularity.", location: "/synthetic/architecture/SKILL.md" },
	{ name: "test-driven-development", description: "Regression discipline before implementation.", location: "/synthetic/discipline/SKILL.md" },
];
for (const [support, kind] of [["software-architecture", "workflow"], ["test-driven-development", "behavioral"]] as const) {
	const profile = normalizeProfile({ activation: {
		"database-migration": { kind: "specialist", tasks: ["software-change"] },
		[support]: { kind, tasks: ["software-change"] },
	} });
	const bounds = { minTopK: 2, targetTopK: 2, maxTopK: 2 };
	const baseline = planSkillPrefetch(contextualCatalog, "PostgreSQL schema migration", bounds);
	const contextual = planSkillPrefetch(contextualCatalog, "PostgreSQL schema migration", { ...bounds, profile });
	assert.ok(!baseline.selectedNames.includes(support));
	assert.deepEqual(contextual.selectedNames, ["database-migration", support]);
	assert.equal(contextual.ranked.find((entry) => entry.skill.name === support)?.reasons.includes("contextual"), true);
	assert.deepEqual(planSkillPrefetch(contextualCatalog, "quokka marmalade", { ...bounds, profile }).selectedNames, []);
}
console.log("Contextual diagnostics: workflow 1/1, behavioral 1/1, no-signal 0/2; reviewed tags, not LLM classification accuracy.");
