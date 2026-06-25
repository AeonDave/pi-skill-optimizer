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
import { normalizeProfile } from "../src/profile.ts";

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

test("scoreSkills maps plugin wording to extension skills", () => {
	const skills = [
		{ name: "pi-extension-creator", description: "Create and troubleshoot Pi coding-agent extensions and packages.", location: "" },
		{ name: "python-testing", description: "Python test workflow.", location: "" },
	];
	const scores = scoreSkills(skills, tokenize("fix this plugin hook"));
	assert.ok(scores[0] > scores[1]);
});

test("hybrid ignores overbroad profile alias targets", () => {
	const text = catalog(
		skillXml("web-exploit-technique", "Web impact validation technique for SSRF and SQLi. Long details that should remain only for the selected web skill."),
		skillXml("active-directory-technique", "Active Directory Kerberos and LDAP assessment technique. Long unrelated AD details."),
		skillXml("python-testing", "Python pytest workflow and fixtures. Long unrelated Python testing details."),
	);
	const out = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 2,
		tail: "name",
		query: "web",
		profile: normalizeProfile({ aliases: { web: ["web", "technique"] } }),
	});
	assert.ok(out.selected.includes("web-exploit-technique"));
	assert.ok(!out.selected.includes("active-directory-technique"));
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

test("compactDescription appends the routing clause when the first sentence lacks one (#4a)", () => {
	// first sentence has no routing signal -> append the 'Use when ...' sentence
	const r = compactDescription("Does a thing with many words. A middle sentence to drop. Use when targeting the X case.", 200);
	assert.ok(r.includes("Does a thing with many words."));
	assert.ok(r.includes("Use when targeting the X case."));
	assert.ok(!r.includes("A middle sentence to drop"));
	// first sentence already carries routing -> no duplication
	const r2 = compactDescription("Use when reviewing Python code. Extra detail here.", 200);
	assert.equal(r2, "Use when reviewing Python code.");
	// no routing clause at all -> just the first sentence
	assert.equal(compactDescription("Plain first sentence. Second.", 200), "Plain first sentence.");
});

test("hybrid: relevant stays full with location, tail is name-only, all names survive", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const { text: out, removed, selected } = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tail: "name",
		query: "crack RSA key recovery",
	});
	assert.ok(removed > 0);
	assert.deepEqual(selected, ["rsactftool"]);
	// full skill keeps its full description + explicit location
	assert.ok(out.includes("Use when targeting RSA key recovery"));
	assert.ok(out.includes("C:/skills/rsactftool/SKILL.md"));
	// every name still present (discoverable)
	for (const [n] of SAMPLE) assert.ok(out.includes(`<name>${n}</name>`), `name ${n} missing`);
	// tail location dropped (derivable) and replaced by a single path note
	assert.ok(!out.includes("C:/skills/tcpdump/SKILL.md"));
	assert.ok(out.includes("<skill_path_note>"));
	assert.ok(out.includes("C:/skills"));
	// tail is name-only: no hashcat description
	assert.ok(!out.includes("password cracking"));
});

test("hybrid tail=intent keeps first sentence + routing clause, drops the derivable location", () => {
	const long = (lead: string, route: string): string => `${lead}. A long middle sentence with plenty of extra detail that the intent tail must drop to actually save tokens here. ${route}`;
	const text = catalog(
		skillXml("rsactftool", "RSA testing automation tool for weak public keys. Use when targeting RSA key recovery."),
		skillXml("hashcat", long("GPU-accelerated offline password cracking", "Use when cracking captured password hashes.")),
		skillXml("nmap", long("Network port scanner and host discovery utility", "Use when mapping a network.")),
		skillXml("sqlmap", long("Automated SQL injection detection and exploitation", "Use when testing SQL injection.")),
		skillXml("ffuf", long("Fast web fuzzer for content discovery", "Use when fuzzing endpoints.")),
	);
	const { text: out } = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "intent", query: "RSA key recovery" });
	assert.ok(out.includes("GPU-accelerated offline password cracking")); // first sentence kept
	assert.ok(out.includes("Use when cracking captured password hashes")); // routing clause kept (#4a)
	assert.ok(!out.includes("A long middle sentence with plenty of extra detail")); // middle sentence dropped
	assert.ok(!out.includes("C:/skills/hashcat/SKILL.md")); // location still dropped
});

