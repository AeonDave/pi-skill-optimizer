import assert from "node:assert/strict";
import { test } from "node:test";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";

const BASE: OptimizeConfig = {
	mode: "hybrid",
	topK: 1,
	tail: "name",
	fullRenderBudgetChars: 12_000,
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

test("hybrid: trims the system catalog, reports removedChars + selected, keeps the relevant skill full", () => {
	const { next, removedChars, selected } = optimize(payloadWithCatalogInSystem(), BASE) as {
		next: { system: Array<{ text: string }> };
		removedChars: number;
		selected: string[];
	};
	assert.ok(removedChars > 0);
	assert.deepEqual(selected, ["rsactftool"]);
	const cat = next.system[1].text;
	assert.ok(cat.includes("Use when recovering RSA keys")); // relevant kept full
	assert.ok(cat.includes("<name>hashcat</name>")); // tail still discoverable
	assert.equal(next.system[0].text, "You are Claude Code."); // untouched
});

test("off mode with no extra rules is an identity no-op (same reference)", () => {
	const payload = payloadWithCatalogInSystem();
	const { next, removedChars } = optimize(payload, { ...BASE, mode: "off" });
	assert.equal(next, payload);
	assert.equal(removedChars, 0);
});

test("preserves the original system payload shape when changed", () => {
	const stringPayload = { messages: [{ role: "user", content: "recover RSA" }], system: catalogText() };
	const stringOut = optimize(stringPayload, BASE) as { next: { system: string }; removedChars: number };
	assert.ok(stringOut.removedChars > 0);
	assert.equal(typeof stringOut.next.system, "string");

	const blockPayload = { messages: [{ role: "user", content: "recover RSA" }], system: { type: "text", text: catalogText() } };
	const blockOut = optimize(blockPayload, BASE) as { next: { system: { type: "text"; text: string } }; removedChars: number };
	assert.ok(blockOut.removedChars > 0);
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
	const { next, removedChars, selected } = optimize(payload, { ...BASE, topK: 1 }) as {
		next: { tools: Array<{ name: string; description: string }> };
		removedChars: number;
		selected: string[];
	};
	assert.ok(removedChars > 0);
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
	const { next, selected, removedChars } = optimize(payload, { ...BASE, topK: 1 }) as {
		next: { system: string; tools: Array<{ name: string; description: string; input_schema?: unknown }> };
		selected: string[];
		removedChars: number;
	};
	assert.ok(removedChars > 0);
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
	assert.ok(!cat.includes("<name>hashcat</name>")); // never → removedChars entirely
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
	const { next, removedChars } = optimize(payload, BASE);
	assert.equal(next, payload);
	assert.equal(removedChars, 0);
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
		removedChars: number; removedSkills: number; removedTools: number; droppedTools: string[];
	};
	assert.ok(r.removedSkills > 0); // catalog rewrite
	assert.ok(r.removedTools > 0); // dropped tool definition
	assert.equal(r.removedChars, r.removedSkills + r.removedTools);
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
	const payload = {
		input: [{ role: "user", content: [{ type: "input_text", text: "recover RSA" }] }],
		instructions: catalogText(),
	};
	const { next, removedSkills, selected } = optimize(payload, BASE) as {
		next: { instructions: string }; removedSkills: number; selected: string[];
	};
	assert.ok(removedSkills > 0);
	assert.ok(next.instructions.includes("<available_skills>"));
	assert.ok(next.instructions.includes("<name>rsactftool</name>"));
	assert.ok(next.instructions.includes("Use when recovering RSA keys"));
	assert.deepEqual(selected, ["rsactftool"]);
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

test("extracts the hybrid query from Gemini contents", () => {
	const payload = {
		contents: [{ role: "user", parts: [{ text: "capture packet traffic" }] }],
		systemInstruction: { parts: [{ text: catalogText() }] },
	};
	const { selected } = optimize(payload, BASE);
	assert.deepEqual(selected, ["tcpdump"]);
});

test("used OpenAI Responses tools remain callable and preserve payload identity", () => {
	const payload = {
		input: [
			{ role: "user", content: [{ type: "input_text", text: "continue" }] },
			{ type: "function_call", name: "vendor_used", arguments: "{}" },
		],
		tools: [{ name: "vendor_used", description: "Used earlier." }, { name: "Bash", description: "core" }],
	};
	const result = optimize(payload, { ...BASE, mode: "off", toolsMode: "drop", toolsDropPrefixes: ["vendor_"] });
	assert.equal(result.next, payload);
	assert.deepEqual(result.droppedTools, []);
});

test("tools relevance preserves identity when a multimodal request has no text signal", () => {
	const payload = {
		input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] }],
		tools: [{ name: "view_image", description: "Inspect an image." }],
	};
	const result = optimize(payload, { ...BASE, mode: "off", toolsMode: "relevance", toolsTopK: 1 });
	assert.equal(result.next, payload);
	assert.equal(result.removedChars, 0);
	assert.deepEqual(result.droppedTools, []);
});

test("rewrites catalogs in nested OpenAI Chat function descriptions", () => {
	const payload = {
		messages: [{ role: "user", content: "recover RSA" }],
		tools: [{ type: "function", function: { name: "Skill", description: catalogText() } }],
	};
	const result = optimize(payload, BASE) as {
		next: { tools: Array<{ function: { description: string } }> };
		removedChars: number;
		selected: string[];
	};
	assert.ok(result.removedChars > 0);
	assert.deepEqual(result.selected, ["rsactftool"]);
	assert.ok(result.next.tools[0].function.description.includes("Use when recovering RSA keys"));
});

test("full-render budget is propagated while rejected skills remain loadable; zero is unlimited", () => {
	const largeRelevant = `Unique pathological router. ${"Large specialist detail. ".repeat(700)}`.trimEnd();
	const filler = (name: string): string => skillXml(name, `Unrelated ${name} workflow. ${"Operational detail. ".repeat(12)}`);
	const system = `<available_skills>\n${[
		skillXml("pathological-router", largeRelevant),
		filler("database-maintenance"),
		filler("network-audit"),
		filler("release-planning"),
		filler("documentation-guide"),
	].join("\n")}\n</available_skills>`;
	const payload = { messages: [{ role: "user", content: "unique pathological router" }], system };

	const capped = optimize(payload, { ...BASE, fullRenderBudgetChars: 1 }) as {
		next: { system: string };
		selected: string[];
	};
	assert.deepEqual(capped.selected, []);
	assert.ok(capped.next.system.includes("<name>pathological-router</name>"));
	assert.ok(capped.next.system.includes("<skill_path_note>"));
	assert.ok(capped.next.system.includes("C:/s"));
	assert.ok(!capped.next.system.includes(largeRelevant));

	const unlimited = optimize(payload, { ...BASE, topK: 5, fullRenderBudgetChars: 0 }) as {
		next: { system: string };
		selected: string[];
	};
	assert.deepEqual(unlimited.selected, ["pathological-router"]);
	assert.ok(unlimited.next.system.includes(largeRelevant));
	assert.ok(unlimited.next.system.includes("C:/s/pathological-router/SKILL.md"));

	const identity = optimize(payload, { ...BASE, mode: "off", fullRenderBudgetChars: 1 });
	assert.equal(identity.next, payload);
});
