import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import skillOptimizer from "../src/index.ts";
import { CATALOG_TAGS } from "../src/catalog.ts";
import { getProfilePaths } from "../src/config.ts";
import { readStoredProfile } from "../src/persistence.ts";

function liveRuntime(skillCount = 2, immediateCalls = 0) {
	const root = mkdtempSync(join(tmpdir(), "sko-init-live-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const api = {
		registerTool() {},
		registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); return () => {}; },
		getCommands() { return []; }, getActiveTools() { return []; }, getAllTools() { return []; }, setActiveTools() {},
	} as unknown as ExtensionAPI;
	skillOptimizer(api);
	const skills = Array.from({ length: skillCount }, (_, index) => ({
		name: `skill_${index}`, description: `Complete source ${index}`,
		filePath: join(root, `skill_${index}`, "SKILL.md"), baseDir: join(root, `skill_${index}`),
		disableModelInvocation: false, sourceInfo: { scope: "user" },
	})) as unknown as Skill[];
	const widgets: Array<string[] | undefined> = [];
	const notices: string[] = [];
	let calls = 0;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const ctx = {
		cwd: root, mode: "tui", hasUI: true, model: { provider: "test", id: "test-model" },
		modelRegistry: {
			complete(model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }) {
				return this.stream(model, request, { signal: new AbortController().signal }).result();
			},
			stream(_model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }, options: { signal: AbortSignal }) {
				calls++;
				assert.ok(options.signal instanceof AbortSignal);
				const names = (JSON.parse(request.messages[0]!.content[0]!.text).skills as Array<{ name: string }>).map(({ name }) => name);
				const wait = calls <= immediateCalls ? Promise.resolve() : blocked;
				const result = wait.then(() => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
					processedSkills: names,
					catalogCards: Object.fromEntries(names.map((name) => [name, { summary: `Supports ${name}.`, tags: [CATALOG_TAGS[0]!.id] }])),
				}) }] }));
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start" };
						yield { type: "thinking_delta", delta: "private thinking that must not be displayed" };
						await wait;
						yield { type: "text_delta", delta: "private JSON that must not be displayed" };
					},
					result: () => result,
				};
			},
		},
		getSystemPromptOptions: () => ({ skills }),
		ui: {
			notify(message: string) { notices.push(message); }, setStatus() {},
			setWidget(key: string, lines: string[] | undefined, options: { placement: string }) {
				assert.equal(key, "skill-optimizer-init");
				assert.equal(options.placement, "aboveEditor");
				widgets.push(lines && [...lines]);
			},
		},
	} as unknown as ExtensionContext;
	return {
		root, ctx, command: (args: string) => command(args, ctx), handlers, widgets, notices,
		calls: () => calls, release,
		cleanup() {
			handlers.get("session_shutdown")?.({}, ctx);
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("init is visible above the editor before the first response and heartbeat never invents progress", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	const runtime = liveRuntime();
	try {
		const running = runtime.command("init");
		await nextTick();
		assert.equal(runtime.calls(), 1);
		assert.ok(runtime.widgets.length > 0, "a hidden footer cannot be the only progress surface");
		assert.match(runtime.widgets.at(-1)!.join("\n"), /0%/);
		assert.match(runtime.widgets.at(-1)!.join("\n"), /1\/1/);
		assert.match(runtime.widgets.at(-1)!.join("\n"), /test-model/);
		const before = runtime.widgets.at(-1)!.join("\n");
		t.mock.timers.tick(3_000);
		const after = runtime.widgets.at(-1)!.join("\n");
		assert.notEqual(after, before, "elapsed time must move while the provider has not completed");
		assert.match(after, /0%/);
		assert.doesNotMatch(after, /private thinking|private JSON/);
		runtime.release();
		await running;
		assert.match(runtime.widgets.at(-1)!.join("\n"), /100%/);
		assert.equal(Object.keys(readStoredProfile(getProfilePaths(runtime.root).global).hashes).length, 2);
		const count = runtime.widgets.length;
		t.mock.timers.tick(10_000);
		assert.equal(runtime.widgets.length, count, "completion must stop the heartbeat");
	} finally { runtime.cleanup(); }
});

test("cancel stops a stalled init, prevents late saves, and leaves no running timer", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000 });
	const runtime = liveRuntime();
	try {
		const running = runtime.command("init");
		await nextTick();
		await runtime.command("init");
		assert.equal(runtime.calls(), 1, "a second init must not start overlapping requests");
		assert.ok(runtime.notices.some((message) => /already running/i.test(message)));
		await runtime.command("cancel");
		await running;
		assert.ok(runtime.notices.some((message) => /init cancelled/i.test(message)));
		assert.match(runtime.widgets.at(-1)!.join("\n"), /cancelled/i);
		assert.equal(existsSync(getProfilePaths(runtime.root).global), false);
		const count = runtime.widgets.length;
		runtime.release();
		await nextTick();
		t.mock.timers.tick(10_000);
		assert.equal(runtime.widgets.length, count);
		assert.equal(existsSync(getProfilePaths(runtime.root).global), false, "an aborted response cannot checkpoint later");
	} finally { runtime.cleanup(); }
});

test("session shutdown aborts init and clears its widget without late notifications or writes", async () => {
	const runtime = liveRuntime();
	try {
		const running = runtime.command("init");
		await nextTick();
		await runtime.handlers.get("session_shutdown")?.({}, runtime.ctx);
		await running;
		assert.equal(runtime.widgets.at(-1), undefined);
		const noticeCount = runtime.notices.length;
		const widgetCount = runtime.widgets.length;
		runtime.release();
		await nextTick();
		assert.equal(runtime.notices.length, noticeCount);
		assert.equal(runtime.widgets.length, widgetCount);
		assert.equal(existsSync(getProfilePaths(runtime.root).global), false);
	} finally { runtime.cleanup(); }
});

test("cancel preserves the progress and checkpoint from completed batches", async () => {
	const runtime = liveRuntime(21, 1);
	try {
		const running = runtime.command("init");
		await nextTick();
		assert.equal(runtime.calls(), 2);
		assert.equal(Object.keys(readStoredProfile(getProfilePaths(runtime.root).global).hashes).length, 20);
		assert.match(runtime.widgets.at(-1)!.join("\n"), /95%/);
		await runtime.command("cancel");
		await running;
		assert.equal(Object.keys(readStoredProfile(getProfilePaths(runtime.root).global).hashes).length, 20);
		assert.match(runtime.widgets.at(-1)!.join("\n"), /95%/);
		assert.match(runtime.widgets.at(-1)!.join("\n"), /cancelled/i);
	} finally { runtime.cleanup(); }
});
