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
import { setUserAliasCandidates } from "../src/aliases.ts";
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
	assert.deepEqual(selectRelevant([10, 9], { targetTopK: 0, minTopK: 0, maxTopK: 2, adaptive: true }), []);
});

test("compactDescription keeps the first sentence and caps length", () => {
	assert.equal(
		compactDescription("First sentence here. Second sentence ignored.", 200),
		"First sentence here.",
	);
	const capped = compactDescription("aaaa bbbb cccc dddd eeee ffff", 12);
	assert.ok(capped.endsWith("…"));
	assert.ok(capped.length <= 12);
	const routed = compactDescription(
		"A deliberately long first sentence that must be shortened substantially. Use when routing requests with no direct catalog overlap.",
		60,
	);
	assert.ok(routed.length <= 60);
	assert.ok(routed.includes("Use when"));
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
	const { text: out, removedChars, selected } = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tail: "name",
		query: "crack RSA key recovery",
	});
	assert.ok(removedChars > 0);
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
	assert.ok(out.includes("without a location field"));
	assert.ok(!out.includes("without a <location>"));
	const pathNote = out.match(/<skill_path_note>([\s\S]*?)<\/skill_path_note>/);
	assert.ok(pathNote);
	assert.ok(!pathNote[1].includes("<"), "path note must contain plain XML text, not pseudo-tags");
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
	const hashcat = parseSkills(out).find((skill) => skill.name === "hashcat");
	assert.ok(hashcat);
	assert.ok(hashcat.description.startsWith("GPU-accelerated")); // original intent survives within the shared budget
	assert.match(hashcat.description, /\bUse when\b/); // routing signal survives within the shared budget
	assert.ok(hashcat.description.length <= 80);
	assert.ok(!out.includes("A long middle sentence with plenty of extra detail")); // middle sentence dropped
	assert.ok(!out.includes("C:/skills/hashcat/SKILL.md")); // location still dropped
});

test("hybrid falls back to compact intent tails when the query has no lexical signal", () => {
	const long = (lead: string, route: string): string => `${lead}. A long middle sentence that the fallback must discard because it has no routing value. ${route}`;
	const text = catalog(
		skillXml("hashcat", long("GPU-accelerated offline password cracking", "Use when cracking captured password hashes.")),
		skillXml("nmap", long("Network port scanner and host discovery", "Use when mapping a network.")),
		skillXml("sqlmap", long("Automated SQL injection validation", "Use when testing SQL injection.")),
	);
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "日本語 🔥" });
	assert.deepEqual(out.selected, []);
	const tails = parseSkills(out.text);
	assert.deepEqual(tails.map((skill) => skill.name), ["hashcat", "nmap", "sqlmap"]);
	assert.ok(tails.every((skill) => skill.description.length > 0), "no-signal fallback must preserve an intent for every described skill");
	assert.ok(tails.every((skill) => skill.description.length <= 80), "fallback intents must respect the shared character budget");
	assert.ok(tails.every((skill) => !skill.description.includes("A long middle sentence")), "fallback must discard non-routing detail");
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
	const reducibleTail = "General maintenance workflow with extensive operational guidance for routine housekeeping. ".repeat(6);
	const text = catalog(...SAMPLE.map(([n, d]) => skillXml(n, d)), skillXml("maintenance-guide", reducibleTail));
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
	assert.ok(out.text.includes("<name>maintenance-guide</name>"));
	assert.ok(!out.text.includes(reducibleTail));
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
	assert.equal(out.removedChars, 0);
});

test("transformSkillsInText skips rewrites that would not shrink a catalog block", () => {
	// already name-only and minimal: rebuilt cannot be smaller, so it is left untouched
	const text = `<available_skills>\n  <skill>\n    <name>a</name>\n  </skill>\n</available_skills>`;
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 0, tail: "name", query: "" });
	assert.equal(out.text, text);
	assert.equal(out.removedChars, 0);
});

test("transformSkillsInText is a no-op for its own transformed catalog", () => {
	const source = catalog(...SAMPLE.map(([name, description]) => skillXml(name, description)));
	const first = transformSkillsInText(source, { mode: "hybrid", topK: 1, tail: "name", query: "RSA key recovery" });
	assert.ok(first.removedChars > 0);
	assert.ok(first.text.includes("<!--skill-optimizer-->"));
	assert.ok(first.text.includes("<skill_path_note>"));
	const second = transformSkillsInText(first.text, { mode: "hybrid", topK: 1, tail: "name", query: "RSA key recovery" });
	assert.equal(second.text, first.text);
	assert.equal(second.removedChars, 0);
	assert.deepEqual(second.selected, []);
});

