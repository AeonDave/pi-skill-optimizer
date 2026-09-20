import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import skillOptimizer from "../src/index.ts";
import { getProfilePaths } from "../src/config.ts";
import { readStoredProfile, writeProfileFiles } from "../src/persistence.ts";
import { hashSkill } from "../src/profile.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

function registerExtension(): CommandHandler {
	let command: CommandHandler | undefined;
	const api = {
		registerTool() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			if (name === "skill-optimizer") command = options.handler;
		},
		on() { return () => {}; },
		getCommands() { return []; },
		getActiveTools() { return []; },
		getAllTools() { return []; },
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	skillOptimizer(api);
	assert.ok(command);
	return command;
}

test("init repairs a project skill stored in the global profile without calling the model", async () => {
	const root = mkdtempSync(join(tmpdir(), "sko-init-"));
	const cwd = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const paths = getProfilePaths(cwd);
		const description = "Project-only routing skill";
		writeProfileFiles([{
			path: paths.global,
			profile: {
				critical: [],
				queries: { project_skill: ["project routing"] },
				clusters: {},
				negativeHints: {},
			},
			skillCount: 1,
			hashes: { project_skill: hashSkill("project_skill", description) },
			expectedRevision: null,
		}], 4);

		let modelCalls = 0;
		const skill = {
			name: "project_skill",
			description,
			filePath: join(cwd, ".agents", "skills", "project_skill", "SKILL.md"),
			baseDir: join(cwd, ".agents", "skills", "project_skill"),
			disableModelInvocation: false,
			sourceInfo: { scope: "project" },
		} as unknown as Skill;
		const notifications: string[] = [];
		const ctx = {
			cwd,
			model: { provider: "test", id: "test" },
			modelRegistry: {
				async complete() {
					modelCalls += 1;
					throw new Error("model must not be called for a scope-only repair");
				},
			},
			getSystemPromptOptions: () => ({ skills: [skill] }),
			ui: {
				notify(message: string) { notifications.push(message); },
				setStatus() {},
			},
		} as unknown as ExtensionContext;

		await registerExtension()("init", ctx);

		assert.equal(modelCalls, 0);
		assert.equal(existsSync(paths.project), true);
		assert.deepEqual(readStoredProfile(paths.global).hashes, {});
		assert.deepEqual(readStoredProfile(paths.project).hashes, {
			project_skill: hashSkill("project_skill", description),
		});
		assert.deepEqual(readStoredProfile(paths.project).profile.queries, {
			project_skill: ["project routing"],
		});
		assert.ok(notifications.some((message) => message.includes("init done")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("init checkpoints a successful batch, avoids a stale final rewrite, and keeps progress transient", async () => {
	const root = mkdtempSync(join(tmpdir(), "sko-init-checkpoint-"));
	const cwd = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const paths = getProfilePaths(cwd);
		const skills = Array.from({ length: 81 }, (_, index) => ({
			name: `skill_${String(index).padStart(3, "0")}`,
			description: `Routing description ${index}`,
			filePath: join(root, "skills", `skill_${index}`, "SKILL.md"),
			baseDir: join(root, "skills", `skill_${index}`),
			disableModelInvocation: false,
			sourceInfo: { scope: "user" },
		})) as unknown as Skill[];
		const notifications: string[] = [];
		const statuses: Array<string | undefined> = [];
		let modelCalls = 0;
		const ctx = {
			cwd,
			model: { provider: "test", id: "test" },
			modelRegistry: {
				async complete(_model: unknown, request: { messages: Array<{ content: Array<{ text: string }> }> }) {
					modelCalls += 1;
					const body = JSON.parse(request.messages[0].content[0].text) as {
						skills: Array<{ name: string }>;
					};
					if (modelCalls === 2) {
						const current = readStoredProfile(paths.global);
						writeProfileFiles([{
							path: paths.global,
							profile: { ...current.profile, critical: [...current.profile.critical, "external-writer"] },
							skillCount: Object.keys(current.hashes).length,
							hashes: current.hashes,
							expectedRevision: current.revision,
						}], 4);
						return { stopReason: "aborted", content: [] };
					}
					const names = body.skills.map((skill) => skill.name);
					return {
						stopReason: "stop",
						content: [{
							type: "text",
							text: JSON.stringify({ processedSkills: names, critical: names }),
						}],
					};
				},
			},
			getSystemPromptOptions: () => ({ skills }),
			ui: {
				notify(message: string) { notifications.push(message); },
				setStatus(_key: string, message: string | undefined) { statuses.push(message); },
			},
		} as unknown as ExtensionContext;

		await registerExtension()("init", ctx);

		assert.equal(modelCalls, 2);
		const stored = readStoredProfile(paths.global);
		assert.equal(Object.keys(stored.hashes).length, 80);
		assert.equal(stored.profile.critical.includes("external-writer"), true);
		assert.equal(notifications.length, 3);
		assert.match(notifications[0], /init starting/);
		assert.match(notifications[1], /aborted/);
		assert.match(notifications[2], /init done/);
		assert.ok(statuses.some((status) => status?.includes("init 1/2 starting")));
		assert.ok(statuses.some((status) => status?.includes("init 1/2 saved")));
		assert.ok(statuses.some((status) => status?.includes("init 2/2 starting")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("init invalidates stale routing and reports the provider cause when every changed-skill batch fails", async () => {
	const root = mkdtempSync(join(tmpdir(), "sko-init-failed-change-"));
	const cwd = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const paths = getProfilePaths(cwd);
		writeProfileFiles([{
			path: paths.global,
			profile: {
				critical: ["changed_skill"],
				queries: { changed_skill: ["obsolete routing"] },
				clusters: { obsolete: ["changed_skill"] },
				negativeHints: { changed_skill: ["obsolete hint"] },
			},
			skillCount: 1,
			hashes: { changed_skill: hashSkill("changed_skill", "old description") },
			expectedRevision: null,
		}], 4);

		const skill = {
			name: "changed_skill",
			description: "new description",
			filePath: join(root, "skills", "changed_skill", "SKILL.md"),
			baseDir: join(root, "skills", "changed_skill"),
			disableModelInvocation: false,
			sourceInfo: { scope: "user" },
		} as unknown as Skill;
		let modelCalls = 0;
		const notifications: string[] = [];
		const ctx = {
			cwd,
			model: { provider: "test", id: "test" },
			modelRegistry: {
				async complete() {
					modelCalls += 1;
					return {
						stopReason: "error",
						errorMessage: "429: Weekly/Monthly Limit Exhausted",
						content: [],
					};
				},
			},
			getSystemPromptOptions: () => ({ skills: [skill] }),
			ui: {
				notify(message: string) { notifications.push(message); },
				setStatus() {},
			},
		} as unknown as ExtensionContext;

		await registerExtension()("init", ctx);

		assert.equal(modelCalls, 1);
		const stored = readStoredProfile(paths.global);
		assert.deepEqual(stored.hashes, {});
		assert.deepEqual(stored.profile, {
			critical: [],
			queries: {},
			clusters: {},
			negativeHints: {},
		});
		const attemptMessages = notifications.filter((message) => message.startsWith("skill-optimizer: init 1/1 attempt "));
		assert.equal(attemptMessages.length, 1);
		const finalAttempt = attemptMessages[0];
		assert.match(finalAttempt, /429: Weekly\/Monthly Limit Exhausted/);
		assert.doesNotMatch(finalAttempt, /retrying/);
		assert.match(notifications.at(-1) ?? "", /every batch failed.*429: Weekly\/Monthly Limit Exhausted/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
