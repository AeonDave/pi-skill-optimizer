import assert from "node:assert/strict";
import { test } from "node:test";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";

const BASE: OptimizeConfig = {
	mode: "hybrid",
	topK: 1,
	tail: "name",
	toolsMode: "off",
	toolsDropPrefixes: [],
	toolsTopK: 24,
	toolsProtect: [],
};

function skillXml(name: string, description: string): string {
	return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>C:/s/${name}/SKILL.md</location>\n  </skill>`;
}

function catalogText(): string {
	return `intro\n<available_skills>\n${[
		skillXml("rsactftool", "RSA recovery tool for weak public keys. Use when recovering RSA keys."),
		skillXml("hashcat", "GPU password cracking. Many hash types supported here."),
		skillXml("tcpdump", "Packet capture and network analysis tooling."),
	].join("\n")}\n</available_skills>\nCurrent date: 2026-06-23`;
}

function payloadWithCatalogInSystem() {
	return {
		model: "m",
		messages: [{ role: "user", content: "recover this RSA key" }],
		system: [
			{ type: "text", text: "You are Claude Code." },
			{ type: "text", text: catalogText() },
		],
	};
}

test("hybrid: trims the system catalog, reports removed + selected, keeps the relevant skill full", () => {
	const { next, removed, selected } = optimize(payloadWithCatalogInSystem(), BASE) as {
		next: { system: Array<{ text: string }> };
		removed: number;
		selected: string[];
	};
	assert.ok(removed > 0);
	assert.deepEqual(selected, ["rsactftool"]);
	const cat = next.system[1].text;
	assert.ok(cat.includes("Use when recovering RSA keys")); // relevant kept full
	assert.ok(cat.includes("<name>hashcat</name>")); // tail still discoverable
	assert.equal(next.system[0].text, "You are Claude Code."); // untouched
});

test("off mode with no extra rules is an identity no-op (same reference)", () => {
	const payload = payloadWithCatalogInSystem();
	const { next, removed } = optimize(payload, { ...BASE, mode: "off" });
	assert.equal(next, payload);
	assert.equal(removed, 0);
});

test("preserves the original system payload shape when changed", () => {
	const stringPayload = { messages: [{ role: "user", content: "recover RSA" }], system: catalogText() };
	const stringOut = optimize(stringPayload, BASE) as { next: { system: string }; removed: number };
	assert.ok(stringOut.removed > 0);
	assert.equal(typeof stringOut.next.system, "string");

	const blockPayload = { messages: [{ role: "user", content: "recover RSA" }], system: { type: "text", text: catalogText() } };
	const blockOut = optimize(blockPayload, BASE) as { next: { system: { type: "text"; text: string } }; removed: number };
	assert.ok(blockOut.removed > 0);
	assert.equal(blockOut.next.system.type, "text");
	assert.equal(typeof blockOut.next.system.text, "string");
});

test("the catalog is also handled inside a tool description", () => {
	const payload = {
		messages: [{ role: "user", content: "crack a password hash" }],
		tools: [
			{ name: "Bash", description: "Run commands." },
			{ name: "Skill", description: `Execute a skill.\n<available_skills>\n${[
				skillXml("hashcat", "GPU password cracking tool supporting many hash types."),
				skillXml("tcpdump", "Packet capture and network traffic analysis on the wire."),
				skillXml("nmap", "Network port scanner for host discovery and service detection."),
				skillXml("sqlmap", "Automated SQL injection detection and exploitation tool."),
				skillXml("ffuf", "Fast web fuzzer for content and parameter discovery."),
			].join("\n")}\n</available_skills>` },
		],
	};
	const { next, removed, selected } = optimize(payload, { ...BASE, topK: 1 }) as {
		next: { tools: Array<{ name: string; description: string }> };
		removed: number;
		selected: string[];
	};
	assert.ok(removed > 0);
	assert.deepEqual(selected, ["hashcat"]);
	assert.equal(next.tools[0].description, "Run commands."); // untouched tool
	assert.ok(next.tools[1].description.includes("<name>tcpdump</name>")); // tail kept discoverable
});

test("selected diagnostics aggregate names across system and tool catalogs", () => {
	const payload = {
		messages: [{ role: "user", content: "recover RSA and crack hashcat passwords" }],
		system: `sys\n<available_skills>\n${[
			skillXml("rsactftool", "RSA recovery tool for weak public keys and ciphertext."),
			skillXml("tcpdump", "Packet capture and network traffic analysis on the wire."),
			skillXml("nmap", "Network port scanner for host discovery and service detection."),
			skillXml("ffuf", "Fast web fuzzer for content and parameter discovery."),
		].join("\n")}\n</available_skills>`,
		tools: [
			{ name: "Skill", description: `Skill tool.\n<available_skills>\n${[
				skillXml("hashcat", "Password hash cracking with the GPU across many formats."),
				skillXml("apktool", "Android APK decoding and reverse engineering toolkit."),
				skillXml("jadx", "Android dex-to-Java decompiler for app analysis."),
				skillXml("frida", "Dynamic instrumentation toolkit for app hooking."),
			].join("\n")}\n</available_skills>` },
		],
	};
	const { selected } = optimize(payload, { ...BASE, topK: 1 }) as { selected: string[] };
	assert.deepEqual(selected, ["rsactftool", "hashcat"]);
});

test("Pi-style Skill tool fixture is optimized while preserving payload shapes", () => {
	const payload = {
		messages: [{ role: "user", content: "analyze an apk" }],
		system: "plain system string",
		tools: [
			{
				name: "Skill",
				description: `Loads skills.\n<available_skills>\n${[
					skillXml("mobile-technique", "Android application assessment and reverse engineering workflow."),
					skillXml("python-testing", "Python testing workflow with pytest fixtures and coverage."),
					skillXml("golang-testing", "Go testing patterns for unit and table-driven tests."),
					skillXml("rust-testing", "Rust testing patterns for unit, integration, and doc tests."),
				].join("\n")}\n</available_skills>`,
				input_schema: { type: "object" },
			},
		],
	};
	const { next, selected, removed } = optimize(payload, { ...BASE, topK: 1 }) as {
		next: { system: string; tools: Array<{ name: string; description: string; input_schema?: unknown }> };
		selected: string[];
		removed: number;
	};
	assert.ok(removed > 0);
	assert.equal(next.system, "plain system string");
	assert.equal(next.tools[0].name, "Skill");
	assert.ok(next.tools[0].input_schema);
	assert.ok(next.tools[0].description.includes("<name>python-testing</name>"));
	assert.deepEqual(selected, ["mobile-technique"]);
});

test("tools drop mode removes prefixed tools but keeps core, used, and protected", () => {
	const payload = {
		messages: [
			{ role: "user", content: "fix the code" },
			{ role: "assistant", content: [{ type: "tool_use", name: "tavily_search" }] }, // used → kept
		],
		tools: [
			{ name: "Read", description: "read" },
			{ name: "htb_app_whoami", description: "htb" },
			{ name: "mcpwn_run", description: "pwn" },
			{ name: "tavily_search", description: "search" },
			{ name: "ctx_index", description: "index" },
		],
	};
	const { next, droppedTools } = optimize(payload, {
		...BASE,
		mode: "off",
		toolsMode: "drop",
		toolsDropPrefixes: ["htb_", "mcpwn_", "tavily_", "ctx_"],
	}) as { next: { tools: Array<{ name: string }> }; droppedTools: string[] };
	const kept = next.tools.map((t) => t.name);
	assert.ok(kept.includes("Read")); // core
	assert.ok(kept.includes("tavily_search")); // used in conversation
	assert.deepEqual(droppedTools.sort(), ["ctx_index", "htb_app_whoami", "mcpwn_run"]);
});

test("alwaysFull and never are threaded into the skill catalog rewrite", () => {
	const payload = {
		messages: [{ role: "user", content: "recover an RSA key" }],
		system: [
			{ type: "text", text: catalogText() },
		],
	};
	const { next, selected } = optimize(payload, { ...BASE, topK: 1, alwaysFull: ["tcpdump"], never: ["hashcat"] }) as {
		next: { system: Array<{ text: string }> };
		selected: string[];
	};
	const cat = next.system[0].text;
	assert.ok(!cat.includes("<name>hashcat</name>")); // never → removed entirely
	assert.ok(cat.includes("Packet capture")); // alwaysFull tcpdump kept full
	assert.ok(selected.includes("rsactftool")); // ranked
	assert.ok(selected.includes("tcpdump")); // alwaysFull
});

test("tools relevance mode keeps core + top-K relevant of the rest", () => {
	const payload = {
		messages: [{ role: "user", content: "search the web for vulnerability news" }],
		tools: [
			{ name: "Bash", description: "run commands" }, // core → kept
			{ name: "tavily_search", description: "Search the web for current information and news." },
			{ name: "htb_app_whoami", description: "HackTheBox identity." },
		],
	};
	const { next, droppedTools } = optimize(payload, { ...BASE, mode: "off", toolsMode: "relevance", toolsTopK: 1 }) as {
		next: { tools: Array<{ name: string }> };
		droppedTools: string[];
	};
	const kept = next.tools.map((t) => t.name);
	assert.ok(kept.includes("Bash")); // core always
	assert.ok(kept.includes("tavily_search")); // relevant to "search the web ... news"
	assert.deepEqual(droppedTools, ["htb_app_whoami"]); // irrelevant
});

test("returns identity when there is no catalog and no extra rules match", () => {
	const payload = { messages: [], system: [{ type: "text", text: "nothing to do" }] };
	const { next, removed } = optimize(payload, BASE);
	assert.equal(next, payload);
	assert.equal(removed, 0);
});

test("ignores non-object payloads", () => {
	assert.equal(optimize(undefined, BASE).next, undefined);
	assert.equal(optimize("nope", BASE).next, "nope");
});

test("reports removedSkills and removedTools separately", () => {
	const payload = {
		messages: [
			{ role: "user", content: "recover RSA" },
			{ role: "assistant", content: [{ type: "tool_use", name: "keep_me" }] },
		],
		system: catalogText(),
		tools: [
			{ name: "Read", description: "read" },
			{ name: "drop_me", description: "x" },
			{ name: "keep_me", description: "y" },
		],
	};
	const r = optimize(payload, { ...BASE, toolsMode: "drop", toolsDropPrefixes: ["drop_"] }) as {
		removed: number; removedSkills: number; removedTools: number; droppedTools: string[];
	};
	assert.ok(r.removedSkills > 0); // catalog rewrite
	assert.ok(r.removedTools > 0); // dropped tool definition
	assert.equal(r.removed, r.removedSkills + r.removedTools);
	assert.deepEqual(r.droppedTools, ["drop_me"]);
});

test("rewrites the catalog in Gemini systemInstruction (string)", () => {
	const payload = { messages: [{ role: "user", content: "recover RSA" }], systemInstruction: catalogText() };
	const { next, removedSkills } = optimize(payload, BASE) as { next: { systemInstruction: string }; removedSkills: number };
	assert.ok(removedSkills > 0);
	assert.equal(typeof next.systemInstruction, "string");
	assert.ok(next.systemInstruction.includes("<name>rsactftool</name>"));
	assert.ok(next.systemInstruction.includes("Use when recovering RSA keys")); // relevant kept full
});

test("rewrites the catalog in OpenAI Responses instructions (string)", () => {
	const payload = { messages: [{ role: "user", content: "recover RSA" }], instructions: catalogText() };
	const { next, removedSkills } = optimize(payload, BASE) as { next: { instructions: string }; removedSkills: number };
	assert.ok(removedSkills > 0);
	assert.ok(next.instructions.includes("<available_skills>") === false || next.instructions.includes("<name>rsactftool</name>"));
});

test("rewrites the catalog in an OpenAI/Mistral system-role message", () => {
	const payload = {
		messages: [
			{ role: "system", content: catalogText() },
			{ role: "user", content: "recover RSA" },
		],
	};
	const { next, removedSkills } = optimize(payload, BASE) as { next: { messages: Array<{ role: string; content: string }> }; removedSkills: number };
	assert.ok(removedSkills > 0);
	assert.ok(next.messages[0].content.includes("<name>rsactftool</name>"));
	assert.equal(next.messages[1].content, "recover RSA"); // user message untouched
});