test("transformSkillsInText rewrites every reducible catalog in the text", () => {
	const first = `<available_skills>\n${SAMPLE.map(([n, d]) => skillXml(n, d)).join("\n")}\n</available_skills>`;
	const second = `<available_skills>\n${skillXml("alpha-skill", "Alpha skill does several things. A deliberately long second sentence that compact mode must remove from this catalog.")}\n${skillXml("beta-skill", "Beta skill does other things. Another deliberately long second sentence that compact mode must remove from this catalog.")}\n</available_skills>`;
	const out = transformSkillsInText(`${first}\nmid\n${second}`, { mode: "compact", topK: 0, tail: "name", query: "" });
	assert.equal((out.text.match(/<!--skill-optimizer-->/g) ?? []).length, 2);
	assert.equal(parseSkills(out.text).length, SAMPLE.length + 2);
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
	assert.equal(extractQuery([{ role: "user", content: "must not leak" }], 0), "");
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

test("catalog analysis cache observes global alias revisions", () => {
	setUserAliasCandidates({});
	try {
		const text = catalog(
			skillXml("quantum-tool", "Quantum circuit analysis with a deliberately long description for specialist workloads."),
			skillXml("python-testing", "Python test fixtures and regression workflows with a deliberately long description."),
			skillXml("network-scan", "Network discovery and port scanning with a deliberately long description."),
		);
		const options = { mode: "hybrid" as const, topK: 1, tail: "name" as const, query: "codename" };
		assert.deepEqual(transformSkillsInText(text, options).selected, []);
		setUserAliasCandidates({ codename: ["quantum"] });
		assert.deepEqual(transformSkillsInText(text, options).selected, ["quantum-tool"]);
	} finally {
		setUserAliasCandidates({});
	}
});

test("selected skill diagnostics are deduplicated across catalog blocks", () => {
	const block = `<available_skills>\n${SAMPLE.map(([name, description]) => skillXml(name, description)).join("\n")}\n</available_skills>`;
	const out = transformSkillsInText(`${block}\n${block}`, { mode: "hybrid", topK: 1, tail: "name", query: "RSA key recovery" });
	assert.deepEqual(out.selected, ["rsactftool"]);
});

test("hybrid uses conservative name trigrams for typos and separator/camel-case variants", () => {
	const typoCatalog = catalog(
		skillXml("rsactftool", "Specialized public-key workflow with enough detail to benefit from full rendering."),
		skillXml("network-audit", "Network assessment workflow with unrelated operational guidance."),
		skillXml("release-planning", "Release planning and coordination guidance with substantial unrelated procedural detail."),
		skillXml("database-maintenance", "Database upkeep and migration guidance with substantial unrelated procedural detail."),
	);
	assert.deepEqual(
		transformSkillsInText(typoCatalog, { mode: "hybrid", topK: 1, tail: "name", query: "rsactftol" }).selected,
		["rsactftool"],
	);

	const camelCatalog = catalog(
		skillXml("githubAddressComments", "Resolve review feedback with detailed repository guidance."),
		skillXml("release-notes", "Prepare product release documentation and summaries."),
		skillXml("database-maintenance", "Database upkeep and migration guidance with substantial unrelated procedural detail."),
		skillXml("network-audit", "Network assessment workflow with substantial unrelated operational guidance."),
	);
	assert.deepEqual(
		transformSkillsInText(camelCatalog, { mode: "hybrid", topK: 1, tail: "name", query: "github address comments" }).selected,
		["githubAddressComments"],
	);
});

test("hybrid fuzzy recall covers alias sources but does not promote near-misses below threshold", () => {
	const text = catalog(
		skillXml("pi-extension-creator", "Create an extension package with detailed Pi integration guidance."),
		skillXml("python-testing", "Python regression tests and fixture design guidance."),
		skillXml("database-maintenance", "Database upkeep and migration guidance with substantial unrelated procedural detail."),
		skillXml("network-audit", "Network assessment workflow with substantial unrelated operational guidance."),
	);
	assert.deepEqual(
		transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "plugi" }).selected,
		["pi-extension-creator"],
	);
	assert.deepEqual(
		transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "plug" }).selected,
		[],
	);
});

test("hybrid full-render budget caps ordinary promotions and never caps protected skills", () => {
	const detail = " Detailed operational guidance for a complex workflow.".repeat(4);
	const text = catalog(
		skillXml("alpha-engine", `Alpha prime target workflow.${detail}`),
		skillXml("target-helper", `Target support workflow.${detail}`),
		skillXml("critical-guide", `Critical recovery workflow.${detail}`),
		skillXml("pinned-guide", `Pinned historical workflow.${detail}`),
		skillXml("always-guide", `Always available workflow.${detail}`),
		skillXml("ordinary-tail", `Unrelated maintenance workflow.${detail}`),
	);
	const budgeted = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 2,
		tail: "name",
		query: "alpha prime target",
		fullRenderBudgetChars: 450,
	});
	assert.deepEqual(budgeted.selected, ["alpha-engine"]);
	assert.ok(budgeted.text.includes(`Alpha prime target workflow.${detail}`));
	assert.ok(!budgeted.text.includes(`Target support workflow.${detail}`));

	const protectedResult = transformSkillsInText(text, {
		mode: "hybrid",
		topK: 1,
		tail: "name",
		query: "alpha prime target",
		fullRenderBudgetChars: 1,
		profile: normalizeProfile({ critical: ["critical-guide"] }),
		pinnedSkills: ["pinned-guide"],
		alwaysFull: ["always-guide"],
	});
	assert.ok(!protectedResult.text.includes(`Alpha prime target workflow.${detail}`));
	for (const name of ["critical-guide", "pinned-guide", "always-guide"]) {
		assert.ok(protectedResult.selected.includes(name));
		assert.ok(parseSkills(protectedResult.text).find((skill) => skill.name === name)?.description.includes("workflow"));
	}
});

test("hybrid default budget prevents pathological full-description expansion", () => {
	const pathological = `Unique pathological router. ${"Very large detail block. ".repeat(700)}`;
	const text = catalog(
		skillXml("pathological-router", pathological),
		skillXml("ordinary-tail", "Ordinary unrelated workflow with a useful concise description."),
	);
	const out = transformSkillsInText(text, { mode: "hybrid", topK: 1, tail: "name", query: "unique pathological router" });
	assert.deepEqual(out.selected, []);
	assert.ok(!out.text.includes(pathological));
	assert.ok(out.text.includes("<name>pathological-router</name>"));
});
