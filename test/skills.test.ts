import assert from "node:assert/strict";
import { test } from "node:test";
import {
	auditSkillDescriptions,
	catalogFingerprint,
	compactDescription,
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
