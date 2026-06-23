import assert from "node:assert/strict";
import { test } from "node:test";
import {
	compactDescription,
	extractQuery,
	parseSkills,
	scoreSkills,
	selectRelevant,
	tokenize,
	transformSkillsInText,
} from "../src/skills.ts";
import { EMPTY_PROFILE, normalizeProfile } from "../src/profile.ts";

function skillXml(name: string, description: string, location = `C:/skills/${name}/SKILL.md`): string {
	return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${location}</location>\n  </skill>`;
}

function catalog(...skills: string[]): string {
	return `lead-in text\n<available_skills>\n${skills.join("\n")}\n</available_skills>\ntail text`;
}

const SAMPLE = [
	["rsactftool", "RSA testing automation tool for weak public keys. Use when targeting RSA key recovery."],
	["hashcat", "GPU-accelerated offline password cracking tool supporting many hash types."],
	["python-patterns", "Pythonic patterns and best practices for writing readable Python code. Use when reviewing Python."],
	["tcpdump", "Command-line packet capture and network traffic analysis."],
] as const;

test("tokenize lowercases, drops stopwords/short/number-only, decodes entities", () => {
	assert.deepEqual(tokenize("Use the RSA key &quot;recovery&quot; 4096"), ["rsa", "key", "recovery"]);
	assert.deepEqual(tokenize("a to of"), []); // all stopwords/short
});

test("parseSkills extracts name/description/location in order, location optional", () => {
	const inner = `\n${skillXml("a", "desc a")}\n  <skill>\n    <name>b</name>\n    <description>desc b</description>\n  </skill>\n`;
	const skills = parseSkills(inner);
	assert.equal(skills.length, 2);
	assert.deepEqual(
		skills.map((s) => s.name),
		["a", "b"],
	);
	assert.equal(skills[0].location, "C:/skills/a/SKILL.md");
	assert.equal(skills[1].location, ""); // no <location>
});

test("scoreSkills ranks with BM25 and a name-match boost; specific terms beat common ones", () => {
	const skills = SAMPLE.map(([name, description]) => ({ name, description, location: "" }));
	const scores = scoreSkills(skills, tokenize("recover an RSA private key"));
	const best = scores.indexOf(Math.max(...scores));
	assert.equal(skills[best].name, "rsactftool"); // "rsa"/"key"/"recover" all hit it
	assert.ok(scores[1] === 0 || scores[best] > scores[1]); // hashcat not the winner
});

test("scoreSkills expands query aliases filtered by catalog terms", () => {
	const skills = [
		{ name: "mobile-technique", description: "Android application assessment and reverse engineering workflow.", location: "" },
		{ name: "python-testing", description: "Python test workflow.", location: "" },
	];
	const scores = scoreSkills(skills, tokenize("analyze apk"));
	assert.ok(scores[0] > scores[1]);
});

test("scoreSkills gives 0 to unrelated skills", () => {
	const skills = SAMPLE.map(([name, description]) => ({ name, description, location: "" }));
	const scores = scoreSkills(skills, tokenize("brew a cup of tea"));
	assert.ok(scores.every((s) => s === 0));
});

test("selectRelevant returns up to K positive-scored indices, best first", () => {
	assert.deepEqual(selectRelevant([0, 5, 2, 0, 9], 2), [4, 1]);
	assert.deepEqual(selectRelevant([0, 0, 0], 3), []);
});

test("selectRelevant supports adaptive K for ambiguous positive scores", () => {
	assert.deepEqual(selectRelevant([10, 9, 8, 1], { targetTopK: 1, minTopK: 1, maxTopK: 3, adaptive: true }), [0, 1, 2]);
	assert.deepEqual(selectRelevant([10, 1, 0.5], { targetTopK: 1, minTopK: 1, maxTopK: 3, adaptive: true }), [0]);
});

test("compactDescription keeps the first sentence and caps length", () => {
	assert.equal(
		compactDescription("First sentence here. Second sentence ignored.", 200),
		"First sentence here.",
	);
	const capped = compactDescription("aaaa bbbb cccc dddd eeee ffff", 12);
	assert.ok(capped.endsWith("…"));
	assert.ok(capped.length <= 13);
});

test("hybrid: relevant skills stay full, the tail is compacted, all names survive", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const { text: out, removed, selected } = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tailChars: 40,
		keepLocations: false,
		query: "crack RSA key recovery",
	});
	assert.ok(removed > 0);
	assert.deepEqual(selected, ["rsactftool"]);
	// full skill keeps its full description + location
	assert.ok(out.includes("Use when targeting RSA key recovery"));
	assert.ok(out.includes("C:/skills/rsactftool/SKILL.md"));
	// every name still present (discoverable)
	for (const [n] of SAMPLE) assert.ok(out.includes(`<name>${n}</name>`), `name ${n} missing`);
	// a tail skill is compacted (no location, trimmed description)
	assert.ok(!out.includes("C:/skills/tcpdump/SKILL.md"));
});

test("compact mode: every skill kept, all descriptions trimmed, no skill is full", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const { text: out, selected } = transformSkillsInText(text, {
		mode: "compact",
		topK: 0,
		tailChars: 60,
		keepLocations: false,
		query: "",
	});
	assert.deepEqual(selected, []);
	for (const [n] of SAMPLE) assert.ok(out.includes(`<name>${n}</name>`));
	assert.ok(!out.includes("supporting many hash types")); // hashcat desc trimmed past first sentence boundary
});

test("hybrid tail=0: tail is name-only (no description), relevant stays full", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tailChars: 0, keepLocations: false, query: "RSA key recovery", profile: EMPTY_PROFILE, pinnedSkills: [] });
	// relevant skill keeps its description; tail skills keep only the name
	assert.ok(out.text.includes("Use when targeting RSA key recovery"));
	assert.ok(out.text.includes("<name>hashcat</name>"));
	assert.ok(!out.text.includes("password cracking tool")); // hashcat description dropped (name-only)
	for (const [n] of SAMPLE) assert.ok(out.text.includes(`<name>${n}</name>`));
});

test("hybrid keeps profile-critical and pinned skills full", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const out = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tailChars: 0,
		keepLocations: false,
		query: "RSA key recovery",
		profile: normalizeProfile({ critical: ["hashcat"] }),
		pinnedSkills: ["tcpdump"],
	});
	assert.ok(out.text.includes("GPU-accelerated offline password cracking"));
	assert.ok(out.text.includes("Command-line packet capture"));
	assert.deepEqual(out.selected, ["rsactftool", "hashcat", "tcpdump"]);
});

test("hybrid safe fallback uses a short tail when scores are too weak", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const out = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tailChars: 0,
		keepLocations: false,
		query: "brew tea",
		profile: EMPTY_PROFILE,
		pinnedSkills: [],
		safeFallbackTailChars: 48,
	});
	assert.ok(out.text.includes("<description>GPU-accelerated offline password cracking tool"));
	assert.deepEqual(out.selected, []);
});

test("transformSkillsInText keepLocations retains <location> on compacted entries", () => {
	const text = catalog(skillXml("a", "Alpha skill does things. Extra detail."), skillXml("b", "Beta skill."));
	const out = transformSkillsInText(text, { mode: "compact", topK: 0, tailChars: 40, keepLocations: true, query: "" });
	assert.ok(out.text.includes("C:/skills/a/SKILL.md"));
	assert.ok(out.text.includes("C:/skills/b/SKILL.md"));
});

test("transformSkillsInText is identity when there is no catalog", () => {
	const text = "no skills here";
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 5, tailChars: 80, keepLocations: false, query: "x" });
	assert.equal(out.text, text);
	assert.equal(out.removed, 0);
});

test("transformSkillsInText skips rewrites that would not shrink a catalog block", () => {
	const text = `<available_skills><skill><name>a</name><description>x.</description></skill></available_skills>`;
	const out = transformSkillsInText(text, {
		mode: "compact",
		topK: 0,
		tailChars: 80,
		keepLocations: false,
		query: "",
	});
	assert.equal(out.text, text);
	assert.equal(out.removed, 0);
});

test("transformSkillsInText rewrites every catalog in the text", () => {
	const first = `<available_skills>\n${skillXml("a", "Alpha tool.")}\n</available_skills>`;
	const second = `<available_skills>\n${skillXml("b", "Beta tool.")}\n</available_skills>`;
	const out = transformSkillsInText(`${first}\nmid\n${second}`, {
		mode: "compact",
		topK: 0,
		tailChars: 0,
		keepLocations: false,
		query: "",
	});
	assert.equal((out.text.match(/<description>/g) ?? []).length, 0);
	assert.ok(out.text.includes("<name>a</name>"));
	assert.ok(out.text.includes("<name>b</name>"));
});

test("extractQuery joins first (task) + last (current) user text, skipping tool results", () => {
	const messages = [
		{ role: "user", content: "Find the RSA bug" },
		{ role: "assistant", content: "ok" },
		{ role: "user", content: [{ type: "tool_result", content: "..." }] }, // skipped (no text)
		{ role: "user", content: [{ type: "text", text: "now check the key size" }] },
	];
	assert.equal(extractQuery(messages), "Find the RSA bug\nnow check the key size");
});

test("extractQuery returns the single task when there is one user message, '' when none", () => {
	assert.equal(extractQuery([{ role: "user", content: "only one" }]), "only one");
	assert.equal(extractQuery([{ role: "assistant", content: "hi" }]), "");
	assert.equal(extractQuery(undefined), "");
});

test("extractQuery always preserves the latest user text when truncating", () => {
	const first = "python ".repeat(500);
	const last = "recover RSA private key";
	const query = extractQuery(
		[
			{ role: "user", content: first },
			{ role: "user", content: last },
		],
		2000,
	);
	assert.ok(query.includes(last));
	assert.ok(query.length <= 2000);
});
