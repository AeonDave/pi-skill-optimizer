import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildToolDiscoveryCatalog,
	CORE_TOOLS,
	planToolActivation,
	searchToolDiscoveryCatalog,
} from "../src/tools.ts";

const TOOLS = [
	{ name: "Read", description: "Read a file." },
	{ name: "Bash", description: "Run a shell command." },
	{ name: "htb_app_whoami", description: "HackTheBox current user." },
	{ name: "htb_app_search", description: "HackTheBox search machines." },
	{ name: "mcpwn_run", description: "Run a pwn command." },
	{ name: "tavily_search", description: "Search the web for current information and news." },
];

test("CORE_TOOLS contains obvious built-ins", () => {
	for (const name of ["read", "bash", "edit", "write", "subagent", "skill"]) assert.ok(CORE_TOOLS.has(name));
});

test("build catalog keeps core and configured prefixes always active", () => {
	const catalog = buildToolDiscoveryCatalog(TOOLS, { protect: ["HTB_APP_"] });
	assert.deepEqual(catalog.alwaysActiveNames, ["Read", "Bash", "htb_app_whoami", "htb_app_search"]);
	assert.deepEqual(catalog.candidateNames, ["mcpwn_run", "tavily_search"]);
	assert.equal(catalog.entries.length, TOOLS.length);
	assert.notEqual(catalog.tools, TOOLS);
	assert.deepEqual(catalog.tools, TOOLS);
});

test("catalog supports nested OpenAI definitions and reports malformed entries", () => {
	const tools = [
		undefined,
		{ type: "function", function: { name: "asset_lookup", description: "Fetch an asset.", parameters: { type: "object" } } },
	];
	const catalog = buildToolDiscoveryCatalog(tools);
	assert.deepEqual(catalog.unmanagedToolIndexes, [0]);
	assert.deepEqual(catalog.candidateNames, ["asset_lookup"]);
});

test("BM25F uses bounded direct schema names, descriptions, and enums", () => {
	const catalog = buildToolDiscoveryCatalog([
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
	]);
	const page = searchToolDiscoveryCatalog(catalog, "critical github security advisory identifier");
	assert.equal(page.confidence, "high");
	assert.equal(page.failOpen, false);
	assert.equal(page.results[0]?.name, "record_lookup");
	assert.ok(page.results[0]?.matchedFields.includes("schemaName"));
	assert.ok(page.results[0]?.matchedFields.includes("schemaText"));
});

test("BM25F indexes nested OpenAI function.parameters", () => {
	const catalog = buildToolDiscoveryCatalog([
		{
			type: "function",
			function: {
				name: "asset_lookup",
				description: "Fetch an asset.",
				parameters: {
					type: "object",
					properties: {
						cloudRegion: { type: "string", description: "Deployment geography", enum: ["eu-west-1"] },
					},
				},
			},
		},
		{ type: "function", function: { name: "asset_delete", description: "Delete an asset." } },
	]);
	const page = searchToolDiscoveryCatalog(catalog, "deployment geography eu west");
	assert.equal(page.results[0]?.name, "asset_lookup");
	assert.equal(page.confidence, "high");
});

test("schema traversal ignores routing text beyond the depth bound", () => {
	const hidden = { properties: { hiddenNeedle: { description: "impossibleRoutingMarker" } } };
	const deep = {
		properties: {
			level1: {
				properties: {
					level2: {
						properties: {
							level3: {
								properties: {
									level4: { properties: { level5: hidden } },
								},
							},
						},
					},
				},
			},
		},
	};
	const catalog = buildToolDiscoveryCatalog([
		{ name: "first_tool", input_schema: deep },
		{ name: "second_tool", description: "ordinary" },
	]);
	const page = searchToolDiscoveryCatalog(catalog, "impossibleRoutingMarker", { pageSize: 10 });
	assert.equal(page.confidence, "none");
	assert.equal(page.failOpen, true);
	assert.deepEqual(page.results.map((result) => result.name), ["first_tool", "second_tool"]);
});

