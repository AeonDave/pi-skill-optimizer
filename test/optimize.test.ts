import assert from "node:assert/strict";
import { test } from "node:test";
import { optimize, type OptimizeConfig } from "../src/optimize.ts";

const BASE: OptimizeConfig = {
	mode: "hybrid",
	topK: 1,
	tailChars: 40,
	keepLocations: false,
	extraStripTags: [],
	dropAnchors: [],
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

test("strip mode removes the whole catalog", () => {
	const { next, removed } = optimize(payloadWithCatalogInSystem(), { ...BASE, mode: "strip" }) as {
		next: { system: Array<{ text: string }> };
		removed: number;
	};
	assert.ok(removed > 0);
	assert.ok(!next.system[1].text.includes("<available_skills>"));
	assert.ok(!next.system[1].text.includes("<skill>"));
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
			{ name: "Skill", description: `Execute a skill.\n<available_skills>\n${skillXml("hashcat", "GPU password cracking tool. Many hashes.")}\n${skillXml("tcpdump", "Packet capture.")}\n</available_skills>` },
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
		system: `sys\n<available_skills>\n${skillXml("rsactftool", "RSA recovery tool.")}\n${skillXml("tcpdump", "Packet capture.")}\n</available_skills>`,
		tools: [
			{ name: "Skill", description: `Skill tool.\n<available_skills>\n${skillXml("hashcat", "Password hash cracking with GPU.")}\n${skillXml("apktool", "Android APK reverse engineering.")}\n</available_skills>` },
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
				description: `Loads skills.\n<available_skills>\n${skillXml("mobile-technique", "Android application assessment workflow.")}\n${skillXml("python-testing", "Python testing workflow.")}\n</available_skills>`,
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

test("extraStripTags and dropAnchors are also applied", () => {
	const payload = {
		messages: [],
		system: "keep\n\n<junk>noise</junk>\n\nPi documentation block here\n\nkeep too",
	};
	const { next } = optimize(payload, {
		...BASE,
		mode: "off",
		extraStripTags: ["junk"],
		dropAnchors: ["Pi documentation"],
	}) as { next: { system: string } };
	const text = next.system;
	assert.ok(!text.includes("<junk>"));
	assert.ok(!text.includes("Pi documentation"));
	assert.ok(text.includes("keep") && text.includes("keep too"));
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
