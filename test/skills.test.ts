import assert from "node:assert/strict";
import { test } from "node:test";
import {
	auditSkillDescriptions,
	catalogFingerprint,
	compactDescription,
	inspectStableSkillCatalog,
	optimizeSkillCatalog,
	parseSkills,
	planSkillPrefetch,
	renderSkillPrefetch,
	renderStableSkillCatalog,
	searchSkillCatalog,
	tokenize,
	type Skill,
} from "../src/skills.ts";
import { normalizeProfile } from "../src/profile.ts";

function skillXml(name: string, description: string, location = `C:/skills/${name}/SKILL.md`): string {
	return `  <skill>
    <name>${name}</name>
    <description>${description}</description>
    <location>${location}</location>
  </skill>`;
}

function catalog(...skills: string[]): string {
	return `lead
<available_skills>
${skills.join("\n")}
</available_skills>
tail`;
}

function skill(name: string, description: string, location = `C:/skills/${name}/SKILL.md`): Skill {
	return { name, description, location };
}

const LONG = " Detailed implementation notes that are useful only after the skill has been selected.".repeat(8);

test("tokenize handles Unicode, camel case, separators, stopwords, and entities", () => {
	assert.deepEqual(tokenize("Use GitHubAddressComments per l'applicazione &quot;mobile&quot;"), [
		"github", "address", "comments", "applicazione", "mobile",
	]);
	assert.deepEqual(tokenize("a to of 4096"), []);
});

test("parseSkills reads canonical XML and the dense TSV representation", () => {
	const source = catalog(
		skillXml("alpha", "Alpha workflow."),
		skillXml("odd", "Odd workflow.", "C:/custom/odd.md"),
	);
	assert.deepEqual(parseSkills(source).map(({ name }) => name), ["alpha", "odd"]);
	const stable = renderStableSkillCatalog(source);
	assert.ok(stable.removedChars > 0);
	const parsed = parseSkills(stable.text);
	assert.deepEqual(parsed.map(({ name }) => name), ["alpha", "odd"]);
	assert.equal(parsed.find(({ name }) => name === "odd")?.location, "");
	assert.ok(!stable.text.includes("C:/custom/odd.md"));
});

test("stable catalog is query-independent, dense, discoverable, and loadable", () => {
	const source = catalog(
		skillXml("rsa-recovery", `Recover weak RSA private keys. Use when solving public-key challenges.${LONG}`),
		skillXml("python-testing", `Python regression testing and fixtures. Use when validating Python changes.${LONG}`),
		skillXml("odd", `Custom workflow. Use when the custom case applies.${LONG}`, "D:/special/custom.md"),
	);
	const rsa = optimizeSkillCatalog(source, "recover rsa private key");
	const python = optimizeSkillCatalog(source, "write pytest fixtures");
	assert.equal(rsa.text, python.text);
	assert.match(rsa.text, /skill-optimizer:auto:v2/);
	assert.match(rsa.text, /<skill_index format="tsv"/);
	assert.match(rsa.text, /skill_search/);
	assert.ok(!rsa.text.includes("C:/skills"));
	assert.ok(!rsa.text.includes("D:/special/custom.md"));
	for (const name of ["rsa-recovery", "python-testing", "odd"]) assert.ok(rsa.text.includes(name));
	assert.ok(!rsa.text.includes("Detailed implementation notes"));
	assert.deepEqual(rsa.plan.selectedNames, ["rsa-recovery"]);
	assert.deepEqual(python.plan.selectedNames, ["python-testing"]);
});

test("stable rendering is identity-idempotent and transforms every catalog", () => {
	const block = `<available_skills>
${skillXml("alpha", `Alpha workflow.${LONG}`)}
${skillXml("beta", `Beta workflow.${LONG}`)}
</available_skills>`;
	const first = renderStableSkillCatalog(`${block}\n${block}`);
	assert.equal((first.text.match(/skill-optimizer:auto:v2/g) ?? []).length, 2);
	const second = renderStableSkillCatalog(first.text);
	assert.equal(second.text, first.text);
	assert.equal(second.removedChars, 0);
});

