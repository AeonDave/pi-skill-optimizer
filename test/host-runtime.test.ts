import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createToolSearchExtension, DefaultResourceLoader, ExtensionRunner, discoverAndLoadExtensions, SessionManager, wrapRegisteredTools,
	type ExtensionActions, type ModelRegistry, type Skill,
} from "@earendil-works/pi-coding-agent";

test("Pi 1.0 loader keeps built-in tool_search alongside optimizer_tool_search", async () => {
	const packagedRoot = process.env.PI_SKILL_OPTIMIZER_TEST_PACKAGE;
	const packageRoot = packagedRoot ? resolve(packagedRoot) : resolve(fileURLToPath(new URL("..", import.meta.url)));
	const root = mkdtempSync(join(tmpdir(), "sko-pi-1-loader-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }), "utf8");
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			extensionFactories: [{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true }],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		assert.deepEqual(result.errors, []);
		assert.ok(
			!(result.warnings ?? []).some(({ warning }) => warning.includes("built-in extension `tool-search` was not loaded")),
			(result.warnings ?? []).map(({ warning }) => warning).join("\n"),
		);

		const builtin = result.extensions.find((extension) => extension.path === "builtin:tool-search");
		assert.ok(builtin, "Pi's built-in tool-search extension should stay loaded");
		assert.ok(builtin.tools.has("tool_search"), "Pi's built-in tool_search should be registered");
		const optimizer = result.extensions.find((extension) => extension.tools.has("optimizer_tool_search"));
		assert.ok(optimizer, "the optimizer search tool should remain registered under its distinct name");
		assert.equal(optimizer.tools.has("tool_search"), false, "the optimizer must not replace Pi's built-in tool");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("real Pi loader/runner handles offline status, audit, search and verbatim skill load", async () => {
	// Release probes reuse this test against an unpacked/installed artifact, not checkout source.
	const packagedRoot = process.env.PI_SKILL_OPTIMIZER_TEST_PACKAGE;
	const extensionPath = packagedRoot
		? join(resolve(packagedRoot), "src", "index.ts")
		: fileURLToPath(new URL("../src/index.ts", import.meta.url));
	if (packagedRoot) {
		const pkg = JSON.parse(readFileSync(join(packagedRoot, "package.json"), "utf8"));
		assert.equal(pkg.name, "@aeondave/pi-skill-optimizer");
		assert.equal(existsSync(join(packagedRoot, "node_modules")), false, "artifact must use Pi's host dependencies");
		assert.ok(existsSync(join(packagedRoot, "src", "prompts", "init-profile.md")));
	}
	const root = mkdtempSync(join(tmpdir(), "sko-host-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const optimizerEnvironment = Object.fromEntries(Object.entries(process.env)
		.filter(([key]) => key.startsWith("PI_SKILL_OPTIMIZER_")));
	for (const key of Object.keys(optimizerEnvironment)) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const baseDir = join(root, "skills", "repo guidance 雪");
		mkdirSync(baseDir, { recursive: true });
		const filePath = join(baseDir, "SKILL.md");
		const instructions = "# Repository guidance\r\n" + "Read the relevant module.\r\n".repeat(900)
			+ "Consult the appropriate architecture and behavioral skills when needed.\n";
		writeFileSync(filePath, instructions, "utf8");
		const skills: Skill[] = [{
			name: "repo-guidance", description: "Use when reviewing repository module boundaries.",
			filePath, baseDir, disableModelInvocation: false,
			sourceInfo: { path: filePath, source: "cli", scope: "temporary", origin: "top-level" },
		}];
		const loaded = await discoverAndLoadExtensions([extensionPath], root, join(root, "agent"));
		assert.deepEqual(loaded.errors, [], "extension must load with Pi's real jiti loader");
		assert.equal(loaded.extensions.length, 1);
		const modelRegistry = {
			complete() { throw new Error("Provider calls are forbidden in this smoke test"); },
		} as unknown as ModelRegistry;
		const session = SessionManager.inMemory(root);
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session, modelRegistry);
		const errors: unknown[] = [];
		runner.onError((error) => errors.push(error));
		const registered = runner.getAllRegisteredTools();
		let active = registered.map(({ definition }) => definition.name);
		runner.bindCore({
			getAllTools: () => registered.map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo })),
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => { active = [...names]; },
			getCommands: () => [],
			appendEntry: (customType: string, data: unknown) => { session.appendCustomEntry(customType, data); },
		} as unknown as ExtensionActions, {
			getModel: () => undefined, getScopedModels: () => [], isIdle: () => true,
			isProjectTrusted: () => true, getSignal: () => undefined, abort() {},
			hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
			compact() {}, getSystemPrompt: () => "", getSystemPromptOptions: () => ({ cwd: root, skills }),
		});
		const notices: string[] = [];
		const ui = runner.getUIContext();
		runner.setUIContext({ ...ui, notify: (message) => { notices.push(message); } });
		// No session_start/shutdown: their shared archive cleanup is outside this isolated probe.
		await runner.emitBeforeAgentStart("Review repository module boundaries", undefined, { cwd: root, skills });
		assert.deepEqual(errors, []);
		const setupMessage = "Optional setup: run `/skill-optimizer init` to improve skill matching (may incur model costs).";
		assert.equal(notices.filter((text) => text === setupMessage).length, 1);
		await runner.emitBeforeAgentStart("Review another module", undefined, { cwd: root, skills });
		assert.equal(notices.filter((text) => text === setupMessage).length, 1, "do not repeat setup hints each turn");
		assert.ok(session.getBranch().some((entry) => entry.type === "custom"), "persist notice metadata for reload/resume");
		assert.ok(session.getBranch().every((entry) => entry.type !== "message"), "setup notices must not become model messages");
		const command = runner.getCommand("skill-optimizer");
		assert.ok(command);
		await command.handler("", runner.createCommandContext());
		await command.handler("audit", runner.createCommandContext());
		assert.ok(notices.some((text) => text.includes("skills mode:")));
		assert.ok(notices.some((text) => text.includes("across 1 skills")));

		const tools = wrapRegisteredTools(registered, runner);
		const search = tools.find((tool) => tool.name === "skill_search");
		assert.ok(search);
		const found = await search.execute("find", { action: "search", query: "repository module boundaries" });
		assert.ok(JSON.stringify(found.content).includes("repo-guidance"));
		const full = await search.execute("load", { action: "load", name: "repo-guidance" });
		assert.deepEqual(full.content, [{ type: "text", text: instructions }]);
		const rewritten = await runner.emitToolResult({
			type: "tool_result", toolName: "skill_search", toolCallId: "load",
			input: { action: "load", name: "repo-guidance" }, content: full.content,
			details: full.details, isError: false,
		});
		assert.deepEqual(rewritten?.content ?? full.content, full.content);
		await assert.rejects(search.execute("bad", { action: "load", name: "unknown" }), /Unknown skill/);
		assert.deepEqual(errors, []);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const [key, value] of Object.entries(optimizerEnvironment)) process.env[key] = value;
		rmSync(root, { recursive: true, force: true });
	}
});