test("schema arrays stop reading at the shared work budget, including empty values and branches", () => {
	for (const key of ["required", "enum", "allOf", "anyOf", "oneOf"]) {
		let reads = 0;
		const values = new Proxy(Array(10_000).fill(null), {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
				return Reflect.get(target, property, receiver);
			},
		});
		buildToolDiscoveryCatalog([{ name: "custom_tool", parameters: { [key]: values } }]);
		assert.ok(reads <= 256, `${key} read ${reads} array entries`);
	}
});

test("schema array budget is shared across fields and nested schemas", () => {
	let reads = 0;
	const values = new Proxy(Array(200).fill(null), {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
			return Reflect.get(target, property, receiver);
		},
	});
	buildToolDiscoveryCatalog([{
		name: "custom_tool",
		parameters: { required: values, properties: { nested: { enum: values } }, allOf: values },
	}]);
	assert.ok(reads <= 256, `schema read ${reads} total array entries`);
});

test("nested arrays cannot spend the budget reserved by a parent property loop twice", () => {
	let reads = 0;
	const values = new Proxy(Array(256).fill(null), {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
			return Reflect.get(target, property, receiver);
		},
	});
	const properties = {
		get alpha() { reads += 1; return { enum: values }; },
		get beta() { reads += 1; return {}; },
	};
	buildToolDiscoveryCatalog([{ name: "custom_tool", parameters: { properties } }]);
	assert.equal(reads, 256, "property and nested array reads must share one budget");
});

test("schema text cap stops array reads and bounds source text before normalization", () => {
	const values = ["needle ".repeat(1_000)];
	Object.defineProperty(values, 1, { get() { throw new Error("schema text budget was exhausted"); } });
	const catalog = buildToolDiscoveryCatalog([{ name: "custom_tool", parameters: { enum: values } }]);
	assert.ok(catalog.entries[0]?.fields.schemaText.frequencies.has("needle"));
	const whitespace = buildToolDiscoveryCatalog([{
		name: "custom_tool",
		parameters: { description: `${" ".repeat(10_000)}unboundedTailMarker` },
	}]);
	assert.equal(searchToolDiscoveryCatalog(whitespace, "unboundedTailMarker").confidence, "none");
});

test("bounded schema properties retain canonical order independently of insertion order", () => {
	const properties = { zebraKey: { description: "Zebra evidence" }, alphaKey: { description: "Alpha evidence" } };
	const first = buildToolDiscoveryCatalog([{ name: "custom_tool", parameters: { properties } }]);
	const second = buildToolDiscoveryCatalog([{
		name: "custom_tool",
		parameters: { properties: Object.fromEntries(Object.entries(properties).reverse()) },
	}]);
	assert.equal(first.fingerprint, second.fingerprint);
	assert.deepEqual([...first.entries[0]!.fields.schemaName.frequencies.keys()], ["alpha", "key", "zebra"]);
});

test("oversized schema property collections skip property reads and retain ordinary tool discovery", () => {
	let reads = 0;
	const properties = Object.create(null) as Record<string, unknown>;
	for (let index = 0; index < 257; index += 1) {
		Object.defineProperty(properties, `hiddenNeedle${index}`, {
			enumerable: true,
			get() { reads += 1; return { description: "unboundedTailMarker" }; },
		});
	}
	const catalog = buildToolDiscoveryCatalog([{
		name: "custom_tool",
		description: "Retrieve a weather forecast",
		parameters: { properties, description: "Bounded root description" },
	}]);
	assert.equal(reads, 0);
	assert.equal(catalog.entries[0]?.fields.schemaName.length, 0);
	assert.equal(searchToolDiscoveryCatalog(catalog, "unboundedTailMarker").confidence, "none");
	assert.equal(searchToolDiscoveryCatalog(catalog, "custom tool").results[0]?.name, "custom_tool");
	assert.equal(searchToolDiscoveryCatalog(catalog, "weather forecast").results[0]?.name, "custom_tool");
	assert.ok(catalog.entries[0]?.fields.schemaText.frequencies.has("bounded"));
});

