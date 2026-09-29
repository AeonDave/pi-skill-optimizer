import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	ExtensionRunner, discoverAndLoadExtensions, SessionManager, wrapRegisteredTools,
	type ExtensionActions, type ModelRegistry, type Skill,
} from "@earendil-works/pi-coding-agent";

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