test("stable catalog inspection matches the rendered floor and cached results stay isolated", () => {
	const source = catalog(
		skillXml("alpha", `Alpha workflow.${LONG}`),
		skillXml("beta", `Beta workflow.${LONG}`),
	);
	const inspection = inspectStableSkillCatalog(source);
	const first = renderStableSkillCatalog(source, { budgetChars: inspection.floorChars });
	assert.equal(first.budget.floorChars, inspection.floorChars);
	assert.deepEqual(first.skills.map((entry) => entry.name), ["alpha", "beta"]);
	first.skills[0].name = "mutated-consumer-copy";
	first.budget.usedChars = -1;
	const second = renderStableSkillCatalog(source, { budgetChars: inspection.floorChars });
	assert.deepEqual(second.skills.map((entry) => entry.name), ["alpha", "beta"]);
	assert.equal(second.budget.usedChars >= 0, true);
});

test("explicit exclusions are applied to the stable index", () => {
	const source = catalog(
		skillXml("alpha", `Alpha workflow.${LONG}`),
		skillXml("python-testing", `Python workflow.${LONG}`),
		skillXml("python-patterns", `Python patterns.${LONG}`),
	);
	const stable = renderStableSkillCatalog(source, { never: ["alpha", "python-*"] });
	assert.deepEqual(stable.skills, []);
	assert.ok(!stable.text.includes("alpha"));
	assert.ok(!stable.text.includes("python-testing"));
});