test("exact name evidence outranks description-only evidence", () => {
	const catalog = buildToolDiscoveryCatalog([
		{ name: "invoice_lookup", description: "Fetch billing data." },
		{ name: "generic_fetch", description: "Use this for invoice lookup operations." },
	]);
	const page = searchToolDiscoveryCatalog(catalog, "invoice lookup");
	assert.equal(page.confidence, "high");
	assert.equal(page.results[0]?.name, "invoice_lookup");
});

test("search pagination is deterministic and cursors are catalog/query bound", () => {
	const catalog = buildToolDiscoveryCatalog([
		{ name: "alpha_tool", description: "First." },
		{ name: "beta_tool", description: "Second." },
		{ name: "gamma_tool", description: "Third." },
		{ name: "delta_tool", description: "Fourth." },
	]);
	const first = searchToolDiscoveryCatalog(catalog, "unmatched", { pageSize: 2 });
	assert.deepEqual(first.results.map((result) => result.name), ["alpha_tool", "beta_tool"]);
	assert.ok(first.nextCursor);
	const second = searchToolDiscoveryCatalog(catalog, "unmatched", { pageSize: 2, cursor: first.nextCursor });
	assert.deepEqual(second.results.map((result) => result.name), ["gamma_tool", "delta_tool"]);
	assert.equal(second.nextCursor, undefined);
	assert.throws(
		() => searchToolDiscoveryCatalog(catalog, "different query", { cursor: first.nextCursor }),
		/Invalid tool discovery cursor/,
	);
});

test("search result descriptions are compact and configurable", () => {
	const catalog = buildToolDiscoveryCatalog([{ name: "long_tool", description: `needle ${"x".repeat(600)}` }]);
	const page = searchToolDiscoveryCatalog(catalog, "needle", { descriptionChars: 40 });
	assert.equal(page.results[0]?.description.length, 40);
	assert.ok(page.results[0]?.description.endsWith("..."));
});

test("activation keeps core, protected, and used tools in stable registration order", () => {
	const catalog = buildToolDiscoveryCatalog(TOOLS, { protect: ["htb_app_whoami"] });
	const plan = planToolActivation(catalog, "tavily web current news", {
		topK: 1,
		usedNames: new Set(["MCPWN_RUN"]),
	});
	assert.equal(plan.reason, "confident-match");
	assert.equal(plan.failOpen, false);
	assert.deepEqual(plan.alwaysActiveNames, ["Read", "Bash", "htb_app_whoami", "mcpwn_run"]);
	assert.deepEqual(plan.selectedNames, ["tavily_search"]);
	assert.deepEqual(plan.activeNames, ["Read", "Bash", "htb_app_whoami", "mcpwn_run", "tavily_search"]);
});

test("activation fails open on empty, unmatched, weak, and invalid-budget queries", () => {
	const catalog = buildToolDiscoveryCatalog(TOOLS);
	for (const [query, topK] of [["", 1], ["qzxvplm", 1], ["current", 1], ["tavily", 0]] as const) {
		const plan = planToolActivation(catalog, query, { topK });
		assert.equal(plan.failOpen, true, `${query}/${topK}`);
		assert.deepEqual(plan.activeNames, TOOLS.map((tool) => tool.name));
		assert.deepEqual(plan.selectedNames, []);
	}
});

test("activation fails open when a top-K cutoff is tied", () => {
	const catalog = buildToolDiscoveryCatalog([
		{ name: "alpha_search", description: "Search records." },
		{ name: "beta_search", description: "Search records." },
		{ name: "gamma_search", description: "Search records." },
	]);
	const plan = planToolActivation(catalog, "search records", { topK: 1 });
	assert.equal(plan.reason, "ambiguous-cutoff");
	assert.equal(plan.failOpen, true);
	assert.deepEqual(plan.activeNames, ["alpha_search", "beta_search", "gamma_search"]);
});

test("catalog fingerprints and rankings are deterministic", () => {
	const first = buildToolDiscoveryCatalog(TOOLS, { protect: ["htb_"] });
	const second = buildToolDiscoveryCatalog(TOOLS, { protect: ["htb_"] });
	assert.equal(first.fingerprint, second.fingerprint);
	assert.deepEqual(searchToolDiscoveryCatalog(first, "web news"), searchToolDiscoveryCatalog(second, "web news"));
});
