import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as nextTick, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	discoverAndLoadExtensions, ExtensionRunner, SessionManager,
	type ExtensionActions, type ModelRegistry, type Skill,
} from "@earendil-works/pi-coding-agent";
import { CATALOG_TAGS } from "../src/catalog.ts";
import { getProfilePaths } from "../src/config.ts";
import { readStoredProfile } from "../src/persistence.ts";

test("real Pi loader exposes live init without a footer, cancels a pending stream, and saves authoritative output", { timeout: 20_000 }, async () => {
	const artifact = process.env.PI_SKILL_OPTIMIZER_TEST_PACKAGE;
	const extensionPath = artifact ? join(resolve(artifact), "src", "index.ts")
		: fileURLToPath(new URL("../src/index.ts", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "sko-init-host-"));
	const agentDir = join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOptimizerEnvironment = Object.fromEntries(Object.entries(process.env)
		.filter(([key]) => key.startsWith("PI_SKILL_OPTIMIZER_")));
	for (const key of Object.keys(previousOptimizerEnvironment)) delete process.env[key];
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let runner: ExtensionRunner | undefined;
	let pending: Promise<void> | undefined;
	let cancel: (() => Promise<void>) | undefined;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	try {
		const baseDir = join(root, "skills", "repo-guidance");
		mkdirSync(baseDir, { recursive: true });
		const filePath = join(baseDir, "SKILL.md");
		writeFileSync(filePath, "# Repository guidance\nReview the actual source.\n", "utf8");
		const skills: Skill[] = [{
			name: "repo-guidance", description: "Review repository changes against actual source.",
			filePath, baseDir, disableModelInvocation: false,
			sourceInfo: { path: filePath, source: "cli", scope: "user", origin: "top-level" },
		}];
		const loaded = await discoverAndLoadExtensions([extensionPath], root, agentDir);
		assert.deepEqual(loaded.errors, [], "init must use the real Pi extension loader");
		assert.equal(loaded.extensions.length, 1);
		let streamCalls = 0;
		const signals: AbortSignal[] = [];
		const modelRegistry = {
			complete() { assert.fail("init must observe the public stream, without a complete fallback"); },
			stream(_model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }, options: { signal: AbortSignal }) {
				const call = ++streamCalls;
				signals.push(options.signal);
				assert.ok(options.signal instanceof AbortSignal);
				const inputs = JSON.parse(request.messages[0]!.content[0]!.text).skills as Array<{ name: string; description: string }>;
				assert.deepEqual(inputs, skills.map(({ name, description }) => ({ name, description })));
				const wait = call === 1 ? blocked : Promise.resolve();
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start" };
						yield { type: "thinking_delta", delta: "private streamed reasoning" };
						await wait;
						yield { type: "text_delta", delta: "private incomplete JSON" };
					},
					async result() {
						await wait;
						return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
							processedSkills: inputs.map(({ name }) => name),
							catalogCards: Object.fromEntries(inputs.map(({ name }) => [name, {
								summary: "Reviews actual repository source.", tags: [CATALOG_TAGS[0]!.id],
							}])),
						}) }] };
					},
				};
			},
		} as unknown as ModelRegistry;
		const session = SessionManager.inMemory(root);
		runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, session, modelRegistry);
		const errors: unknown[] = [];
		runner.onError((error) => errors.push(error));
		const registered = runner.getAllRegisteredTools();
		let active = registered.map(({ definition }) => definition.name);
		runner.bindCore({
			getAllTools: () => registered.map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo })),
			getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names]; },
			getCommands: () => [], appendEntry: (type: string, data: unknown) => { session.appendCustomEntry(type, data); },
		} as unknown as ExtensionActions, {
			getModel: () => ({ provider: "fixture", id: "init-worker" } as never), getScopedModels: () => [],
			isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort() {},
			hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined, compact() {},
			getSystemPrompt: () => "", getSystemPromptOptions: () => ({ cwd: root, skills }),
		});
		const widgets: Array<string[] | undefined> = [];
		const notices: string[] = [];
		const ui = { ...runner.getUIContext(),
			notify: (message: string) => { notices.push(message); },
			setStatus() {}, // A hidden/empty footer must not hide operation progress.
			setWidget(key: string, content: unknown, options?: { placement?: string }) {
				assert.equal(key, "skill-optimizer-init");
				assert.equal(options?.placement, "aboveEditor");
				assert.ok(content === undefined || Array.isArray(content), "widget must work without theme/components");
				widgets.push(content === undefined ? undefined : [...content as string[]]);
			},
		};
		runner.setUIContext(ui, "tui");
		Object.defineProperty(runner.getUIContext(), "theme", { get() { assert.fail("init progress must not require a theme renderer"); } });
		const command = runner.getCommand("skill-optimizer");
		assert.ok(command);
		cancel = async () => { await command.handler("cancel", runner!.createCommandContext()); };
		const ctx = runner.createCommandContext();
		assert.equal(ctx.hasUI, true, "the real runner context must expose the installed UI");
		assert.equal(ctx.mode, "tui");
		pending = Promise.resolve(command.handler("init", ctx));
		await nextTick();
		assert.equal(streamCalls, 1);
		assert.ok(widgets.some((lines) => lines?.some((line) => line.includes("batch 1/1"))));
		assert.match(widgets.at(-1)!.join("\n"), /0\/1 saved/);
		await delay(1_050);
		assert.match(widgets.at(-1)!.join("\n"), /thinking \(26 chars\)/);
		assert.equal(existsSync(getProfilePaths(root).global), false, "pending output cannot be checkpointed");
		await command.handler("cancel", runner.createCommandContext());
		await pending;
		assert.equal(signals[0]!.aborted, true);
		assert.match(widgets.at(-1)!.join("\n"), /init cancelled.*0\/1 saved/);
		assert.equal(existsSync(getProfilePaths(root).global), false, "cancelled output cannot be saved");
		release();
		await nextTick();
		await command.handler("init", runner.createCommandContext());
		assert.equal(streamCalls, 2);
		assert.match(widgets.at(-1)!.join("\n"), /init done: 100% \(1\/1 saved/);
		assert.equal(readStoredProfile(getProfilePaths(root).global).profile.catalog?.cards["repo-guidance"]?.summary,
			"Reviews actual repository source.", "only the authoritative result can create the final card");
		assert.doesNotMatch(JSON.stringify({ widgets, notices }), /private streamed reasoning|private incomplete JSON/);
		assert.deepEqual(errors, []);
	} finally {
		await cancel?.();
		release();
		await pending;
		runner?.invalidate();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const [key, value] of Object.entries(previousOptimizerEnvironment)) process.env[key] = value;
		rmSync(root, { recursive: true, force: true });
	}
});
