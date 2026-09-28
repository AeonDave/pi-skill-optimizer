import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
	initialTools?: Array<{ name: string; description: string }>;
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
		ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
	} as unknown as ExtensionContext;

	return {
		root,
		cwd,
		ctx,
		tools,
		activeTools,
		notifications,
		entries,
		writeConfig,
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
			{ name: "database_query", description: "Query PostgreSQL database migrations and rollback state." },
			{ name: "browser_accessibility", description: "Run Playwright browser accessibility tests." },
			{ name: "admin_console", description: "Manage administrator accounts and permissions." },
		],
		initialActive: ["read", "database_query", "browser_accessibility"],
	});
	try {
		await beforePrompt(runtime, "Review the PostgreSQL migration rollback.");
		assert.ok(runtime.activeTools.has("database_query"));
		assert.ok(!runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("admin_console"));

		await beforePrompt(runtime, "Run Playwright browser accessibility tests.");
		assert.ok(runtime.activeTools.has("browser_accessibility"));
		assert.ok(!runtime.activeTools.has("database_query"));
		assert.ok(!runtime.activeTools.has("admin_console"));

		const search = await executeTool(runtime, "tool_search", { query: "PostgreSQL migration rollback" });
		const searchText = (search as { content: Array<{ text: string }> }).content[0].text;
		const searchNames = (JSON.parse(searchText) as { results: Array<{ name: string }> }).results.map((tool) => tool.name);
		assert.ok(!searchNames.includes("admin_console"));

		await beforePrompt(runtime, "Review the PostgreSQL migration rollback.");
		assert.ok(runtime.activeTools.has("database_query"));
		for (const name of searchNames) assert.ok(runtime.activeTools.has(name), `${name} was stranded after tool_search`);
		assert.ok(!runtime.activeTools.has("admin_console"));
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
			executeTool(runtime, "tool_search", { query: "PostgreSQL", cursor: "invalid" }),
			/Invalid tool discovery cursor/,
		);
		await assert.rejects(
			executeTool(runtime, "retrieve_output", { id: "sko:invalid" }),
			/Unknown or expired output handle/,
		);

		const largeOutput = Array.from({ length: 900 }, (_, index) => `ordinary output row ${index}`).join("\n");
		for (const toolName of ["skill_search", "tool_search", "retrieve_output"]) {
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
		{ profile: { initVersion: INIT_PROFILE_VERSION, skillHashes: { [skill.name]: hashSkill(skill.name, skill.description) } }, expected: "current", notice: false },
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
