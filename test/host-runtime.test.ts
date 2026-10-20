import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hashSkill } from "../src/profile.ts";
import {
	createToolSearchExtension, DefaultResourceLoader, ExtensionRunner, discoverAndLoadExtensions, SessionManager, wrapRegisteredTools,
	type ExtensionActions, type ModelRegistry, type Skill,
} from "@earendil-works/pi-coding-agent";

test("Pi host loader keeps built-in tool_search alongside optimizer_tool_search", async () => {
	const packagedRoot = process.env.PI_SKILL_OPTIMIZER_TEST_PACKAGE;
	const packageRoot = packagedRoot ? resolve(packagedRoot) : resolve(fileURLToPath(new URL("..", import.meta.url)));
	const root = mkdtempSync(join(tmpdir(), "sko-pi-host-loader-"));
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
		let activeProvider: string | undefined = "test-provider";
		const registered = runner.getAllRegisteredTools();
		let active = registered.map(({ definition }) => definition.name);
		runner.bindCore({
			getAllTools: () => registered.map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo })),
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => { active = [...names]; },
			getCommands: () => [],
			appendEntry: (customType: string, data: unknown) => { session.appendCustomEntry(customType, data); },
		} as unknown as ExtensionActions, {
			getModel: () => activeProvider ? ({ provider: activeProvider } as never) : undefined, getScopedModels: () => [], isIdle: () => true,
			isProjectTrusted: () => true, getSignal: () => undefined, abort() {},
			hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
			compact() {}, getSystemPrompt: () => "", getSystemPromptOptions: () => ({ cwd: root, skills }),
		});
		const notices: string[] = [];
		const statusCalls: Array<string | undefined> = [];
		const ui = runner.getUIContext();
		runner.setUIContext({ ...ui, notify: (message) => { notices.push(message); }, setStatus: (_key, text) => { statusCalls.push(text); } });
		process.env.PI_SKILL_OPTIMIZER_ALWAYS_SKILLS = "repo-guidance";
		process.env.PI_SKILL_OPTIMIZER_PROVIDERS = "test-provider";
		// No session_start/shutdown: their shared archive cleanup is outside this isolated probe.
		await runner.emitBeforeAgentStart(
			{ messageType: "user", prompt: "Review repository module boundaries" },
			{ cwd: root, skills },
		);
		assert.deepEqual(errors, []);

		const longGuidance = "Use when reviewing repository module boundaries. Read relevant source and verify concrete behavior. ".repeat(28);
		const systemCatalog = `<available_skills>
			<skill><name>repo-guidance</name><description>${longGuidance}</description><location>${filePath}</location></skill>
			<skill><name>nuclei</name><description>${"Run nuclei templates for vulnerability scanning. ".repeat(24)}</description><location>${filePath}</location></skill>
		</available_skills>`;
		const rawMessages = [
			{
				role: "system", content: "base instructions",
				sections: { skills: systemCatalog, cwd: "<cwd>/workspace</cwd>", retained: "keep this section" },
				toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
				timestamp: 1,
			},
			{ role: "user", content: "Review repository module boundaries" },
			{ role: "assistant", content: [{ type: "toolCall", id: "load-guidance", name: "skill_search", arguments: { action: "load", name: "repo-guidance" } }] },
			{ role: "custom", customType: "pi-persona", content: "Async runs: 1. Routine check-in. The skills nuclei and /skill:nuclei are already loaded." },
			{ role: "bashExecution", command: "echo nuclei", output: "nuclei" },
			{ role: "branchSummary", summary: "nuclei was considered earlier" },
			{ role: "compactionSummary", summary: "Repository review remains active" },
			{ role: "toolResult", toolCallId: "load-guidance", content: [{ type: "text", text: longGuidance }], isError: false },
			{
				role: "system", content: "additional instructions",
				sections: { skills: systemCatalog, retained: "second system section" },
				toolsAdded: [{ name: "bash", description: "Run a command", parameters: { type: "object" } }],
				timestamp: 2,
			},
		];
		const rawMessagesSnapshot = structuredClone(rawMessages);
		const initialStatus = statusCalls.at(-1);
		activeProvider = undefined;
		assert.deepEqual(await runner.emitContext(rawMessages as never), rawMessages, "an absent model is outside the configured provider scope");
		assert.equal(statusCalls.at(-1), initialStatus, "an out-of-scope context must not update optimization statistics");
		activeProvider = "other-provider";
		assert.deepEqual(await runner.emitContext(rawMessages as never), rawMessages, "a mismatched model is outside the configured provider scope");
		assert.equal(statusCalls.at(-1), initialStatus, "a mismatched provider must not update optimization statistics");
		activeProvider = "test-provider";
		const transformedMessages = await runner.emitContext(rawMessages as never) as Array<{ role: string; content?: unknown; [key: string]: unknown }>;
		const transformedSystem = transformedMessages[0] as { role: string; content?: unknown; sections?: Record<string, unknown>; toolsAdded?: unknown; timestamp?: number };
		assert.equal(transformedSystem.role, "system", "the leading system message must be preserved");
		assert.match(String(transformedSystem.sections?.skills), /skill-optimizer:auto:v2/);
		assert.equal(transformedSystem.sections?.cwd, "<cwd>/workspace</cwd>");
		assert.equal(transformedSystem.sections?.retained, "keep this section");
		assert.deepEqual(transformedSystem.toolsAdded, rawMessages[0].toolsAdded);
		assert.equal(transformedSystem.timestamp, 1);
		const additionalSystem = transformedMessages.filter((message) => message.role === "system")[1] as { sections?: Record<string, unknown>; toolsAdded?: unknown; timestamp?: number };
		assert.match(String(additionalSystem.sections?.skills), /skill-optimizer:auto:v2/);
		assert.equal(additionalSystem.sections?.retained, "second system section");
		assert.deepEqual(additionalSystem.toolsAdded, rawMessages[8].toolsAdded);
		assert.equal(additionalSystem.timestamp, 2);
		const transformedUser = transformedMessages.find((message) => message.role === "user");
		assert.ok(transformedUser);
		assert.match(JSON.stringify(transformedUser.content), /skill-optimizer:prefetch:v2/);
		assert.match(JSON.stringify(transformedUser.content), /repo-guidance/);
		assert.doesNotMatch(JSON.stringify(transformedUser.content), /<name>nuclei<\/name>/);
		assert.deepEqual(transformedMessages.find((message) => message.role === "custom"), rawMessages[3]);
		assert.deepEqual(transformedMessages.find((message) => message.role === "bashExecution"), rawMessages[4]);
		assert.deepEqual(transformedMessages.find((message) => message.role === "branchSummary"), rawMessages[5]);
		assert.deepEqual(transformedMessages.find((message) => message.role === "compactionSummary"), rawMessages[6]);
		assert.deepEqual(transformedMessages.find((message) => message.role === "toolResult"), rawMessages[7]);
		assert.deepEqual(errors, []);
		assert.deepEqual(rawMessages, rawMessagesSnapshot, "context preparation must not mutate Pi's source transcript");
		assert.deepEqual(
			await runner.emitContext(rawMessages as never),
			transformedMessages,
			"replaying the same Pi transcript must not duplicate or change the overlay",
		);
		const syntheticOnlyMessages = [
			rawMessages[0],
			{ role: "custom", customType: "pi-persona", content: "Async runs: 1. Routine check-in. repo-guidance and /skill:nuclei are already loaded." },
			{ role: "bashExecution", command: "echo repo-guidance", output: "repo-guidance" },
			{ role: "branchSummary", summary: "repo-guidance was considered earlier" },
			{ role: "compactionSummary", summary: "nuclei and repo-guidance were mentioned" },
			{ role: "toolResult", toolCallId: "synthetic", content: [{ type: "text", text: "repo-guidance" }], isError: false },
		];
		const syntheticOnlyResult = await runner.emitContext(syntheticOnlyMessages as never) as Array<{ role: string; content?: unknown; sections?: Record<string, unknown> }>;
		assert.match(String(syntheticOnlyResult[0]?.sections?.skills), /skill-optimizer:auto:v2/);
		assert.doesNotMatch(JSON.stringify(syntheticOnlyResult), /skill-optimizer:prefetch:v2/);
		assert.deepEqual(syntheticOnlyResult[1], syntheticOnlyMessages[1]);

		const setupMessage = "Optional setup: run `/skill-optimizer init` to improve skill matching (may incur model costs).";
		assert.equal(notices.filter((text) => text === setupMessage).length, 1);
		await runner.emitBeforeAgentStart(
			{ messageType: "user", prompt: "Review another module" },
			{ cwd: root, skills },
		);
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
		const nestedText = JSON.stringify(Array.from({ length: 1_000 }, (_, id) => ({ id, value: "ordinary payload ".repeat(6) })));
		const statusBeforeNestedResult = statusCalls.at(-1);
		const nestedResult = await runner.emitToolResult({
			type: "tool_result", toolName: "read", toolCallId: "nested-read-call",
			parentToolCallId: "codemode-parent-call",
			input: { path: "payload.json" }, content: [{ type: "text", text: nestedText }],
			details: {}, isError: false,
		});
		assert.equal(nestedResult, undefined, "Pi nested results must pass through exactly for programmatic codemode callers");
		assert.equal(statusCalls.at(-1), statusBeforeNestedResult, "nested results must not accrue output savings");
		await assert.rejects(search.execute("bad", { action: "load", name: "unknown" }), /Unknown skill/);

		// Exercise the v6 contract through Pi's actual loader, hook runner and wrapped tools,
		// not merely the pure renderer. This isolated fixture never calls a provider.
		const taggedSkills = [{ ...skills[0]!, description: longGuidance.repeat(3) }];
		const profileDir = join(root, "agent", "skill-optimizer");
		mkdirSync(profileDir, { recursive: true });
		writeFileSync(join(profileDir, "profile.json"), JSON.stringify({ catalog: { version: 1, cards: {
			"repo-guidance": { summary: "Review repository module boundaries before changing them.", tags: ["architecture", "review"], sourceHash: hashSkill("repo-guidance", taggedSkills[0]!.description) },
		} } }));
		await command.handler("", runner.createCommandContext()); // Explicit profile refresh.
		await runner.emitBeforeAgentStart({ messageType: "user", prompt: "設計を見直してください" }, { cwd: root, skills: taggedSkills });
		const taggedMessages = [
			{ role: "system", content: "base instructions", sections: { skills: `<available_skills><skill><name>repo-guidance</name><description>${taggedSkills[0]!.description}</description><location>${filePath}</location></skill></available_skills>` }, timestamp: 3 },
			{ role: "user", content: "設計を見直してください" },
		];
		const taggedContext = await runner.emitContext(taggedMessages as never) as typeof taggedMessages;
		assert.match(String(taggedContext[0]!.sections?.skills), /skill-optimizer:tags:v1/);
		assert.deepEqual(taggedContext[1], taggedMessages[1], "tag mode must not append an acknowledgment-inducing prefetch");
		const browsed = await search.execute("tag-browse", { action: "search", tags: ["architecture"], query: "設計を見直してください" });
		assert.ok(JSON.stringify(browsed.content).includes("repo-guidance"));
		assert.deepEqual((await search.execute("tag-load", { action: "load", name: "repo-guidance" })).content, [{ type: "text", text: instructions }]);
		active = []; // Simulate an external persona withholding every optimizer helper.
		await runner.emitBeforeAgentStart({ messageType: "user", prompt: "Review" }, { cwd: root, skills: taggedSkills });
		assert.deepEqual(await runner.emitContext(taggedMessages as never), taggedMessages, "keep native discovery when the resolver is not callable");
		assert.deepEqual(errors, []);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SKILL_OPTIMIZER_")) delete process.env[key];
		}
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
		const optimizerSearchDefinition = registered.find(({ definition }) => definition.name === "optimizer_tool_search")?.definition as
			{ reachesTools?: () => string } | undefined;
		assert.equal(optimizerSearchDefinition?.reachesTools?.(), "all", "Pi should expose all deferred tools to the resolver");
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
		await runner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, { cwd: root, skills: [] });
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
