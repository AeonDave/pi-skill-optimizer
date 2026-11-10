import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import skillOptimizer from "../src/index.ts";
import { getProfilePaths, getUsageFilePath } from "../src/config.ts";
import { hashSkill } from "../src/profile.ts";
import { INIT_PROFILE_VERSION } from "../src/init-prompt.ts";

type HookHandler = (event: any, ctx: ExtensionContext) => unknown;
type RuntimeTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};

interface RuntimeOptions {
	config?: Record<string, unknown>;
	initialTools?: Array<{ name: string; description: string; exposure?: "direct" | "codemode" | "deferred" | "hidden" }>;
	initialActive?: string[];
	skills?: Skill[];
	hasUI?: boolean;
}

function createRuntime(options: RuntimeOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "sko-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const tempEnvironment = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]]));
	const tempPath = join(root, "temp");
	mkdirSync(tempPath);
	for (const key of Object.keys(tempEnvironment)) process.env[key] = tempPath;
	const optimizerEnvironment = Object.fromEntries(Object.entries(process.env)
		.filter(([key]) => key.startsWith("PI_SKILL_OPTIMIZER_")));
	for (const key of Object.keys(optimizerEnvironment)) delete process.env[key];
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const configPath = join(agentDir, "skill-optimizer", "config.json");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(agentDir, "skill-optimizer"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const writeConfig = (config: Record<string, unknown>): void => {
		writeFileSync(configPath, JSON.stringify(config), "utf8");
	};
	writeConfig(options.config ?? {});

	const handlers = new Map<string, HookHandler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, RuntimeTool>();
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const allTools = new Map<string, unknown>(
		(options.initialTools ?? []).map((tool) => [tool.name, tool]),
	);
	const activeTools = new Set(options.initialActive ?? []);
	const api = {
		registerTool(definition: unknown) {
			const tool = definition as RuntimeTool;
			tools.set(tool.name, tool);
			allTools.set(tool.name, definition);
			activeTools.add(tool.name);
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, definition.handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		on(name: string, handler: HookHandler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
			return () => {};
		},
		getCommands() { return []; },
		getAllTools() { return [...allTools.values()]; },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
		},
	};
	skillOptimizer(api as unknown as ExtensionAPI);

	const ctx = {
		cwd,
		model: { provider: "test", id: "test-model" },
		sessionManager: { getBranch: () => entries },
		getSystemPromptOptions: () => ({ skills: options.skills ?? [] }),
		hasUI: options.hasUI ?? true,
		ui: {
			notify(message: string) { notifications.push(message); },
			setStatus(_key: string, text: string | undefined) { statuses.push(text); },
		},
	} as unknown as ExtensionContext;

	return {
		root,
		cwd,
		ctx,
		tools,
		activeTools,
		notifications,
		statuses,
		entries,
		writeConfig,
		setHostToolExposure(name: string, exposure: "direct" | "codemode" | "deferred" | "hidden"): void {
			const tool = allTools.get(name) as { name: string; description: string } | undefined;
			assert.ok(tool, `unknown host tool ${name}`);
			allTools.set(name, { ...tool, exposure });
			if (exposure === "hidden") activeTools.delete(name);
		},
		addHostTool(tool: { name: string; description: string; exposure?: "direct" | "codemode" | "deferred" | "hidden" }): void {
			allTools.set(tool.name, tool);
			if (tool.exposure !== "deferred" && tool.exposure !== "codemode" && tool.exposure !== "hidden") {
				activeTools.add(tool.name);
			}
		},
		reload(): void {
			handlers.clear();
			commands.clear();
			skillOptimizer(api as unknown as ExtensionAPI);
		},
		async fire(name: string, event: unknown): Promise<unknown[]> {
			const results: unknown[] = [];
			for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
			return results;
		},
		async command(args = ""): Promise<void> {
			const handler = commands.get("skill-optimizer");
			assert.ok(handler, "missing skill-optimizer command");
			await handler(args, ctx);
		},
		dispose(): void {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			for (const key of Object.keys(process.env)) {
				if (key.startsWith("PI_SKILL_OPTIMIZER_")) delete process.env[key];
			}
			for (const [key, value] of Object.entries(optimizerEnvironment)) process.env[key] = value;
			for (const [key, value] of Object.entries(tempEnvironment)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function beforePrompt(runtime: ReturnType<typeof createRuntime>, prompt: string): Promise<void> {
	await runtime.fire("before_agent_start", {
		prompt,
		systemPromptOptions: { skills: [] },
	});
}

const INIT_NOTICE = "Optional setup: run `/skill-optimizer init` to improve skill matching (may incur model costs).";

function modelSkill(name = "typescript"): Skill {
	return {
		name,
		description: "Use when reviewing TypeScript implementation details.",
		location: "",
		disableModelInvocation: false,
		sourceInfo: { scope: "user" },
	} as unknown as Skill;
}

function executeTool(
	runtime: ReturnType<typeof createRuntime>,
	name: string,
	params: unknown,
): Promise<unknown> {
	const tool = runtime.tools.get(name);
	assert.ok(tool, `missing registered tool ${name}`);
	return tool.execute("test-call", params, undefined, undefined, runtime.ctx);
}

test("tool selection replans at each human prompt while search activation is additive", async () => {
	const runtime = createRuntime({
		config: { toolPrefetchMax: 1 },
		initialTools: [
			{ name: "read", description: "Read a file." },
			{ name: "tool_search", description: "Pi built-in tool search." },
			{ name: "database_query", description: "Query PostgreSQL database migrations and rollback state." },
			{ name: "browser_accessibility", description: "Run Playwright browser accessibility tests." },
			{ name: "admin_console", description: "Manage administrator accounts and permissions." },
		],
		initialActive: ["read", "tool_search", "database_query", "browser_accessibility"],
	});
	try {
		await beforePrompt(runtime, "Review the PostgreSQL migration rollback.");
		assert.ok(runtime.activeTools.has("database_query"));
		assert.ok(runtime.activeTools.has("tool_search"), "initially active Pi builtin tool_search was deactivated");
		assert.ok(runtime.activeTools.has("optimizer_tool_search"), "optimizer_tool_search was not kept active");
		assert.ok(!runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("admin_console"));

		await beforePrompt(runtime, "Run Playwright browser accessibility tests.");
		assert.ok(runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("database_query"));
		assert.ok(!runtime.activeTools.has("admin_console"));

		const search = await executeTool(runtime, "optimizer_tool_search", { query: "PostgreSQL migration rollback" });
		const searchText = (search as { content: Array<{ text: string }> }).content[0].text;
		const searchNames = (JSON.parse(searchText) as { results: Array<{ name: string }> }).results.map((tool) => tool.name);
		assert.ok(!searchNames.includes("admin_console"));

		await beforePrompt(runtime, "Review the PostgreSQL migration rollback.");
		assert.ok(runtime.activeTools.has("database_query"));
		for (const name of searchNames) assert.ok(runtime.activeTools.has(name), `${name} was stranded after optimizer_tool_search`);
		assert.ok(!runtime.activeTools.has("admin_console"));
	} finally {
		runtime.dispose();
	}
});

test("initial persona tool restrictions are not widened by optimizer helpers or searchable tools", async () => {
	const runtime = createRuntime({
		initialTools: [
			{ name: "read", description: "Read files.", exposure: "direct" },
			{ name: "admin_console", description: "Manage administrator accounts.", exposure: "direct" },
			{ name: "mcp__issues__find", description: "Find issue tracker tickets.", exposure: "deferred" },
		],
		initialActive: ["read", "admin_console"],
	});
	try {
		// Simulate pi-persona's explicit tool allowlist before the optimizer's first planning pass.
		runtime.activeTools.clear();
		runtime.activeTools.add("read");
		await beforePrompt(runtime, "Find issue tracker tickets and inspect admin accounts.");
		assert.deepEqual([...runtime.activeTools], ["read"]);

		const searched = await executeTool(runtime, "optimizer_tool_search", { query: "issue tracker tickets" });
		const page = JSON.parse((searched as { content: Array<{ text: string }> }).content[0]!.text) as {
			results: Array<{ name: string }>;
			activated: string[];
		};
		assert.deepEqual(page.activated, []);
		assert.ok(!page.results.some(({ name }) => name === "mcp__issues__find"));
		assert.ok(!runtime.activeTools.has("optimizer_tool_search"));
		assert.ok(!runtime.activeTools.has("skill_search"));
		assert.ok(!runtime.activeTools.has("retrieve_output"));
	} finally {
		runtime.dispose();
	}
});

test("external persona narrowing after optimizer planning resets its permission baseline", async () => {
	const runtime = createRuntime({
		config: { toolPrefetchMax: 1 },
		initialTools: [
			{ name: "read", description: "Read files.", exposure: "direct" },
			{ name: "database_query", description: "Query PostgreSQL database migrations.", exposure: "direct" },
			{ name: "browser_accessibility", description: "Run Playwright browser accessibility tests.", exposure: "direct" },
			{ name: "mcp__issues__find", description: "Find issue tracker tickets.", exposure: "deferred" },
		],
		initialActive: ["read", "database_query", "browser_accessibility"],
	});
	try {
		await beforePrompt(runtime, "Run Playwright browser accessibility tests.");
		assert.ok(runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("database_query"));

		// A persona transition is authoritative even though the optimizer narrowed tools on its prior turn.
		runtime.activeTools.clear();
		runtime.activeTools.add("read");
		await beforePrompt(runtime, "Find issue tracker tickets.");
		assert.deepEqual([...runtime.activeTools], ["read"]);
		const searched = await executeTool(runtime, "optimizer_tool_search", { query: "issue tracker tickets" });
		const page = JSON.parse((searched as { content: Array<{ text: string }> }).content[0]!.text) as {
			activated: string[];
		};
		assert.deepEqual(page.activated, []);
		assert.ok(!runtime.activeTools.has("mcp__issues__find"));
		assert.ok(!runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("optimizer_tool_search"));
	} finally {
		runtime.dispose();
	}
});

test("history artifact handles stay retrievable across repeated contexts at the admission cap", async () => {
	const runtime = createRuntime();
	try {
		const firstMessages = Array.from({ length: 128 }, (_, index) => {
			const text = `ordinary result ${index} `.repeat(350);
			return [
				{ role: "toolResult", toolCallId: `first-${index}`, content: [{ type: "text", text }] },
				{ role: "toolResult", toolCallId: `duplicate-${index}`, content: [{ type: "text", text }] },
			];
		}).flat();
		const firstOutput = await runtime.fire("context", { messages: firstMessages });
		const firstView = (firstOutput[0] as { messages: Array<{ content: unknown }> }).messages;
		const firstText = (firstMessages[0] as { content: Array<{ text: string }> }).content[0]!.text;
		const reference = (firstView[1]?.content as Array<{ text: string }>)[0]?.text ?? "";
		const handle = reference.match(/same-as=(htr:[A-Za-z0-9_-]{43})/)?.[1];
		assert.ok(handle, "first admitted duplicate should receive a recovery handle");

		const overflowText = "ordinary result number 129 ".repeat(350);
		const overflowPair = [
			{ role: "toolResult", toolCallId: "overflow-first", content: [{ type: "text", text: overflowText }] },
			{ role: "toolResult", toolCallId: "overflow-duplicate", content: [{ type: "text", text: overflowText }] },
		];
		const repeatedOutput = await runtime.fire("context", { messages: [...firstView, ...overflowPair] });
		assert.deepEqual(repeatedOutput, [undefined], "a 129th artifact must remain literal at the session cap");

		const recovered = await executeTool(runtime, "retrieve_output", { id: handle });
		assert.equal((recovered as { content: Array<{ text: string }> }).content[0]?.text, firstText);
	} finally {
		runtime.dispose();
	}
});

test("nested Pi codemode tool results remain exact and do not accrue output savings", async () => {
	const runtime = createRuntime({
		config: {
			outputMode: "smart",
			outputMaxLines: 1,
			outputMaxBytes: 128,
			outputMinSavingsBytes: 1,
			outputMinSavingsRatio: 0,
		},
	});
	try {
		await beforePrompt(runtime, "Inspect the JSON data without changing its structure.");
		const text = JSON.stringify(Array.from({ length: 1_000 }, (_, id) => ({ id, value: "ordinary payload ".repeat(6) })));
		const statusBefore = runtime.statuses.at(-1);
		const results = await runtime.fire("tool_result", {
			toolName: "read",
			toolCallId: "nested-read-call",
			parentToolCallId: "codemode-parent-call",
			input: { path: "payload.json" },
			content: [{ type: "text", text }],
			details: {},
			isError: false,
		});
		assert.deepEqual(results, [undefined], "nested programmatic result must not be rewritten");
		assert.equal(runtime.statuses.at(-1), statusBefore, "nested output must not increase reported savings");
	} finally {
		runtime.dispose();
	}
});

test("native custom wake keeps human intent and fails open without routing from custom content", async () => {
	const runtime = createRuntime({
		config: {
			toolPrefetchMax: 1,
			outputMode: "extract",
			outputModel: "test/extract",
			outputExtractMinBytes: 1,
			outputMaxLines: 1,
			outputMaxBytes: 1,
			outputMinSavingsBytes: 1,
			outputMinSavingsRatio: 0,
		},
		initialTools: [
			{ name: "read", description: "Read a file." },
			{ name: "database_query", description: "Query PostgreSQL database migrations and rollback state." },
			{ name: "browser_accessibility", description: "Run Playwright browser accessibility tests." },
		],
		initialActive: ["read", "database_query", "browser_accessibility"],
	});
	const extractionRequests: string[] = [];
	Object.assign(runtime.ctx, {
		modelRegistry: {
			find: () => ({}),
			async complete(_model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }) {
				extractionRequests.push(request.messages[0]?.content[0]?.text ?? "");
				return { content: [{ type: "text", text: "" }], usage: {} };
			},
		},
	});
	try {
		await beforePrompt(runtime, "Review the PostgreSQL migration rollback.");
		assert.ok(runtime.activeTools.has("database_query"));
		assert.ok(!runtime.activeTools.has("browser_accessibility"));

		await runtime.fire("before_agent_start", {
			messageType: "custom",
			prompt: "Run Playwright browser accessibility tests.",
			message: {
				role: "custom",
				customType: "optimizer-wake",
				content: [{ type: "text", text: "Run Playwright browser accessibility tests." }],
			},
			systemPromptOptions: { skills: [] },
		});
		assert.ok(!runtime.notifications.some((text) => text.includes("AUTO prefetch failed open")));
		assert.ok(runtime.activeTools.has("read"));
		assert.ok(runtime.activeTools.has("database_query"));
		assert.ok(runtime.activeTools.has("browser_accessibility"), "missing human input should fail open, not select from custom content");
		assert.ok(runtime.activeTools.has("optimizer_tool_search"));

		await runtime.fire("tool_result", {
			toolName: "read",
			toolCallId: "read-call",
			input: { command: "npm run check" },
			content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `output row ${index}`).join("\n") }],
			details: {},
			isError: false,
		});
		assert.equal(extractionRequests.length, 1);
		assert.match(extractionRequests[0] ?? "", /REQUEST:\nReview the PostgreSQL migration rollback\./);
		assert.doesNotMatch(extractionRequests[0] ?? "", /Run Playwright browser accessibility tests/);
	} finally {
		runtime.dispose();
	}
});

test("inactive deferred tools stay deferred until search and remain active afterward", async () => {
	const runtime = createRuntime({
		config: { toolPrefetchMax: 1 },
		initialTools: [
			{ name: "read", description: "Read files.", exposure: "direct" },
			{ name: "tool_search", description: "Pi built-in tool search." },
			{ name: "mcp__issues__find", description: "Find issue tracker tickets.", exposure: "deferred" },
			{ name: "mcp__issues__update", description: "Update issue tracker tickets.", exposure: "codemode" },
			{ name: "host_disabled", description: "Find issue tracker tickets.", exposure: "direct" },
			{ name: "host_hidden", description: "Find issue tracker tickets.", exposure: "hidden" },
		],
		initialActive: ["read"],
	});
	try {
		await beforePrompt(runtime, "");
		assert.deepEqual([...runtime.activeTools].sort(), ["read", "retrieve_output", "skill_search", "optimizer_tool_search"].sort());
		assert.ok(!runtime.activeTools.has("tool_search"), "initially inactive Pi builtin tool_search was activated");
		await assert.rejects(executeTool(runtime, "optimizer_tool_search", { query: "   " }), /query must not be empty/);
		const unrelated = await executeTool(runtime, "optimizer_tool_search", { query: "meteorological forecast" });
		const unrelatedPage = JSON.parse((unrelated as { content: Array<{ text: string }> }).content[0].text) as {
			activated: string[];
		};
		assert.deepEqual(unrelatedPage.activated, [], "fallback results must not activate unrelated deferred tools");
		assert.ok(!runtime.activeTools.has("mcp__issues__find"));
		assert.ok(!runtime.activeTools.has("mcp__issues__update"));

		const first = await executeTool(runtime, "optimizer_tool_search", { query: "issue tracker tickets", pageSize: 1 });
		const firstPage = JSON.parse((first as { content: Array<{ text: string }> }).content[0].text) as {
			results: Array<{ name: string }>;
			activated: string[];
			nextCursor?: string;
		};
		assert.equal(firstPage.results.length, 1);
		assert.deepEqual(firstPage.activated, [firstPage.results[0].name]);
		assert.ok(firstPage.nextCursor);
		assert.ok(!runtime.activeTools.has("host_disabled"));
		assert.ok(!runtime.activeTools.has("host_hidden"));

		const second = await executeTool(runtime, "optimizer_tool_search", {
			query: "issue tracker tickets", cursor: firstPage.nextCursor, pageSize: 1,
		});
		const secondPage = JSON.parse((second as { content: Array<{ text: string }> }).content[0].text) as {
			results: Array<{ name: string }>;
			activated: string[];
		};
		assert.equal(secondPage.results.length, 1);
		assert.notEqual(secondPage.results[0].name, firstPage.results[0].name);
		assert.deepEqual(secondPage.activated, [secondPage.results[0].name]);
		for (const name of ["mcp__issues__find", "mcp__issues__update"]) {
			assert.ok(runtime.activeTools.has(name), `${name} was not activated by optimizer_tool_search`);
		}

		await beforePrompt(runtime, "Review the issue tracker tickets.");
		for (const name of ["mcp__issues__find", "mcp__issues__update"]) {
			assert.ok(runtime.activeTools.has(name), `${name} was not retained after replanning`);
		}
		assert.ok(!runtime.activeTools.has("host_disabled"));
		assert.ok(!runtime.activeTools.has("host_hidden"));
		runtime.setHostToolExposure("mcp__issues__find", "hidden");
		await assert.rejects(executeTool(runtime, "optimizer_tool_search", {
			query: "issue tracker tickets", cursor: firstPage.nextCursor, pageSize: 1,
		}), /Invalid tool discovery cursor/);
		await beforePrompt(runtime, "Find issue tracker tickets.");
		assert.ok(!runtime.activeTools.has("mcp__issues__find"), "withdrawn tool was reactivated");
		const afterWithdrawal = await executeTool(runtime, "optimizer_tool_search", { query: "issue tracker tickets" });
		const afterWithdrawalPage = JSON.parse((afterWithdrawal as { content: Array<{ text: string }> }).content[0].text) as {
			results: Array<{ name: string }>;
		};
		assert.ok(!afterWithdrawalPage.results.some((tool) => tool.name === "mcp__issues__find"));
	} finally {
		runtime.dispose();
	}
});

test("configured alwaysTools activates inactive searchable tools within host selection", async () => {
	const runtime = createRuntime({
		config: { alwaysTools: ["mcp__issues__find", "mcp__issues__update", "host_disabled", "host_hidden"] },
		initialTools: [
			{ name: "read", description: "Read files.", exposure: "direct" },
			{ name: "mcp__issues__find", description: "Find issue tracker tickets.", exposure: "deferred" },
			{ name: "mcp__issues__update", description: "Update issue tracker tickets.", exposure: "codemode" },
			{ name: "host_disabled", description: "Host-disabled direct tool.", exposure: "direct" },
			{ name: "host_hidden", description: "Find private issue tracker tickets.", exposure: "hidden" },
		],
		initialActive: ["read"],
	});
	try {
		await beforePrompt(runtime, "Unrelated prompt with no tool match.");
		assert.ok(runtime.activeTools.has("mcp__issues__find"), "configured deferred tool was not activated");
		assert.ok(runtime.activeTools.has("mcp__issues__update"), "configured codemode tool was not activated");
		assert.ok(!runtime.activeTools.has("host_disabled"), "configured inactive direct tool must respect host selection");
		assert.ok(!runtime.activeTools.has("host_hidden"), "configured hidden tool must remain excluded");
	} finally {
		runtime.dispose();
	}
});

test("late active direct tools enter the next catalog and remain active", async () => {
	const runtime = createRuntime({
		config: { toolPrefetchMax: 1 },
		initialTools: [
			{ name: "read", description: "Read files.", exposure: "direct" },
			{ name: "database_query", description: "Query PostgreSQL database migrations.", exposure: "direct" },
		],
		initialActive: ["read", "database_query"],
	});
	try {
		await beforePrompt(runtime, "Review PostgreSQL database migrations.");
		runtime.addHostTool({
			name: "late_direct_report",
			description: "Generate a report from the newly connected service.",
			exposure: "direct",
		});

		await beforePrompt(runtime, "Review PostgreSQL database migrations.");
		assert.ok(runtime.activeTools.has("late_direct_report"), "late active direct tool was removed on replanning");

		const result = await executeTool(runtime, "optimizer_tool_search", { query: "newly connected service report" });
		const page = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as {
			results: Array<{ name: string }>;
		};
		assert.ok(page.results.some((tool) => tool.name === "late_direct_report"), "late tool was missing from the search catalog");
	} finally {
		runtime.dispose();
	}
});

test("tools activated by Pi's built-in search survive later optimizer replanning", async () => {
	const runtime = createRuntime({
		config: { toolPrefetchMax: 1 },
		initialTools: [
			{ name: "read", description: "Read files.", exposure: "direct" },
			{ name: "database_query", description: "Query PostgreSQL database migrations.", exposure: "direct" },
			{ name: "mcp__issues__find", description: "Find issue tracker tickets.", exposure: "deferred" },
		],
		initialActive: ["read", "database_query"],
	});
	try {
		await beforePrompt(runtime, "Review PostgreSQL database migrations.");
		assert.ok(!runtime.activeTools.has("mcp__issues__find"));
		runtime.activeTools.add("mcp__issues__find");
		await beforePrompt(runtime, "Review PostgreSQL database migrations.");
		assert.ok(runtime.activeTools.has("mcp__issues__find"), "Pi-activated tool was discarded by optimizer replanning");
	} finally {
		runtime.dispose();
	}
});

test("tool configuration refreshes per human turn and disable restores only the original allowed set", async () => {
	const runtime = createRuntime({
		config: { toolPrefetchMax: 1, alwaysTools: [] },
		initialTools: [
			{ name: "read", description: "Read a file." },
			{ name: "database_query", description: "Query PostgreSQL database migrations." },
			{ name: "browser_accessibility", description: "Run Playwright browser accessibility tests." },
			{ name: "admin_console", description: "Manage administrator accounts and permissions." },
		],
		initialActive: ["read", "database_query", "browser_accessibility"],
	});
	try {
		await beforePrompt(runtime, "Review the PostgreSQL migration.");
		assert.ok(!runtime.activeTools.has("browser_accessibility"));

		runtime.writeConfig({ toolPrefetchMax: 1, alwaysTools: ["browser_accessibility"] });
		await beforePrompt(runtime, "Review the PostgreSQL migration.");
		assert.ok(runtime.activeTools.has("browser_accessibility"));

		runtime.writeConfig({ toolPrefetchMax: 1, alwaysTools: [] });
		await beforePrompt(runtime, "Review the PostgreSQL migration.");
		assert.ok(!runtime.activeTools.has("browser_accessibility"));

		process.env.PI_SKILL_OPTIMIZER_DISABLE = "true";
		await beforePrompt(runtime, "Do not change the active tool policy.");
		assert.ok(runtime.activeTools.has("read"));
		assert.ok(runtime.activeTools.has("database_query"));
		assert.ok(runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("admin_console"));
	} finally {
		runtime.dispose();
	}
});

test("skill search hides configured exclusions while exact explicit loading still works", async () => {
	const runtime = createRuntime({ config: { excludeSkills: ["hidden-skill"] } });
	try {
		const hiddenDir = join(runtime.root, "skills", "hidden-skill");
		mkdirSync(hiddenDir, { recursive: true });
		const hiddenPath = join(hiddenDir, "SKILL.md");
		writeFileSync(hiddenPath, "Exact hidden skill instructions.", "utf8");
		const skills = [
			{
				name: "hidden-skill",
				description: "Use when handling secret credential recovery requests.",
				filePath: hiddenPath,
				baseDir: hiddenDir,
				disableModelInvocation: false,
			},
			{
				name: "visible-skill",
				description: "Use when reviewing public API compatibility and versioning.",
				filePath: hiddenPath,
				baseDir: hiddenDir,
				disableModelInvocation: false,
			},
		] as unknown as Skill[];
		await runtime.fire("before_agent_start", {
			prompt: "Find secret credential recovery guidance.",
			systemPromptOptions: { skills },
		});

		const search = await executeTool(runtime, "skill_search", {
			action: "search",
			query: "secret credential recovery",
		});
		const searchText = (search as { content: Array<{ text: string }> }).content[0].text;
		assert.ok(!searchText.includes("hidden-skill"));

		const loaded = await executeTool(runtime, "skill_search", {
			action: "load",
			name: "hidden-skill",
		});
		assert.equal((loaded as { content: Array<{ text: string }> }).content[0].text, "Exact hidden skill instructions.");
	} finally {
		runtime.dispose();
	}
});

test("all runtime tool errors throw and protected tool results remain verbatim", async () => {
	const runtime = createRuntime({
		initialTools: [
			{ name: "read", description: "Read a file." },
			{ name: "database_query", description: "Query PostgreSQL database migrations." },
		],
		initialActive: ["read", "database_query"],
	});
	try {
		await beforePrompt(runtime, "Review the PostgreSQL migration.");
		await assert.rejects(
			executeTool(runtime, "skill_search", { action: "load", name: "missing-skill" }),
			/Unknown skill name: missing-skill/,
		);
		await assert.rejects(
			executeTool(runtime, "optimizer_tool_search", { query: "PostgreSQL", cursor: "invalid" }),
			/Invalid tool discovery cursor/,
		);
		await assert.rejects(
			executeTool(runtime, "retrieve_output", { id: "sko:invalid" }),
			/Unknown or expired output handle/,
		);

		const largeOutput = Array.from({ length: 900 }, (_, index) => `ordinary output row ${index}`).join("\n");
		for (const toolName of ["skill_search", "optimizer_tool_search", "tool_search", "retrieve_output"]) {
			const results = await runtime.fire("tool_result", {
				toolName,
				toolCallId: `${toolName}-call`,
				input: {},
				content: [{ type: "text", text: largeOutput }],
				details: {},
				isError: false,
			});
			assert.equal(results[0], undefined, `${toolName} result was rewritten`);
		}
	} finally {
		runtime.dispose();
	}
});

test("init notice is informational, UI-only, and emitted once per readiness state", async () => {
	const skill = modelSkill();
	const runtime = createRuntime({ skills: [skill] });
	try {
		const event = { prompt: "Review the TypeScript change.", systemPromptOptions: { skills: [skill] } };
		assert.deepEqual(await runtime.fire("before_agent_start", event), [undefined]);
		assert.deepEqual(await runtime.fire("before_agent_start", event), [undefined]);
		assert.deepEqual(runtime.notifications.filter((message) => message === INIT_NOTICE), [INIT_NOTICE]);
		assert.equal(runtime.entries.length, 1);
		assert.equal(runtime.entries[0]?.customType, "skill-optimizer-init-readiness");
		assert.deepEqual(Object.keys(runtime.entries[0]?.data as object).sort(), ["key", "schema"]);
	} finally {
		runtime.dispose();
	}
});

test("init notice is suppressed without UI, with no skills, when disabled, and for provider mismatch", async () => {
	const cases: Array<{ options: RuntimeOptions; disabled?: boolean }> = [
		{ options: { skills: [modelSkill()], hasUI: false } },
		{ options: {} },
		{ options: { skills: [modelSkill()] }, disabled: true },
		{ options: { config: { providers: ["allowed"] }, skills: [modelSkill()] } },
	];
	for (const item of cases) {
		const runtime = createRuntime(item.options);
		try {
			if (item.disabled) process.env.PI_SKILL_OPTIMIZER_DISABLE = "true";
			await runtime.fire("before_agent_start", {
				prompt: "Review the TypeScript change.", systemPromptOptions: { skills: item.options.skills ?? [] },
			});
			assert.ok(!runtime.notifications.includes(INIT_NOTICE));
			assert.equal(runtime.entries.length, 0);
		} finally {
			runtime.dispose();
		}
	}
});

test("init notice suppression survives extension reload and session resume", async () => {
	const skill = modelSkill();
	const runtime = createRuntime({ skills: [skill] });
	const event = { prompt: "Review TypeScript.", systemPromptOptions: { skills: [skill] } };
	try {
		await runtime.fire("before_agent_start", event);
		runtime.reload();
		await runtime.fire("session_start", {});
		await runtime.fire("before_agent_start", event);
		assert.equal(runtime.notifications.filter((message) => message === INIT_NOTICE).length, 1);
		assert.equal(runtime.entries.length, 1);
	} finally {
		runtime.dispose();
	}
});

test("manual and current profiles do not nag; old and partial generated profiles do", async () => {
	const skill = modelSkill();
	const cases = [
		{ profile: { critical: [skill.name] }, expected: "manual profile", notice: false },
		{ profile: { initVersion: INIT_PROFILE_VERSION, skillHashes: { [skill.name]: hashSkill(skill.name, skill.description) }, catalog: { version: 1, cards: { [skill.name]: { summary: "Review TypeScript changes.", tags: ["review"], sourceHash: hashSkill(skill.name, skill.description) } } } }, expected: "current", notice: false },
		{ profile: { initVersion: INIT_PROFILE_VERSION - 1, skillHashes: {} }, expected: "generated profile is outdated", notice: true },
		{ profile: { initVersion: INIT_PROFILE_VERSION, skillHashes: {} }, expected: "generated profile is incomplete", notice: true },
	];
	for (const item of cases) {
		const runtime = createRuntime({ skills: [skill] });
		try {
			writeFileSync(getProfilePaths(runtime.cwd).global, JSON.stringify(item.profile));
			await runtime.fire("before_agent_start", { prompt: "Review TypeScript.", systemPromptOptions: { skills: [skill] } });
			assert.equal(runtime.notifications.includes(INIT_NOTICE), item.notice);
			await runtime.command();
			assert.ok(runtime.notifications.at(-1)?.includes(`init readiness: ${item.expected}`));
		} finally {
			runtime.dispose();
		}
	}
});

test("unreadable profiles are reported as unavailable, not as missing init", async () => {
	const skill = modelSkill();
	const runtime = createRuntime({ skills: [skill] });
	try {
		writeFileSync(getProfilePaths(runtime.cwd).global, "{invalid JSON");
		await runtime.fire("before_agent_start", { prompt: "Review TypeScript.", systemPromptOptions: { skills: [skill] } });
		assert.ok(!runtime.notifications.includes(INIT_NOTICE));
		await runtime.command();
		assert.ok(runtime.notifications.at(-1)?.includes("init readiness: unavailable"));
	} finally {
		runtime.dispose();
	}
});

test("status refresh preserves pending skill usage when the usage flush is temporarily blocked", async () => {
	const skill = modelSkill();
	const runtime = createRuntime({ skills: [skill] });
	try {
		skill.filePath = join(runtime.root, "SKILL.md");
		skill.baseDir = runtime.root;
		writeFileSync(skill.filePath, "# TypeScript guidance");
		await runtime.fire("before_agent_start", { prompt: "Review TypeScript.", systemPromptOptions: { skills: [skill] } });
		await executeTool(runtime, "skill_search", { action: "load", name: skill.name });
		writeFileSync(`${getUsageFilePath(runtime.cwd)}.lock`, `${process.pid}:${Date.now()}:testlock`);
		await runtime.command();
		assert.ok(runtime.notifications.some((text) => text.includes("usage flush failed")));
		assert.ok(runtime.notifications.at(-1)?.includes("usage prior:    typescript"), "pending usage must survive the profile refresh");
	} finally {
		runtime.dispose();
	}
});

test("status command reports clear init readiness without changing the model prompt", async () => {
	const skill = modelSkill();
	const runtime = createRuntime({ skills: [skill] });
	try {
		const result = await runtime.fire("before_agent_start", {
			prompt: "Explain this function.",
			systemPromptOptions: { skills: [skill] },
		});
		assert.deepEqual(result, [undefined]);
		await runtime.command();
		assert.ok(runtime.notifications.at(-1)?.includes("init readiness: not initialized"));
	} finally {
		runtime.dispose();
	}
});

test("tag browsing exposes method skills, exact loads and stale unclassified cards through the real tool", async () => {
	const skill = modelSkill();
	const stale = { ...skill, name: "stale-guidance", description: "The source description has changed." };
	const runtime = createRuntime({ skills: [skill, stale] });
	try {
		skill.filePath = join(runtime.root, "SKILL.md");
		skill.baseDir = runtime.root;
		writeFileSync(skill.filePath, "# Exact instructions\r\nUse trustworthy assertions.\r\n");
		writeFileSync(getProfilePaths(runtime.cwd).global, JSON.stringify({
			critical: [], queries: {}, clusters: {}, negativeHints: {}, catalog: {
				version: 1, cards: {
					[skill.name]: { summary: "Design independent modules before implementing changes.", tags: ["architecture"], sourceHash: hashSkill(skill.name, skill.description) },
					[stale.name]: { summary: "Outdated generated guidance.", tags: ["architecture"], sourceHash: hashSkill(stale.name, "old description") },
				},
			},
		}));
		await runtime.fire("before_agent_start", { prompt: "Separiamo dominio e storage", systemPromptOptions: { skills: [skill, stale] } });
		const searched = await executeTool(runtime, "skill_search", { action: "search", tags: ["architecture"] }) as { content: Array<{ text: string }> };
		const page = JSON.parse(searched.content[0].text);
		assert.deepEqual(page.items.map((item: { name: string }) => item.name), [skill.name]);
		for (const query of ["نراجع حدود النظام", "設計を見直してください"]) {
			const multilingual = await executeTool(runtime, "skill_search", { action: "search", tags: ["architecture"], query }) as { content: Array<{ text: string }> };
			assert.deepEqual(JSON.parse(multilingual.content[0].text).items.map((item: { name: string }) => item.name), [skill.name], "query may order but must not veto an explicitly selected semantic tag");
			const noTags = await executeTool(runtime, "skill_search", { action: "search", query }) as { content: Array<{ text: string }> };
			assert.deepEqual(JSON.parse(noTags.content[0].text).items, [], "query-only search still abstains without lexical signal");
		}
		const unclassified = await executeTool(runtime, "skill_search", { action: "search", tags: ["unclassified"] }) as { content: Array<{ text: string }> };
		assert.deepEqual(JSON.parse(unclassified.content[0].text).items.map((item: { name: string }) => item.name), [stale.name]);
		const loaded = await executeTool(runtime, "skill_search", { action: "load", name: skill.name }) as { content: Array<{ text: string }> };
		assert.equal(loaded.content[0].text, "# Exact instructions\r\nUse trustworthy assertions.\r\n");
		await assert.rejects(executeTool(runtime, "skill_search", { action: "search", tags: ["invented-tag"] }), /unknown.*tag/i);
	} finally { runtime.dispose(); }
});

test("a failed registry rebuild after session reset keeps native discovery instead of stale resolver metadata", async () => {
	const skill = { ...modelSkill(), description: "Review independently testable application boundaries. ".repeat(100) };
	const runtime = createRuntime({ skills: [skill] });
	try {
		writeFileSync(getProfilePaths(runtime.cwd).global, JSON.stringify({ catalog: { version: 1, cards: {
			[skill.name]: { summary: "Review independently testable application boundaries.", tags: ["architecture"], sourceHash: hashSkill(skill.name, skill.description) },
		} } }));
		await runtime.fire("before_agent_start", { prompt: "Review", systemPromptOptions: { skills: [skill] } });
		await runtime.fire("session_start", {});
		await runtime.fire("before_agent_start", { prompt: "Review", systemPromptOptions: { skills: [{ ...skill, name: " " }] } });
		const messages = [{ role: "system", sections: { skills: `<available_skills><skill><name>${skill.name}</name><description>${skill.description}</description><location>${skill.filePath}</location></skill></available_skills>` } }];
		assert.deepEqual(await runtime.fire("context_with_system", { messages }), [undefined]);
		assert.ok(runtime.notifications.some((message) => message.includes("failed open")));
	} finally { runtime.dispose(); }
});

function nativeCatalogBlock(skill: Skill): string {
	return `<available_skills><skill><name>${skill.name}</name><description>${skill.description}</description><location>${skill.filePath ?? ""}</location></skill></available_skills>`;
}

function writeTagCatalogProfile(runtime: ReturnType<typeof createRuntime>, skill: Skill): void {
	writeFileSync(getProfilePaths(runtime.cwd).global, JSON.stringify({ catalog: { version: 1, cards: {
		[skill.name]: { summary: "Review independently testable application boundaries.", tags: ["architecture"], sourceHash: hashSkill(skill.name, skill.description) },
	} } }));
}

function lastStatus(runtime: ReturnType<typeof createRuntime>): string {
	return runtime.notifications.at(-1) ?? "";
}

test("status reports the catalog substitution that actually reached the latest request", async () => {
	const skill = { ...modelSkill(), description: "Review independently testable application boundaries. ".repeat(100) };
	const runtime = createRuntime({ skills: [skill] });
	try {
		writeTagCatalogProfile(runtime, skill);
		await runtime.fire("before_agent_start", { prompt: "Review", systemPromptOptions: { skills: [skill] } });
		const messages = [{ role: "system", sections: { skills: nativeCatalogBlock(skill) } }];
		const outcome = await runtime.fire("context_with_system", { messages });
		assert.notDeepEqual(outcome, [undefined], "the tag directory must actually replace the native block");
		await runtime.command();
		assert.ok(lastStatus(runtime).includes("last catalog:   replaced"), lastStatus(runtime));
		assert.ok(runtime.statuses.at(-1)?.includes("catalog replaced"), String(runtime.statuses.at(-1)));
	} finally { runtime.dispose(); }
});

test("status reports the guard reason when the native catalog is kept", async () => {
	const skill = { ...modelSkill(), description: "Review TypeScript." };
	const runtime = createRuntime({ skills: [skill] });
	try {
		writeTagCatalogProfile(runtime, skill);
		await runtime.fire("before_agent_start", { prompt: "Review TypeScript.", systemPromptOptions: { skills: [skill] } });
		const messages = [{ role: "system", sections: { skills: nativeCatalogBlock(skill) } }];
		assert.deepEqual(await runtime.fire("context_with_system", { messages }), [undefined], "a directory larger than the native block must not be used");
		await runtime.command();
		assert.ok(lastStatus(runtime).includes("last catalog:   native kept (not-smaller)"), lastStatus(runtime));
		assert.ok(runtime.statuses.at(-1)?.includes("catalog native (not-smaller)"), String(runtime.statuses.at(-1)));
	} finally { runtime.dispose(); }
});

test("the payload pass upgrades a native section pass to replaced when a forced prompt discarded the rewrite", async () => {
	const skill = { ...modelSkill(), description: "Review independently testable application boundaries. ".repeat(100) };
	const runtime = createRuntime({ skills: [skill] });
	try {
		writeTagCatalogProfile(runtime, skill);
		await runtime.fire("before_agent_start", { prompt: "Review", systemPromptOptions: { skills: [skill] } });
		await runtime.fire("context_with_system", { messages: [{ role: "user", content: "Review the change." }] });
		await runtime.command();
		assert.ok(lastStatus(runtime).includes("last catalog:   native kept (no-native-catalog)"), lastStatus(runtime));
		const payload = { system: nativeCatalogBlock(skill), messages: [{ role: "user", content: "Review the change." }] };
		const results = await runtime.fire("before_provider_request", { payload }) as Array<{ system?: string } | undefined>;
		// The substitution artifact depends on catalog size (one skill keeps the all-name index),
		// so the identity marker proves the rewrite; native XML entries never carry it.
		assert.ok(results[0]?.system?.includes("skill-optimizer:auto:v2"), "the payload pass must re-apply the substitution");
		assert.ok(runtime.statuses.at(-1)?.includes("catalog replaced"), String(runtime.statuses.at(-1)));
		await runtime.command();
		assert.ok(lastStatus(runtime).includes("last catalog:   replaced"), lastStatus(runtime));
	} finally { runtime.dispose(); }
});

function nativeCatalogBlocks(skills: readonly Skill[]): string {
	return `<available_skills>${skills.map((skill) =>
		`<skill><name>${skill.name}</name><description>${skill.description}</description><location>${(skill as { filePath?: string }).filePath ?? ""}</location></skill>`
	).join("")}</available_skills>`;
}

function skillSection(results: unknown[]): string {
	const first = results[0] as { messages?: Array<{ sections?: Record<string, string> }> } | undefined;
	return first?.messages?.[0]?.sections?.skills ?? "";
}

test("init notice quantifies the index a large catalog would replace", async () => {
	const skills = Array.from({ length: 96 }, (_, index) =>
		modelSkill(`init-notice-large-catalog-skill-name-${String(index).padStart(2, "0")}`));
	const floorEstimate = 170 + skills.reduce((sum, skill) => sum + skill.name.length + 1, 0);
	assert.ok(floorEstimate > 3_500, "premise: this catalog's all-name floor exceeds the quantified threshold");
	const runtime = createRuntime({ skills });
	try {
		const event = { prompt: "Review TypeScript.", systemPromptOptions: { skills } };
		await runtime.fire("before_agent_start", event);
		await runtime.fire("before_agent_start", event);
		const notices = runtime.notifications.filter((message) => message.includes("/skill-optimizer init"));
		assert.equal(notices.length, 1, "the quantified nudge keeps one notice per readiness state");
		assert.match(notices[0] ?? "", /the 96-name skill index is at least ~\d+ chars in every request/);
		assert.match(notices[0] ?? "", /~3k-char tag directory/);
		assert.match(notices[0] ?? "", /one-time model cost/);
		assert.ok(!notices.includes(INIT_NOTICE), "a large catalog does not get the unquantified text");
		assert.equal(runtime.entries.length, 1, "notice key and session dedupe are unchanged");
	} finally { runtime.dispose(); }
});

test("recently loaded hints are session-frozen and never outrank the directory", async () => {
	const names = Array.from({ length: 12 }, (_, index) => `catalog-skill-with-a-descriptive-and-distinct-name-${index}`);
	const skills = names.map((name) => ({
		...modelSkill(name),
		description: "Review independently testable application boundaries and reliable regression tests.",
	})) as Skill[];
	const runtime = createRuntime({ skills });
	try {
		for (const skill of skills) {
			const baseDir = join(runtime.root, "skills", skill.name);
			mkdirSync(baseDir, { recursive: true });
			(skill as { filePath?: string }).filePath = join(baseDir, "SKILL.md");
			(skill as { baseDir?: string }).baseDir = baseDir;
			writeFileSync(join(baseDir, "SKILL.md"), `# ${skill.name}\n`, "utf8");
		}
		writeFileSync(getProfilePaths(runtime.cwd).global, JSON.stringify({ catalog: { version: 1, cards: Object.fromEntries(skills.map((skill) => [skill.name, {
			summary: skill.description,
			tags: ["architecture"],
			sourceHash: hashSkill(skill.name, skill.description),
		}])) } }));
		const usagePath = getUsageFilePath(runtime.cwd);
		const usage = { version: 1, updatedAt: new Date().toISOString(), skills: {
			[names[0]]: { count: 5, lastUsed: Date.now() },
			[names[1]]: { count: 3, lastUsed: Date.now() },
		} };
		writeFileSync(usagePath, JSON.stringify(usage));
		const block = nativeCatalogBlocks(skills);
		const messages = (): Array<{ role: string; sections: Record<string, string> }> => [{ role: "system", sections: { skills: block } }];

		await runtime.fire("before_agent_start", { prompt: "Review the change.", systemPromptOptions: { skills } });
		const first = skillSection(await runtime.fire("context_with_system", { messages: messages() }));
		assert.match(first, /skill_directory/, "the large-catalog directory must still be used");
		const hint = first.match(/\nRecently loaded here[^\n]*/)?.[0] ?? "";
		assert.ok(hint.includes("(usage metadata, not a recommendation)"), "catalog mode appends the frozen usage hint");
		assert.ok(hint.includes(`"${names[0]}"`) && hint.includes(`"${names[1]}"`), hint);
		assert.ok(!first.includes(names[4]), "an unloaded name is not a usage hint");

		await executeTool(runtime, "skill_search", { action: "load", name: names[4] });
		const second = skillSection(await runtime.fire("context_with_system", { messages: messages() }));
		assert.equal(second, first, "an in-session load cannot rewrite the stable base");

		const persisted = JSON.parse(readFileSync(usagePath, "utf8")) as typeof usage;
		persisted.skills[names[4]] = { count: 20, lastUsed: Date.now() };
		writeFileSync(usagePath, JSON.stringify(persisted));
		await runtime.fire("session_start", {});
		await runtime.fire("before_agent_start", { prompt: "Review the change.", systemPromptOptions: { skills } });
		const third = skillSection(await runtime.fire("context_with_system", { messages: messages() }));
		assert.notEqual(third, first, "a new session captures its own frozen hints");
		assert.ok(third.includes(`"${names[4]}"`), "the new session's capture follows current usage evidence");
		assert.equal(third.replace(/\nRecently loaded here[^\n]*/, ""), first.replace(/\nRecently loaded here[^\n]*/, ""),
			"only the hint line differs: the directory bytes are unchanged");
	} finally { runtime.dispose(); }
});
