import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { formatOptimizerToolSearchResult, formatSkillSearchResult } from "../src/ui/search-projections.ts";
import { registerSearchToolRenderers } from "../src/ui/search-renderers.ts";

const searchResult = {
	content: [{
		type: "text" as const,
		text: JSON.stringify({
			results: [
				{ name: "mcp__issues__find", description: "Search issue tracker tickets", score: 2.75, matchedTerms: ["tickets"], matchedFields: ["description", "schemaText"] },
				{ name: "mcp__issues__update", description: "Update an issue", score: 1.25, matchedTerms: ["issue"], matchedFields: ["name"] },
				{ name: "mcp__issues__create", description: "Create a ticket", score: 0.5, matchedTerms: ["ticket"], matchedFields: ["description"] },
			],
			total: 11,
			nextCursor: "td1:abc:issue:3",
			confidence: "high",
			failOpen: false,
			activated: ["mcp__issues__find", "mcp__issues__update"],
		}),
	}],
};

test("registered renderers support the floor context without keybinding helpers", () => {
	type Renderers = NonNullable<ReturnType<ToolRendererResolver>>;
	type RenderContext = Parameters<NonNullable<Renderers["renderResult"]>>[3];
	let resolve: ToolRendererResolver | undefined;
	registerSearchToolRenderers({ registerToolRenderer(resolver) { resolve = resolver; } } as ExtensionAPI);
	assert.ok(resolve);
	const base = { renderShell: "self" as const };
	assert.equal(resolve("another_tool", () => base), base, "unrelated renderers keep their original identity");
	for (const name of ["optimizer_tool_search", "skill_search"]) {
		const renderers: Renderers = resolve(name, () => base)!;
		assert.equal(renderers.renderShell, "self", "search projections preserve the next renderer's shell policy");
		// Pi 1.0.1 supplies these fields; it has no keyHint/keyText or outputPad.
		const context = {
			args: { action: "search", query: "tickets" }, toolCallId: "floor-render", invalidate() {},
			lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: true,
			argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false,
		} as RenderContext;
		assert.equal("keyHint" in context, false);
		const theme = { fg: (_color: string, text: string) => text } as never;
		const result = { ...(name === "optimizer_tool_search" ? searchResult : { content: [{ type: "text" as const, text: JSON.stringify({
			total: 1, items: [{ name: "ticket-guidance", summary: "Review ticket evidence.", tags: ["review"] }], usedChars: 160,
		}) }] }), details: {} };
		const render = (expanded: boolean) => {
			context.expanded = expanded;
			return renderers.renderResult!(result, { expanded, isPartial: false }, theme, context).render(120).join("\n");
		};
		assert.match(renderers.renderCall!(context.args, theme, context).render(120).join("\n"), /search.*tickets/);
		assert.match(render(false), /expand tool output for details/i);
		assert.match(render(true), name === "optimizer_tool_search" ? /Matched fields: description, schemaText/ : /Tags: review/);
		context.isError = true;
		assert.match(render(false), /tool error output/);
		assert.match(render(true), /tool error output/);
		if (name === "skill_search") {
			context.isError = false;
			context.args = { action: "load", name: "ticket-guidance" };
			const loaded = { content: [{ type: "text" as const, text: "# Full instructions\nRead every source.\n" }], details: {} };
			const output = renderers.renderResult!(loaded, { expanded: true, isPartial: false }, theme, context).render(120).map((line) => line.trimEnd()).join("\n");
			assert.match(output, /# Full instructions\nRead every source\./);
		}
	}
});

test("optimizer tool search renderer shows a concise preview and a complete expanded page", () => {
	const compact = formatOptimizerToolSearchResult(searchResult, false, "ctrl+o to expand details").join("\n");
	assert.match(compact, /issue tracker tickets/i);
	assert.match(compact, /3 of 11 results/);
	assert.match(compact, /mcp__issues__find/);
	assert.match(compact, /More results available/);
	assert.match(compact, /ctrl\+o to expand details/);
	assert.doesNotMatch(compact, /Confidence: high|Matched fields|td1:abc|Activated: mcp__/);
	assert.ok(compact.split("\n").length <= 5, "collapsed output stays to counts, at most three results, and one hint");

	const expanded = formatOptimizerToolSearchResult(searchResult, true, "ctrl+o to expand details").join("\n");
	for (const expected of [
		"Confidence: high",
		"Fail-open: no",
		"mcp__issues__find",
		"Search issue tracker tickets",
		"Score: 2.75",
		"Matched terms: tickets",
		"Matched fields: description, schemaText",
		"Next cursor: td1:abc:issue:3",
		"Activated: mcp__issues__find, mcp__issues__update",
		"mcp__issues__create",
	]) assert.ok(expanded.includes(expected), `expanded view omitted ${expected}`);
	assert.doesNotMatch(expanded, /[{}]/, "the known response should not be presented as raw JSON");
});

test("optimizer tool search renderer safely falls back for malformed content", () => {
	const fallback = formatOptimizerToolSearchResult({ content: [{ type: "text", text: "\u001b[31mnot-json\u001b[0m\nsecond line" }] }, true, "expand");
	assert.ok(fallback.join("\n").includes("not-json"));
	assert.ok(fallback.join("\n").includes("second line"));
	assert.doesNotMatch(fallback.join("\n"), /\u001b/);

	const longText = `first line\n${"x".repeat(400)}\nend of output`;
	const compact = formatOptimizerToolSearchResult({ content: [{ type: "text", text: longText }] }, false, "ctrl+o to expand details").join("\n");
	assert.match(compact, /more output; ctrl\+o to expand details/);
	assert.doesNotMatch(compact, /end of output/);
	const expanded = formatOptimizerToolSearchResult({ content: [{ type: "text", text: longText }] }, true, "ctrl+o to expand details").join("\n");
	assert.ok(expanded.endsWith("end of output"));
	assert.match(expanded, /first line\n/);
	const manyLines = `${"\n".repeat(10_000)}final line`;
	const manyLineCompact = formatOptimizerToolSearchResult({ content: [{ type: "text", text: manyLines }] }, false, "ctrl+o to expand details");
	assert.ok(manyLineCompact.length <= 6, "a blank-line-heavy fallback stays bounded in the collapsed card");
	assert.match(manyLineCompact.at(-1) ?? "", /more output; ctrl\+o to expand details/);
	const manyLineExpanded = formatOptimizerToolSearchResult({ content: [{ type: "text", text: manyLines }] }, true, "ctrl+o to expand details");
	assert.ok(manyLineExpanded.length > 10_000);
	assert.equal(manyLineExpanded.at(-1), "final line", "expanding must retain the entire sanitized source");

	const error = formatOptimizerToolSearchResult({ content: searchResult.content }, true, "expand", true).join("\n");
	assert.match(error, /tool error output/);
	assert.doesNotMatch(error, /Confidence: high/, "an error response must not be presented as a successful search page");
});

test("skill search renderer projects ranked skill results into the shared card", () => {
	const result = { content: [{ type: "text", text: JSON.stringify({
		query: "repository boundaries",
		fingerprint: "skills:abc",
		confidence: 0.82,
		total: 9,
		items: [
			{ name: "repo-architecture", intent: "Review module ownership and boundaries.", score: 4.2, confidence: 0.9, reasons: ["lexical", "profile"] },
			{ name: "test-reliability", intent: "Keep integration tests deterministic.", score: 2.4, confidence: 0.63, reasons: ["lexical"] },
		],
		nextCursor: "ss:abc:2",
	}) }] };

	const compact = formatSkillSearchResult(result, "search", false, "ctrl+o to expand details").join("\n");
	assert.match(compact, /2 of 9 skills/);
	assert.match(compact, /repo-architecture: Review module ownership/);
	assert.match(compact, /more results|more skills/i);
	assert.match(compact, /ctrl\+o to expand details/);
	assert.doesNotMatch(compact, /fingerprint|Score:|Reasons:|ss:abc|\{"query"/);

	const expanded = formatSkillSearchResult(result, "search", true, "expand").join("\n");
	for (const expected of ["Search confidence: 0.82", "repo-architecture", "Score: 4.2", "Confidence: 0.9", "Reasons: lexical, profile", "Next cursor: ss:abc:2", "test-reliability"]) {
		assert.ok(expanded.includes(expected), `expanded ranked view omitted ${expected}`);
	}
	assert.doesNotMatch(expanded, /[{}]/, "recognized ranked results should not render as raw JSON");
});

test("skill search renderer projects catalog browse facets and rescue markers", () => {
	const result = { content: [{ type: "text", text: JSON.stringify({
		total: 5,
		items: [
			{ name: "architecture", summary: "Review system boundaries.", tags: ["architecture", "review"], rescue: true },
			{ name: "testing", summary: "Make tests reliable.", tags: ["testing"] },
		],
		facets: [{ id: "architecture", count: 3 }, { id: "review", count: 2 }],
		rest: ["other-skill"],
		nextCursor: "cb:abc:2",
		usedChars: 417,
	}) }] };

	const compact = formatSkillSearchResult(result, "search", false, "ctrl+o to expand details").join("\n");
	assert.match(compact, /2 of 5 skills/);
	assert.match(compact, /architecture: Review system boundaries/);
	assert.match(compact, /more results|more skills/i);
	assert.doesNotMatch(compact, /Facets:|Tags:|cb:abc|Used chars/);

	const expanded = formatSkillSearchResult(result, "search", true, "expand").join("\n");
	for (const expected of ["Tags: architecture, review", "Rescue match", "Facets: architecture (3), review (2)", "Rest: other-skill", "Used chars: 417", "Next cursor: cb:abc:2"]) {
		assert.ok(expanded.includes(expected), `expanded catalog view omitted ${expected}`);
	}
	assert.doesNotMatch(expanded, /[{}]/, "recognized catalog results should not render as raw JSON");
});

test("catalog compact count includes the rest of the total across a page", () => {
	const items = Array.from({ length: 10 }, (_, index) => ({
		name: `skill-${index}`,
		summary: `Summary ${index}`,
		tags: ["testing"],
	}));
	const result = { content: [{ type: "text", text: JSON.stringify({
		total: 20, items, rest: Array.from({ length: 10 }, (_, index) => `rest-${index}`), usedChars: 900,
	}) }] };
	const compact = formatSkillSearchResult(result, "search", false, "expand").join("\n");
	assert.match(compact, /3 of 20 skills/);
	assert.match(compact, /17 more skills/);
});

test("only skill_search search actions are projected; load output remains full text", () => {
	const skillText = `# Repository guidance\n\n${"Read the source before editing.\n".repeat(40)}`;
	const result = { content: [{ type: "text", text: skillText }] };
	const compact = formatSkillSearchResult(result, "load", false, "ctrl+o to expand details");
	assert.equal(compact[0], "tool output");
	assert.ok(compact.includes("# Repository guidance"));
	assert.ok(compact.includes("Read the source before editing."));
	assert.ok(compact.at(-1)?.includes("more output; ctrl+o to expand details"));
	assert.ok(compact.length <= 6, "collapsed load output stays bounded");
	assert.deepEqual(formatSkillSearchResult(result, "load", true, "expand"), ["tool output", ...skillText.split("\n")]);
});