test("real Pi loader/runner lets optimizer_tool_search activate initially deferred and codemode tools", async () => {
	const packagedRoot = process.env.PI_SKILL_OPTIMIZER_TEST_PACKAGE;
	const extensionPath = packagedRoot
		? join(resolve(packagedRoot), "src", "index.ts")
		: fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "sko-deferred-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const deferredPath = join(root, "deferred.ts");
		writeFileSync(deferredPath, `export default function (pi) {
			pi.registerTool({
				name: "mcp__issues__find", label: "Find issues",
				description: "Find issue tracker tickets", exposure: "deferred",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
			});
			pi.registerTool({
				name: "mcp__issues__update", label: "Update issues",
				description: "Update issue tracker tickets", exposure: "codemode",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; },
			});
		}`, "utf8");
		const loaded = await discoverAndLoadExtensions([extensionPath, deferredPath], root, join(root, "agent"));
		assert.deepEqual(loaded.errors, []);
		const session = SessionManager.inMemory(root);
		const modelRegistry = {
			complete() { throw new Error("Provider calls are forbidden in this smoke test"); },
		} as unknown as ModelRegistry;
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session, modelRegistry);
		const registered = runner.getAllRegisteredTools();
		for (const [name, exposure] of [["mcp__issues__find", "deferred"], ["mcp__issues__update", "codemode"]]) {
			const tool = registered.find(({ definition }) => definition.name === name);
			assert.equal((tool?.definition as { exposure?: string } | undefined)?.exposure, exposure);
		}
		let active = registered
			.filter(({ definition }) => !["deferred", "codemode"].includes((definition as { exposure?: string }).exposure ?? ""))
			.map(({ definition }) => definition.name);
		runner.bindCore({
			getAllTools: () => registered.map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo })),
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => { active = [...names]; },
			getCommands: () => [],
			appendEntry: () => {},
		} as unknown as ExtensionActions, {
			getModel: () => undefined, getScopedModels: () => [], isIdle: () => true,
			isProjectTrusted: () => true, getSignal: () => undefined, abort() {},
			hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
			compact() {}, getSystemPrompt: () => "", getSystemPromptOptions: () => ({ cwd: root, skills: [] }),
		});
		await runner.emitBeforeAgentStart("", undefined, { cwd: root, skills: [] });
		assert.ok(!active.includes("mcp__issues__find"), "deferred tool was activated before search");
		assert.ok(!active.includes("mcp__issues__update"), "codemode tool was activated before search");
		const search = wrapRegisteredTools(registered, runner).find((tool) => tool.name === "optimizer_tool_search");
		assert.ok(search);
		const result = await search.execute("find-deferred", { query: "issue tracker tickets" });
		const page = JSON.parse((result.content[0] as { text: string }).text) as { activated: string[] };
		assert.deepEqual(page.activated, ["mcp__issues__find", "mcp__issues__update"]);
		assert.ok(active.includes("mcp__issues__find"));
		assert.ok(active.includes("mcp__issues__update"));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
