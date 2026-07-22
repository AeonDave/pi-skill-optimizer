import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_TOOLS, optimizeTools, type ToolsOptions } from "../src/tools.ts";

const TOOLS = [
	{ name: "Read", description: "Read a file." },
	{ name: "Bash", description: "Run a shell command." },
	{ name: "htb_app_whoami", description: "HackTheBox: current user." },
	{ name: "htb_app_search", description: "HackTheBox: search machines." },
	{ name: "mcpwn_run", description: "Run a pwn command." },
	{ name: "tavily_search", description: "Search the web for current information and news." },
];

const BASE: ToolsOptions = { mode: "drop", dropPrefixes: [], topK: 24, protect: [], keepNames: new Set(), query: "" };

test("CORE_TOOLS contains the obvious built-ins (case-insensitive lookup)", () => {
	for (const n of ["read", "bash", "edit", "write", "subagent", "skill"]) assert.ok(CORE_TOOLS.has(n));
});

test("drop mode removes only prefixed, non-core, non-used tools", () => {
	const { tools, dropped, removedChars } = optimizeTools(TOOLS, {
		...BASE,
		mode: "drop",
		dropPrefixes: ["htb_", "mcpwn_"],
	});
	assert.deepEqual(dropped.sort(), ["htb_app_search", "htb_app_whoami", "mcpwn_run"]);
	assert.ok(removedChars > 0);
	assert.deepEqual((tools as Array<{ name: string }>).map((t) => t.name), ["Read", "Bash", "tavily_search"]);
});

test("drop mode never removes a core tool even if a prefix would match", () => {
	const { dropped } = optimizeTools([{ name: "bash_extra", description: "x" }, { name: "Bash", description: "core" }], {
		...BASE,
		mode: "drop",
		dropPrefixes: ["bash"],
	});
	assert.ok(dropped.includes("bash_extra"));
	assert.ok(!dropped.includes("Bash")); // core protected
});

test("keepNames (used tools) and protect prefixes are never dropped", () => {
	const { dropped } = optimizeTools(TOOLS, {
		...BASE,
		mode: "drop",
		dropPrefixes: ["htb_", "tavily_"],
		keepNames: new Set(["tavily_search"]),
		protect: ["htb_app_search"],
	});
	assert.ok(!dropped.includes("tavily_search")); // used
	assert.ok(!dropped.includes("htb_app_search")); // protected
	assert.deepEqual(dropped, ["htb_app_whoami"]);
});

test("relevance mode keeps core + the top-K relevant of the rest", () => {
	const { tools, dropped } = optimizeTools(TOOLS, {
		...BASE,
		mode: "relevance",
		topK: 1,
		query: "search the web for security news",
	});
	const names = (tools as Array<{ name: string }>).map((t) => t.name);
	assert.ok(names.includes("Read") && names.includes("Bash")); // core kept
	assert.ok(names.includes("tavily_search")); // most relevant non-core
	assert.ok(dropped.includes("htb_app_whoami") && dropped.includes("mcpwn_run"));
});

test("relevance mode preserves original tool order among the kept", () => {
	const { tools } = optimizeTools(TOOLS, { ...BASE, mode: "relevance", topK: 2, query: "hackthebox machine search" });
	const names = (tools as Array<{ name: string }>).map((t) => t.name);
	// core first (Read, Bash) in original positions, then the kept htb_ tools in order
	assert.deepEqual(names.slice(0, 2), ["Read", "Bash"]);
	assert.ok(names.indexOf("htb_app_whoami") < names.indexOf("htb_app_search"));
});

test("optimizeTools is identity (removedChars 0, same ref) when nothing is dropped", () => {
	const res = optimizeTools(TOOLS, { ...BASE, mode: "drop", dropPrefixes: ["nomatch_"] });
	assert.equal(res.tools, TOOLS);
	assert.equal(res.removedChars, 0);
	assert.deepEqual(res.dropped, []);
});

