import assert from "node:assert/strict";
import { test } from "node:test";
import {
	optimizeSkillCatalog,
	parseSkills,
	renderSkillPrefetch,
	renderStableSkillCatalog,
	type Skill,
	type SkillPrefetchOptions,
	type StableCatalogOptions,
} from "../src/skills.ts";

const ROOTS = ["C:/r1/skills", "C:/r2/skills"];
const TOKENS = "rsa key crack hash smb ldap kerberos python golang rust web sqli ssrf xss apk android ghidra binary fuzz afl recon nmap scan cloud aws docker volatility memory forensic crypto research review test debug build deploy".split(" ");

function rng(seed: number): () => number {
	return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function buildCatalog(count: number): { text: string; names: Set<string>; skills: Map<string, Skill> } {
	const rand = rng(42);
	const entries: string[] = ["<available_skills>"];
	const names = new Set<string>();
	const skills = new Map<string, Skill>();
	for (let i = 0; i < count; i++) {
		const name = `skill-${i}`;
		names.add(name);
		const descWords = Array.from({ length: 4 + Math.floor(rand() * 6) }, () => TOKENS[Math.floor(rand() * TOKENS.length)]);
		const description = `Skill ${i}: ${descWords.join(" ")}.`;
		const root = ROOTS[Math.floor(rand() * ROOTS.length)];
		const location = i % 11 === 0 ? `C:/odd/custom-${i}.md` : `${root}/${name}/SKILL.md`;
		skills.set(name, { name, description, location });
		entries.push("  <skill>");
		entries.push(`    <name>${name}</name>`);
		entries.push(`    <description>${description}</description>`);
		entries.push(`    <location>${location}</location>`);
		entries.push("  </skill>");
	}
	entries.push("</available_skills>");
	return { text: entries.join("\n"), names, skills };
}

const CATALOG = buildCatalog(120);
const OPTIONS: SkillPrefetchOptions & StableCatalogOptions = {
	targetTopK: 20,
	minTopK: 8,
	maxTopK: 32,
	always: ["skill-0"],
};

function namesInCatalog(text: string): string[] {
	const match = text.match(/<available_skills>([\s\S]*?)<\/available_skills>/);
	return match ? parseSkills(match[1]).map((skill) => skill.name) : [];
}

function fuzzQuery(rand: () => number): string {
	const count = Math.floor(rand() * 8);
	const parts: string[] = [];
	const junk = ["", "   ", "<script>", "&amp;", "../../x", "日本語", "🔥", "zzzz", "1234"];
	for (let i = 0; i < count; i++) {
		parts.push(rand() < 0.8 ? TOKENS[Math.floor(rand() * TOKENS.length)] : junk[Math.floor(rand() * junk.length)]);
	}
	return parts.join(" ");
}

test("fuzz: 1500 queries preserve one stable resolver-backed base and verbatim prefetches", () => {
	const rand = rng(2024);
	const expectedNames = [...CATALOG.names];
	let stableText: string | undefined;
	let stableFingerprint: string | undefined;
	for (let i = 0; i < 1500; i++) {
		const result = optimizeSkillCatalog(CATALOG.text, fuzzQuery(rand), OPTIONS);
		stableText ??= result.text;
		stableFingerprint ??= result.fingerprint;
		assert.equal(result.text, stableText, "query changed the cacheable base");
		assert.equal(result.fingerprint, stableFingerprint, "query changed the base fingerprint");
		assert.deepEqual(namesInCatalog(result.text), expectedNames);
		assert.ok(result.removedChars >= 0);
		assert.ok(result.text.length <= CATALOG.text.length);
		assert.ok(result.plan.selectedNames.includes("skill-0"), "static always skill was not prefetched");

		const overlay = parseSkills(renderSkillPrefetch(result.plan));
		assert.deepEqual(overlay.map((skill) => skill.name), result.plan.selectedNames);
		for (const selected of overlay) {
			const original = CATALOG.skills.get(selected.name);
			assert.ok(original);
			assert.equal(selected.description, original.description);
			assert.equal(selected.location, "");
		}
	}
});

test("fuzz: output and ranked selections are deterministic", () => {
	const first = optimizeSkillCatalog(CATALOG.text, "crack rsa key hash", OPTIONS);
	const second = optimizeSkillCatalog(CATALOG.text, "crack rsa key hash", OPTIONS);
	assert.equal(first.text, second.text);
	assert.equal(first.fingerprint, second.fingerprint);
	assert.deepEqual(first.plan.selectedNames, second.plan.selectedNames);
	assert.deepEqual(first.plan.ranked, second.plan.ranked);
	assert.equal(renderSkillPrefetch(first.plan), renderSkillPrefetch(second.plan));
});

test("fuzz: stable rendering is idempotent without reconstructing removed text", () => {
	const first = optimizeSkillCatalog(CATALOG.text, "python test", OPTIONS);
	const second = renderStableSkillCatalog(first.text);
	assert.equal(second.text, first.text);
	assert.equal(second.removedChars, 0);
	assert.equal(second.fingerprint, first.fingerprint);
	assert.deepEqual(namesInCatalog(second.text), [...CATALOG.names]);
});

test("never exclusions and static always selections remain deterministic under fuzz", () => {
	const options: SkillPrefetchOptions & StableCatalogOptions = {
		...OPTIONS,
		never: ["skill-1", "skill-2*"],
		always: ["skill-50"],
	};
	const rand = rng(7);
	let expectedBase: string | undefined;
	for (let i = 0; i < 200; i++) {
		const result = optimizeSkillCatalog(CATALOG.text, fuzzQuery(rand), options);
		expectedBase ??= result.text;
		assert.equal(result.text, expectedBase);
		const names = new Set(namesInCatalog(result.text));
		assert.ok(!names.has("skill-1"), "exact exclusion leaked");
		assert.ok(![...names].some((name) => name.startsWith("skill-2")), "prefix exclusion leaked");
		assert.ok(result.plan.selectedNames.includes("skill-50"), "static always skill was not prefetched");
	}
});

test("non-positive target budgets fail safely without indexing past ranked candidates", () => {
	const result = optimizeSkillCatalog(CATALOG.text, "rsa key", {
		targetTopK: 0,
		minTopK: 0,
		maxTopK: 0,
	});
	assert.equal(result.plan.selectedNames.length, 0);
	assert.deepEqual(namesInCatalog(result.text), [...CATALOG.names]);
});