test("BM25F and exact-name signals select the specialist", () => {
	const skills = [
		skill("rsactftool", "RSA testing automation for weak public keys and private-key recovery."),
		skill("hashcat", "GPU password hash cracking."),
		skill("python-testing", "Python test fixtures."),
	];
	const plan = planSkillPrefetch(skills, "recover an RSA private key", {
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.equal(plan.hasSignal, true);
	assert.deepEqual(plan.selectedNames, ["rsactftool"]);
	assert.ok(plan.ranked[0].reasons.includes("lexical"));
});

test("exact name matching does not match inside a longer token", () => {
	const plan = planSkillPrefetch([skill("git", "Version control workflows.")], "digital", {
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.equal(plan.hasSignal, false);
	assert.deepEqual(plan.ranked, []);
});

test("profile query matching does not match inside a longer token", () => {
	const plan = planSkillPrefetch([skill("release-guide", "Release guidance.")], "digital", {
		profile: normalizeProfile({ queries: { "release-guide": ["git"] } }),
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.equal(plan.hasSignal, false);
	assert.deepEqual(plan.ranked, []);
});

test("alias-only test overlap cannot outrank reliability evidence", () => {
	const skills = [
		skill("arjun", "HTTP parameter testing for finding hidden request inputs."),
		skill("testing-reliability", "Testing reliability for flaky tests that pass locally but fail in CI because shared state leaks across workers."),
	];
	const profile = normalizeProfile({ queries: {
		"testing-reliability": ["Diagnose tests passing locally but failing in CI due to shared state"],
	} });
	const plan = planSkillPrefetch(
		skills,
		"This test passes locally but randomly fails in CI because shared state leaks between parallel workers.",
		{ profile, minTopK: 1, targetTopK: 1, maxTopK: 1 },
	);
	const reliability = plan.ranked.find(({ skill: entry }) => entry.name === "testing-reliability");
	const unrelated = plan.ranked.find(({ skill: entry }) => entry.name === "arjun");
	assert.ok(reliability && unrelated);
	assert.ok(reliability.lexicalScore > unrelated.lexicalScore);
	assert.equal(plan.ranked[0].skill.name, "testing-reliability");
	assert.equal(unrelated.exactScore, 0, "a generic test/testing alias is not an exact match");
});

test("only whole-name or exact profile-phrase matches enter the exact channel", () => {
	const hardware = planSkillPrefetch([
		skill("can-bus-modules", "CAN bus hardware interface over SPI."),
	], "Plan application modules and boundaries", { minTopK: 1, targetTopK: 1, maxTopK: 1 });
	assert.ok(hardware.ranked[0].lexicalScore > 0);
	assert.equal(hardware.ranked[0].exactScore, 0, "one generic name token is only lexical evidence");
	const domainSkills = [
		skill("can-bus-modules", "Hardware CAN bus interface over SPI using an MCP2515 to inspect OBD-II frames."),
		skill("software-architecture", "Design software modules, API boundaries, data contracts, and testable storage."),
		skill("arjun", "HTTP parameter fuzzing to discover hidden query inputs."),
	];
	assert.equal(planSkillPrefetch(domainSkills, "Connect a CAN bus interface over SPI to inspect OBD-II frames", {
		minTopK: 1, targetTopK: 1, maxTopK: 1,
	}).selectedNames[0], "can-bus-modules");
	assert.equal(planSkillPrefetch(domainSkills, "Fuzz HTTP query parameters to discover hidden request inputs", {
		minTopK: 1, targetTopK: 1, maxTopK: 1,
	}).selectedNames[0], "arjun");

	const reorderedName = planSkillPrefetch([
		skill("database-migration", "Database change workflow."),
	], "migration database", { minTopK: 1, targetTopK: 1, maxTopK: 1 });
	assert.equal(reorderedName.ranked[0].exactScore, 8, "all skill-name terms still count as exact");

	const profilePhrase = planSkillPrefetch([
		skill("release-guide", "Release workflow guidance."),
	], "Please stage a canary rollout now", {
		profile: normalizeProfile({ queries: { "release-guide": ["stage a canary rollout"] } }),
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.equal(profilePhrase.ranked[0].exactScore, 7, "an exact learned phrase keeps its exact signal");
});

test("ranking treats prototype-named skill owners as ordinary names", () => {
	const failures: string[] = [];
	for (const name of ["constructor", "toString", "__proto__"]) {
		try {
			const plan = planSkillPrefetch(
				[skill(name, "Routing guide for safe changes.")],
				"routing guide",
				{ profile: normalizeProfile({}), minTopK: 1, targetTopK: 1, maxTopK: 1 },
			);
			assert.deepEqual(plan.selectedNames, [name]);
		} catch (error) {
			failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	assert.deepEqual(failures, []);
});

test("reviewed aliases route APK and plugin wording without mutable global state", () => {
	const skills = [
		skill("mobile-technique", "Android application reverse engineering."),
		skill("pi-extension-creator", "Create and debug a Pi extension package."),
		skill("python-testing", "Python regression tests."),
	];
	assert.equal(planSkillPrefetch(skills, "analyze apk", { minTopK: 1, targetTopK: 1, maxTopK: 1 }).selectedNames[0], "mobile-technique");
	assert.equal(planSkillPrefetch(skills, "fix this plugin", { minTopK: 1, targetTopK: 1, maxTopK: 1 }).selectedNames[0], "pi-extension-creator");
});

test("bounded fuzzy recall preserves a discriminating suffix before truncation", () => {
	const skills = Array.from({ length: 12 }, (_, index) =>
		skill(`crypto-${index}`, "Unrelated specialist operation."));
	const plan = planSkillPrefetch(skills, "cryptp-7", {
		fuzzyCandidateLimit: 3,
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.equal(plan.ranked.length, 3);
	assert.deepEqual(plan.selectedNames, ["crypto-7"]);
});

test("no-signal cannot be manufactured by fuzzy or usage, but critical remains explicit", () => {
	const skills = [
		skill("hashcat", "GPU password cracking."),
		skill("nmap", "Network discovery."),
	];
	const plan = planSkillPrefetch(skills, "日本語 🔥", {
		profile: normalizeProfile({ critical: ["nmap"] }),
		usagePrior: { hashcat: 1000 },
	});
	assert.equal(plan.hasSignal, false);
	assert.deepEqual(plan.ranked, []);
	assert.deepEqual(plan.selectedNames, ["nmap"]);
});

test("fuzzy recall is bounded to names and reviewed alias labels", () => {
	const skills = [
		skill("rsactftool", "Specialized public-key workflow."),
		skill("pi-extension-creator", "Create an extension package."),
		skill("network-audit", "Network assessment."),
	];
	assert.deepEqual(
		planSkillPrefetch(skills, "rsactftol", { minTopK: 1, targetTopK: 1, maxTopK: 1 }).selectedNames,
		["rsactftool"],
	);
	assert.deepEqual(
		planSkillPrefetch(skills, "plugi", { minTopK: 1, targetTopK: 1, maxTopK: 1 }).selectedNames,
		["pi-extension-creator"],
	);
	assert.equal(planSkillPrefetch(skills, "plug").hasSignal, false);
});

test("usage is a bounded ranking prior, never an independent match", () => {
	const skills = [
		skill("alpha", "Shared deployment workflow."),
		skill("beta", "Shared deployment workflow."),
		skill("unrelated", "Database maintenance."),
	];
	const plan = planSkillPrefetch(skills, "deployment workflow", {
		usagePrior: { beta: 10, unrelated: 1000 },
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.deepEqual(plan.selectedNames, ["beta"]);
	assert.ok(!plan.ranked.some(({ skill: entry }) => entry.name === "unrelated"));
});

test("cluster diversity avoids spending adjacent slots on redundant skills", () => {
	const skills = [
		skill("alpha", "Shared cloud deployment workflow."),
		skill("beta", "Shared cloud deployment workflow."),
		skill("gamma", "Shared cloud deployment workflow."),
	];
	const profile = normalizeProfile({ clusters: { same_family: ["alpha", "beta"], alternative: ["gamma"] } });
	const plan = planSkillPrefetch(skills, "cloud deployment workflow", {
		profile,
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 2,
	});
	assert.equal(plan.selectedNames[0], "alpha");
	assert.equal(plan.selectedNames[1], "gamma");
});

test("marginal budget skips an oversized result and continues to a useful candidate", () => {
	const skills = [
		skill("alpha-target", `Target workflow.${" Huge detail.".repeat(500)}`),
		skill("beta-target", "Target workflow with concise guidance."),
		skill("unrelated", "Database maintenance."),
	];
	const plan = planSkillPrefetch(skills, "target workflow", {
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 2,
		fullRenderBudgetChars: 300,
	});
	assert.ok(plan.skippedForBudget.includes("alpha-target"));
	assert.deepEqual(plan.selectedNames, ["beta-target"]);
	assert.ok(plan.marginalChars <= 300);
});

test("high-confidence exact matches contract adaptive K", () => {
	const skills = [
		skill("rsa-recovery", "Recover RSA keys."),
		skill("rsa-audit", "Audit RSA parameters."),
		skill("crypto-general", "General cryptography."),
		skill("openssl", "OpenSSL commands."),
	];
	const plan = planSkillPrefetch(skills, "rsa recovery", {
		minTopK: 1,
		targetTopK: 2,
		maxTopK: 4,
	});
	assert.ok(plan.confidence >= 0.8);
	assert.deepEqual(plan.selectedNames, ["rsa-recovery"]);
});

test("negative hints demote a superficially matching skill", () => {
	const skills = [
		skill("web-review", "Review web application code."),
		skill("web-exploit", "Test web application vulnerabilities."),
	];
	const profile = normalizeProfile({ negativeHints: { "web-exploit": ["review"] } });
	const plan = planSkillPrefetch(skills, "review web application", {
		profile,
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.deepEqual(plan.selectedNames, ["web-review"]);
});

test("prefetch content is separate from the cache-stable base", () => {
	const fullDescription = `RSA recovery workflow.${LONG}`;
	const source = catalog(
		skillXml("rsa-recovery", fullDescription),
		skillXml("python-testing", `Python testing workflow.${LONG}`),
	);
	const result = optimizeSkillCatalog(source, "rsa recovery", { minTopK: 1, targetTopK: 1, maxTopK: 1 });
	assert.ok(!result.text.includes(fullDescription));
	const prefetch = renderSkillPrefetch(result.plan);
	assert.ok(prefetch.includes(fullDescription));
	assert.match(prefetch, /skill_search/);
	assert.match(prefetch, /Catalog metadata only, not loaded instructions or usage evidence/);
	assert.match(prefetch, /skill_search\(action=load, name\); no acknowledgment is needed/);
	assert.ok(!prefetch.includes("C:/skills"));
	assert.match(prefetch, /catalog_sha256="[a-f0-9]{64}"/);
});

test("stable budget preserves every name and degrades selected rows to name-only", () => {
	const source = catalog(
		skillXml("alpha", `Alpha workflow.${LONG}`),
		skillXml("beta", `Beta workflow.${LONG}`),
		skillXml("gamma", `Gamma workflow.${LONG}`),
	);
	const floor = renderStableSkillCatalog(source, { budgetChars: 0 });
	const budgeted = renderStableSkillCatalog(source, { budgetChars: floor.budget.floorChars + 20 });
	assert.deepEqual(parseSkills(budgeted.text).map(({ name }) => name), ["alpha", "beta", "gamma"]);
	assert.ok(budgeted.budget.nameOnlyCount > 0);
	assert.ok(budgeted.budget.intentCount > 0);
	assert.ok(budgeted.budget.usedChars <= budgeted.budget.requestedChars);
	assert.equal(floor.budget.overBudgetChars, floor.budget.floorChars);
	assert.equal(floor.budget.nameOnlyCount, 3);
});

test("searchSkillCatalog paginates the shared ranker with bound opaque cursors", () => {
	const skills = [
		skill("alpha-deploy", "Cloud deployment release workflow."),
		skill("beta-deploy", "Cloud deployment rollback workflow."),
		skill("gamma-deploy", "Cloud deployment verification workflow."),
	];
	const first = searchSkillCatalog(skills, "cloud deployment", { pageSize: 1 });
	assert.equal(first.items.length, 1);
	assert.ok(first.nextCursor);
	const second = searchSkillCatalog(skills, "cloud deployment", {
		pageSize: 1,
		cursor: first.nextCursor,
	});
	assert.equal(second.items.length, 1);
	assert.notEqual(second.items[0].name, first.items[0].name);
	assert.throws(() => searchSkillCatalog(skills, "different query", {
		cursor: first.nextCursor,
	}), /Invalid or stale/);
});

test("search cursors reject usage changes that reorder ranked results", () => {
	const skills = [
		skill("alpha", "Cloud deployment workflow."),
		skill("beta", "Cloud deployment workflow."),
		skill("gamma", "Cloud deployment workflow."),
	];
	const first = searchSkillCatalog(skills, "cloud deployment", { pageSize: 1 });
	assert.equal(first.items[0]?.name, "alpha");
	assert.throws(() => searchSkillCatalog(skills, "cloud deployment", {
		pageSize: 1,
		cursor: first.nextCursor,
		usagePrior: { beta: 100 },
	}), /Invalid or stale/);
});

test("search cursors reject profile changes that reorder ranked results", () => {
	const skills = [
		skill("alpha", "Cloud deployment workflow."),
		skill("beta", "Cloud deployment workflow."),
		skill("gamma", "Cloud deployment workflow."),
	];
	const first = searchSkillCatalog(skills, "cloud deployment", { pageSize: 1 });
	assert.equal(first.items[0]?.name, "alpha");
	assert.throws(() => searchSkillCatalog(skills, "cloud deployment", {
		pageSize: 1,
		cursor: first.nextCursor,
		profile: normalizeProfile({ negativeHints: { alpha: ["cloud"] } }),
	}), /Invalid or stale/);
});

test("rank-neutral usage changes preserve search pagination", () => {
	const skills = [
		skill("alpha", "Cloud deployment workflow."),
		skill("beta", "Cloud deployment workflow."),
		skill("gamma", "Cloud deployment workflow."),
	];
	const first = searchSkillCatalog(skills, "cloud deployment", { pageSize: 1 });
	const second = searchSkillCatalog(skills, "cloud deployment", {
		pageSize: 1,
		cursor: first.nextCursor,
		usagePrior: { alpha: 100 },
	});
	assert.equal(second.items[0]?.name, "beta");
});

test("searchSkillCatalog marks an exact-name hit as high confidence", () => {
	const result = searchSkillCatalog([
		skill("rsa-recovery", "Recover weak RSA keys."),
		skill("rsa-audit", "Audit RSA parameters."),
	], "rsa recovery");
	assert.equal(result.items[0].name, "rsa-recovery");
	assert.ok(result.items[0].confidence >= 0.95);
});

test("catalog fingerprints are full SHA-256 and content-sensitive", () => {
	const first = catalogFingerprint([skill("alpha", "one")]);
	const second = catalogFingerprint([skill("alpha", "two")]);
	assert.match(first, /^[a-f0-9]{64}$/);
	assert.notEqual(first, second);
});

test("description audit reports source-level token waste and routing defects", () => {
	const duplicated = "Detailed deployment checklist for release workflows with rollback verification. Use when shipping a release.";
	const report = auditSkillDescriptions([
		skill("too-long", `Long specialist guidance. Use when handling releases.${" detail".repeat(200)}`),
		skill("empty", "Tiny"),
		skill("missing-route", "Detailed packet inspection and protocol analysis guidance."),
		skill("duplicate-a", duplicated),
		skill("duplicate-b", duplicated),
	], { maxChars: 120 });
	assert.equal(report.counts.too_long, 1);
	assert.equal(report.counts.near_empty, 1);
	assert.equal(report.counts.missing_routing, 1);
	assert.equal(report.counts.duplicate_description, 1);
	assert.equal(report.issues.find(({ code }) => code === "duplicate_description")?.relatedSkill, "duplicate-a");
	assert.ok(report.estimatedReducibleChars > 0);
});

test("compactDescription preserves routing signal inside one hard limit", () => {
	const compact = compactDescription(
		"A deliberately long first sentence with implementation details that need truncation. Middle detail. Use when routing a specialist request.",
		72,
	);
	assert.ok(compact.length <= 72);
	assert.match(compact, /Use when/);
});

test("a positive specialist match reserves one bounded contextual skill without changing direct search ranking", () => {
	const skills = [
		skill("database-migration", "Plan safe database schema changes and data migrations. Use when changing persistent storage."),
		skill("software-architecture", "Design system boundaries, dependencies, and tradeoffs. Use when choosing architecture for a system."),
		skill("test-driven-development", "Plan a test-first software change. Use when implementing or validating a code change."),
		skill("documentation-review", "Review user-facing documentation. Use when reviewing product documentation."),
	];
	const profile = normalizeProfile({ activation: {
		"database-migration": { kind: "specialist", tasks: ["software-change"] },
		"software-architecture": { kind: "workflow", tasks: ["software-change"] },
		"test-driven-development": { kind: "workflow", tasks: ["software-test"] },
		"documentation-review": { kind: "behavioral", tasks: ["docs-review"] },
	} });
	const plan = planSkillPrefetch(skills, "database migration", {
		profile,
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 3,
	});
	assert.deepEqual(plan.selectedNames, ["database-migration", "software-architecture"]);
	assert.deepEqual(plan.ranked.map(({ skill: entry }) => entry.name), [
		"database-migration", "software-architecture",
	]);
	assert.deepEqual(plan.ranked[0].reasons, ["exact", "lexical"]);
	assert.deepEqual(plan.ranked[1].reasons, ["contextual"]);
	assert.equal(plan.ranked[1].score, 0);

	const search = searchSkillCatalog(skills, "database migration", { profile, pageSize: 5 });
	assert.equal(search.total, 2);
	assert.deepEqual(search.items.map(({ name }) => name), ["database-migration", "software-architecture"]);
	assert.deepEqual(search.items[1].reasons, ["contextual"]);
});

test("behavioral activation tags can supply one contextual skill", () => {
	const skills = [
		skill("api-implementation", "Implement application programming interfaces."),
		skill("test-driven-development", "Use a test-first workflow for software changes."),
	];
	const profile = normalizeProfile({ activation: {
		"api-implementation": { kind: "specialist", tasks: ["software-test"] },
		"test-driven-development": { kind: "behavioral", tasks: ["software-test"] },
	} });
	const plan = planSkillPrefetch(skills, "api implementation", {
		profile,
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 2,
	});
	assert.deepEqual(plan.selectedNames, ["api-implementation", "test-driven-development"]);
	assert.deepEqual(plan.ranked[1].reasons, ["contextual"]);
});

test("contextual skills require a positively selected specialist and never cascade", () => {
	const skills = [
		skill("feature-specialist", "Plan database schema changes and data migrations."),
		skill("software-architecture", "Design system boundaries and dependencies."),
		skill("dependency-analysis", "Inspect dependency graphs and package coupling."),
		skill("documentation-review", "Review documentation and user-facing guides."),
	];
	const profile = normalizeProfile({ activation: {
		"feature-specialist": { kind: "specialist", tasks: ["software-change", "software-debug"] },
		"software-architecture": { kind: "workflow", tasks: ["software-change", "software-debug"] },
		"dependency-analysis": { kind: "workflow", tasks: ["software-debug"] },
		"documentation-review": { kind: "behavioral", tasks: ["docs-review"] },
	} });
	const matched = planSkillPrefetch(skills, "database migration", {
		profile,
		minTopK: 1,
		targetTopK: 2,
		maxTopK: 3,
	});
	assert.deepEqual(matched.selectedNames, ["feature-specialist", "software-architecture"]);
	assert.equal(matched.selectedNames.includes("dependency-analysis"), false);
	assert.equal(matched.selectedNames.includes("documentation-review"), false);

	const unmatched = planSkillPrefetch(skills, "unrelated request", { profile });
	assert.equal(unmatched.hasSignal, false);
	assert.deepEqual(unmatched.selectedNames, []);
	assert.deepEqual(unmatched.ranked, []);
	const protectedOnly = planSkillPrefetch(skills, "unrelated request", {
		profile,
		always: ["feature-specialist"],
	});
	assert.deepEqual(protectedOnly.selectedNames, ["feature-specialist"]);
});

test("contextual inclusion obeys count, exclusion, negative-hint, and render budgets", () => {
	const skills = [
		skill("feature-specialist", "Database migration."),
		skill("software-architecture", `Architecture and dependency guidance.${LONG}`),
	];
	const profile = normalizeProfile({
		activation: {
			"feature-specialist": { kind: "specialist", tasks: ["software-change"] },
			"software-architecture": { kind: "workflow", tasks: ["software-change"] },
		},
		negativeHints: { "software-architecture": ["database"] },
	});
	const oneSlot = planSkillPrefetch(skills, "feature specialist", {
		profile,
		minTopK: 1,
		targetTopK: 1,
		maxTopK: 1,
	});
	assert.deepEqual(oneSlot.selectedNames, ["feature-specialist"]);

	const excluded = planSkillPrefetch(skills, "database migration", {
		profile,
		never: ["software-architecture"],
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 2,
	});
	assert.deepEqual(excluded.selectedNames, ["feature-specialist"]);

	const negated = planSkillPrefetch(skills, "database migration", {
		profile,
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 2,
	});
	assert.equal(negated.selectedNames.includes("software-architecture"), false);

	const directOnly = planSkillPrefetch(skills, "database migration", {
		profile: normalizeProfile({ activation: {
			"feature-specialist": { kind: "specialist", tasks: ["software-change"] },
			"software-architecture": { kind: "workflow", tasks: ["software-change"] },
		} }),
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 2,
		fullRenderBudgetChars: planSkillPrefetch(skills, "database migration", {
			minTopK: 2,
			targetTopK: 2,
			maxTopK: 2,
		}).ranked[0].marginalChars,
	});
	assert.deepEqual(directOnly.selectedNames, ["feature-specialist"]);
});

test("a budget-rejected contextual direct candidate is reported only once", () => {
	const skills = [
		skill("migration-primary", "Database migration."),
		skill("bulk-guidance", `Database migration procedures.${LONG}`),
		skill("support-guidance", `Database discipline.${LONG}`),
	];
	const query = "migration-primary database migration";
	const bounds = { minTopK: 2, targetTopK: 2, maxTopK: 2 };
	const baseline = planSkillPrefetch(skills, query, bounds);
	assert.deepEqual(baseline.ranked.map((entry) => entry.skill.name), ["migration-primary", "bulk-guidance", "support-guidance"]);
	const plan = planSkillPrefetch(skills, query, {
		...bounds, fullRenderBudgetChars: baseline.ranked[0].marginalChars,
		profile: normalizeProfile({ activation: {
			"migration-primary": { kind: "specialist", tasks: ["software-change"] },
			"support-guidance": { kind: "behavioral", tasks: ["software-change"] },
		} }),
	});
	assert.deepEqual(plan.selectedNames, ["migration-primary"]);
	assert.deepEqual(plan.skippedForBudget, [...new Set(plan.skippedForBudget)]);
});

test("contextual rescue preserves low-ranked direct evidence without duplicating search items", () => {
	const skills = [
		skill("database-migration", "Plan database schema migrations."),
		skill("database-import", "Handle repeated database migration preparation and database migration checks."),
		skill("database-schema", "Handle repeated database migration planning and database migration review."),
		skill("software-architecture", "Architecture migration design."),
	];
	const query = "database migration";
	const options = { minTopK: 2, targetTopK: 2, maxTopK: 2 };
	const direct = planSkillPrefetch(skills, query, options);
	const contextualIndex = direct.ranked.findIndex(({ skill: item }) => item.name === "software-architecture");
	assert.ok(contextualIndex >= 2, `expected a lower-ranked direct hit, got index ${contextualIndex}`);

	const profile = normalizeProfile({ activation: {
		"database-migration": { kind: "specialist", tasks: ["software-change"] },
		"software-architecture": { kind: "workflow", tasks: ["software-change"] },
	} });
	const rescued = planSkillPrefetch(skills, query, { ...options, profile });
	assert.deepEqual(rescued.selectedNames, ["database-migration", "software-architecture"]);
	assert.deepEqual(rescued.ranked.map(({ skill: item }) => item.name), direct.ranked.map(({ skill: item }) => item.name));
	assert.equal(rescued.ranked[contextualIndex].score, direct.ranked[contextualIndex].score);
	assert.deepEqual(rescued.ranked[contextualIndex].reasons, [...direct.ranked[contextualIndex].reasons, "contextual"]);
});

test("all exact direct slots are preserved, and an oversized contextual skill falls back to direct ranking", () => {
	const exactSkills = [
		skill("git-review", "Review git diffs and patches."),
		skill("review-git", "Review git repositories and changes."),
		skill("review-workflow", "A contextual review workflow."),
	];
	const exactProfile = normalizeProfile({ activation: {
		"git-review": { kind: "specialist", tasks: ["software-review"] },
		"review-workflow": { kind: "workflow", tasks: ["software-review"] },
	} });
	const exact = planSkillPrefetch(exactSkills, "git review", {
		profile: exactProfile,
		minTopK: 2,
		targetTopK: 2,
		maxTopK: 3,
	});
	assert.equal(exact.ranked.filter(({ exactScore }) => exactScore >= 8).slice(0, 2).length, 2);
	assert.equal(exact.selectedNames.includes("review-workflow"), false);
	assert.equal(exact.selectedNames.includes("git-review"), true);
	assert.equal(exact.selectedNames.includes("review-git"), true);

	const budgetSkills = [
		skill("database-migration", "Plan database schema migrations."),
		skill("database-import", "Prepare database migrations for import and validation."),
		skill("software-architecture", `Architecture and dependency guidance.${LONG}`),
	];
	const query = "database migration";
	const budgetOptions = { minTopK: 2, targetTopK: 2, maxTopK: 2 };
	const baseline = planSkillPrefetch(budgetSkills, query, budgetOptions);
	const contextual = planSkillPrefetch(budgetSkills, query, {
		...budgetOptions,
		profile: normalizeProfile({ activation: {
			"database-migration": { kind: "specialist", tasks: ["software-change"] },
			"software-architecture": { kind: "workflow", tasks: ["software-change"] },
		} }),
		fullRenderBudgetChars: baseline.marginalChars,
	});
	assert.deepEqual(contextual.selectedNames, baseline.selectedNames);
	assert.ok(contextual.skippedForBudget.includes("software-architecture"));
});