test("relevance mode is an identity no-op without lexical signal", () => {
	for (const query of ["", "qzxvplm"]) {
		const res = optimizeTools(TOOLS, { ...BASE, mode: "relevance", topK: 1, query });
		assert.equal(res.tools, TOOLS);
		assert.equal(res.removedChars, 0);
		assert.deepEqual(res.dropped, []);
	}
});

test("removedChars counts JSON-serialized characters", () => {
	const tools = [{ name: "drop_me", description: "line\n\"C:\\tmp\"" }, { name: "Bash", description: "core" }];
	const res = optimizeTools(tools, { ...BASE, mode: "drop", dropPrefixes: ["drop_"] });
	assert.equal(res.removedChars, JSON.stringify(tools).length - JSON.stringify(res.tools).length);
});

test("optimizeTools handles a non-array gracefully", () => {
	const res = optimizeTools(undefined, BASE);
	assert.equal(res.removedChars, 0);
	assert.deepEqual(res.dropped, []);
});

test("relevance mode keeps malformed tool entries instead of crashing", () => {
	const malformed = undefined;
	const { tools, dropped } = optimizeTools([malformed, { name: "Bash", description: "core" }, { name: "foo_search", description: "Search foo." }], {
		...BASE,
		mode: "relevance",
		topK: 1,
		query: "foo search",
	});
	assert.equal(tools[0], malformed);
	assert.deepEqual((tools as Array<{ name?: string } | undefined>).map((t) => t?.name), [undefined, "Bash", "foo_search"]);
	assert.deepEqual(dropped, []);
});

test("drop and relevance modes understand nested OpenAI Chat function definitions", () => {
	const tools = [
		{ type: "function", function: { name: "vendor_search", description: "Search current vulnerability news." } },
		{ type: "function", function: { name: "vendor_other", description: "Unrelated operation." } },
	];
	const dropped = optimizeTools(tools, { ...BASE, mode: "drop", dropPrefixes: ["vendor_"] });
	assert.deepEqual(dropped.dropped, ["vendor_search", "vendor_other"]);
	const relevant = optimizeTools(tools, { ...BASE, mode: "relevance", topK: 1, query: "search vulnerability news" });
	assert.deepEqual(relevant.dropped, ["vendor_other"]);
	assert.equal(relevant.tools[0], tools[0]);
});

test("relevance indexes bounded direct input schemas without changing tool payloads", () => {
	const tools = [
		{
			name: "record_lookup",
			description: "Fetch one record.",
			input_schema: {
				type: "object",
				required: ["advisoryId"],
				properties: {
					advisoryId: { type: "string", description: "GitHub security advisory identifier" },
					severity: { type: "string", enum: ["critical", "high", "medium"] },
				},
			},
		},
		{ name: "record_archive", description: "Archive one record." },
	];
	const result = optimizeTools(tools, { ...BASE, mode: "relevance", topK: 1, query: "critical github security advisory identifier" });
	assert.deepEqual(result.dropped, ["record_archive"]);
	assert.equal(result.tools[0], tools[0]);
	assert.deepEqual(result.tools[0], tools[0]);
});

test("relevance indexes OpenAI function.parameters property descriptions and enums", () => {
	const tools = [
		{
			type: "function",
			function: {
				name: "asset_lookup",
				description: "Fetch an asset.",
				parameters: {
					type: "object",
					properties: {
						cloudRegion: { type: "string", description: "Deployment geography", enum: ["eu-west-1", "us-east-1"] },
					},
				},
			},
		},
		{ type: "function", function: { name: "asset_delete", description: "Delete an asset." } },
	];
	const result = optimizeTools(tools, { ...BASE, mode: "relevance", topK: 1, query: "deployment geography eu west" });
	assert.deepEqual(result.dropped, ["asset_delete"]);
	assert.equal(result.tools[0], tools[0]);
});