test("compact renders every skill as a short intent tail with a path note, keeping routing clauses", () => {
	const text = catalog(
		skillXml("python-patterns", "Pythonic patterns and best practices for writing readable Python code across many files. A long extra sentence of detail that compact should drop from the middle. Use when reviewing Python."),
		skillXml("tcpdump", "Command-line packet capture and network traffic analysis with assorted long extra detail to make this description clearly longer than its compact intent form."),
	);
	const { text: out, selected } = transformSkillsInText(text, { mode: "compact", topK: 0, tail: "name", query: "" });
	assert.deepEqual(selected, []);
	assert.ok(out.includes("<name>python-patterns</name>"));
	assert.ok(out.includes("<name>tcpdump</name>"));
	assert.ok(out.includes("<skill_path_note>"));
	assert.ok(!out.includes("C:/skills/tcpdump/SKILL.md")); // per-entry locations dropped
	assert.ok(out.includes("Use when reviewing Python")); // routing clause kept (#4a)
	assert.ok(!out.includes("long extra sentence of detail")); // middle sentence dropped
});

test("hybrid keeps profile-critical and pinned skills full", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const out = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tail: "name",
		query: "RSA key recovery",
		profile: normalizeProfile({ critical: ["hashcat"] }),
		pinnedSkills: ["tcpdump"],
	});
	assert.ok(out.text.includes("GPU-accelerated offline password cracking"));
	assert.ok(out.text.includes("Command-line packet capture"));
	assert.deepEqual(out.selected, ["rsactftool", "hashcat", "tcpdump"]);
});

test("name-only skills (no description) are preserved, not dropped", () => {
	const text = catalog(
		skillXml("rsactftool", "RSA recovery tool. Use when targeting RSA key recovery."),
		`  <skill>\n    <name>1337</name>\n  </skill>`,
	);
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "rsa key recovery" });
	assert.ok(out.text.includes("<name>1337</name>")); // survives even without a description
});

test("alwaysFull keeps a behavioural skill full even when the query has no overlap", () => {
	const text = catalog(
		...SAMPLE.map(([n, d]) => skillXml(n, d)),
		skillXml("1337", "Mode: structured operator behaviour forcing explicit reasoning and verification."),
	);
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "refactor a python module", alwaysFull: ["1337"] });
	assert.ok(out.text.includes("structured operator behaviour")); // kept full despite zero query overlap
	assert.ok(out.selected.includes("1337"));
});

test("alwaysFull forces a skill to stay full", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "RSA key recovery", alwaysFull: ["tcpdump"] });
	assert.ok(out.text.includes("Command-line packet capture"));
	assert.ok(out.selected.includes("tcpdump"));
});

test("never removes matching skills (exact name and prefix*)", () => {
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)));
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 4, tail: "name", query: "rsa", never: ["hashcat", "python-*"] });
	assert.ok(!out.text.includes("<name>hashcat</name>"));
	assert.ok(!out.text.includes("<name>python-patterns</name>"));
	assert.ok(out.text.includes("<name>rsactftool</name>"));
});

test("tail keeps an explicit location when it is not derivable from the convention", () => {
	const text = catalog(
		skillXml("rsactftool", "RSA recovery tool. Use when targeting RSA key recovery."),
		`  <skill>\n    <name>weird</name>\n    <description>A weird skill.</description>\n    <location>C:/odd/path/custom.md</location>\n  </skill>`,
	);
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "rsa key recovery" });
	assert.ok(out.text.includes("C:/odd/path/custom.md")); // irregular path kept explicitly
});

test("transformSkillsInText is identity when there is no catalog", () => {
	const text = "no skills here";
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 5, tail: "name", query: "x" });
	assert.equal(out.text, text);
	assert.equal(out.removed, 0);
});

test("transformSkillsInText skips rewrites that would not shrink a catalog block", () => {
	// already name-only and minimal: rebuilt cannot be smaller, so it is left untouched
	const text = `<available_skills>\n  <skill>\n    <name>a</name>\n  </skill>\n</available_skills>`;
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 0, tail: "name", query: "" });
	assert.equal(out.text, text);
	assert.equal(out.removed, 0);
});

test("transformSkillsInText rewrites every catalog in the text", () => {
	const first = `<available_skills>\n${SAMPLE.map(([n, d]) => skillXml(n, d)).join("\n")}\n</available_skills>`;
	const second = `<available_skills>\n${skillXml("alpha-skill", "Alpha skill does several things. Extra detail here.")}\n${skillXml("beta-skill", "Beta skill does other things. More detail here.")}\n</available_skills>`;
	const out = transformSkillsInText(`${first}\nmid\n${second}`, { mode: "hybrid", topK: 0, tail: "name", query: "" });
	assert.equal((out.text.match(/<description>/g) ?? []).length, 0); // name-only tail, no descriptions
	assert.ok(out.text.includes("<name>rsactftool</name>"));
	assert.ok(out.text.includes("<name>alpha-skill</name>"));
	assert.ok(out.text.includes("<name>beta-skill</name>"));
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
