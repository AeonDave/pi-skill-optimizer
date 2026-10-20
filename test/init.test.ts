import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import skillOptimizer from "../src/index.ts";
import { getProfilePaths } from "../src/config.ts";
import { readStoredProfile, writeProfileFiles } from "../src/persistence.ts";
import { hashSkill, type SkillOptimizerProfile } from "../src/profile.ts";
import { INIT_PROFILE_VERSION } from "../src/init-prompt.ts";
import { CATALOG_TAGS } from "../src/catalog.ts";
import { DEFAULT_INIT_BATCH_MAX_SKILLS } from "../src/generate.ts";

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
	return (args, ctx) => {
		// These fixtures define final provider responses; expose them through Pi's
		// streaming transport while live-stream behavior is covered in init-live.test.ts.
		ctx.modelRegistry.stream = ((_model: NonNullable<ExtensionContext["model"]>, request: Parameters<ExtensionContext["modelRegistry"]["complete"]>[1]) => {
			const result = ctx.modelRegistry.complete(_model, request);
			return {
				async *[Symbol.asyncIterator]() { await result; },
				result: () => result,
			};
		}) as unknown as typeof ctx.modelRegistry.stream;
		return command!(args, ctx);
	};
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
				catalog: { version: 1, cards: {
					project_skill: {
						summary: "Routes project-specific tasks.",
						tags: [CATALOG_TAGS[0]!.id],
						sourceHash: hashSkill("project_skill", description),
					},
				} },
			},
			skillCount: 1,
			hashes: { project_skill: hashSkill("project_skill", description) },
			expectedRevision: null,
		}], INIT_PROFILE_VERSION);

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
		const skills = Array.from({ length: DEFAULT_INIT_BATCH_MAX_SKILLS + 1 }, (_, index) => ({
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
				async complete(_model: unknown, request: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }) {
					modelCalls += 1;
					const body = JSON.parse(request.messages[0].content[0].text) as {
						skills: Array<{ name: string }>;
					};
					assert.match(request.systemPrompt, /substitutes/);
					assert.doesNotMatch(request.systemPrompt, /confusable or complementary/);
					assert.match(request.systemPrompt, /behavioral kind does not imply universal/);
					assert.match(request.systemPrompt, /software-change/);
					assert.doesNotMatch(request.systemPrompt, /\{\{ACTIVATION_TASKS\}\}/);
					assert.match(request.systemPrompt, /catalogCards/);
					assert.doesNotMatch(request.systemPrompt, /\{\{CATALOG_TAGS\}\}/);
					if (modelCalls === 2) {
						const current = readStoredProfile(paths.global);
						writeProfileFiles([{
							path: paths.global,
							profile: { ...current.profile, critical: [...current.profile.critical, "external-writer"] },
							skillCount: Object.keys(current.hashes).length,
							hashes: current.hashes,
							expectedRevision: current.revision,
						}], INIT_PROFILE_VERSION);
						return { stopReason: "aborted", content: [] };
					}
					const names = body.skills.map((skill) => skill.name);
					return {
						stopReason: "stop",
						content: [{
							type: "text",
							text: JSON.stringify({
								processedSkills: names,
								catalogCards: Object.fromEntries(names.map((name) => [name, {
									summary: `Provides ${name} capabilities.`,
									tags: [CATALOG_TAGS[0]!.id],
								}])),
								critical: names,
								activation: {
									skill_000: { kind: "specialist", tasks: ["software-change"] },
									"foreign-owner": { kind: "behavioral", tasks: ["software-change"] },
								},
							}),
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
		assert.equal(Object.keys(stored.hashes).length, DEFAULT_INIT_BATCH_MAX_SKILLS);
		assert.equal(stored.profile.critical.includes("external-writer"), true);
		assert.deepEqual((stored.profile as unknown as { activation: unknown }).activation, {
			skill_000: { kind: "specialist", tasks: ["software-change"] },
		});
		assert.equal(Object.keys(stored.profile.catalog?.cards ?? {}).length, DEFAULT_INIT_BATCH_MAX_SKILLS);
		assert.equal(notifications.length, 3);
		assert.match(notifications[0], /init starting/);
		assert.match(notifications[1], /aborted/);
		assert.match(notifications[2], /init incomplete.*run \/skill-optimizer init/);
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
		}], INIT_PROFILE_VERSION);

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

test("explicit init upgrades old routing hints once and persists activation tags", async () => {
	const root = mkdtempSync(join(tmpdir(), "sko-init-tags-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const paths = getProfilePaths(root);
		const name = "language-guide";
		const description = "Implement language-specific changes.";
		writeProfileFiles([{
			path: paths.global,
			profile: { critical: [], queries: {}, clusters: {}, negativeHints: {} },
			skillCount: 1, hashes: { [name]: hashSkill(name, description) }, expectedRevision: null,
		}], 4);
		let calls = 0;
		const activation = { [name]: { kind: "specialist", tasks: ["software-change"] } };
		const notifications: string[] = [];
		const ctx = {
			cwd: root, model: { provider: "test", id: "test" },
			modelRegistry: {
				async complete() {
					calls += 1;
					return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
						processedSkills: [name],
						catalogCards: { [name]: { summary: "Supports language-specific changes.", tags: [CATALOG_TAGS[0]!.id] } },
						activation,
					}) }] };
				},
			},
			getSystemPromptOptions: () => ({ skills: [{
				name, description, filePath: join(root, "SKILL.md"), baseDir: root,
				disableModelInvocation: false, sourceInfo: { scope: "user" },
			}] }),
			ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
		} as unknown as ExtensionContext;
		const command = registerExtension();
		await command("", ctx);
		assert.equal(calls, 0, "status cannot silently upgrade a profile with model work");
		await command("init", ctx);
		assert.equal(calls, 1);
		assert.equal(readStoredProfile(paths.global).initVersion, INIT_PROFILE_VERSION);
		assert.deepEqual(readStoredProfile(paths.global).profile.activation, activation);
		assert.equal(readStoredProfile(paths.global).profile.catalog?.cards[name]?.sourceHash, hashSkill(name, description));
		assert.ok(notifications.some((text) => text.startsWith(`skill-optimizer: init done v${INIT_PROFILE_VERSION} `)),
			"completion must report the current init format version");
		await command("init", ctx);
		assert.equal(calls, 1, "already-current init must not regenerate unchanged skills");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("repeated failed v6 migration preserves unchanged v5 hints until a source change or accepted replacement", async () => {
	const root = mkdtempSync(join(tmpdir(), "sko-init-preserve-v5-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const paths = getProfilePaths(root);
		const name = "legacy-skill";
		const description = "Existing v5 skill description";
		let currentDescription = description;
		let calls = 0;
		let succeed = false;
		const legacyProfile: SkillOptimizerProfile = {
			critical: [name],
			queries: { [name]: ["old useful query"] },
			clusters: { existing: [name] },
			negativeHints: { [name]: ["old false positive"] },
			activation: { [name]: { kind: "specialist", tasks: ["software-change"] } },
		};
		writeProfileFiles([{
			path: paths.global,
			profile: legacyProfile,
			skillCount: 1,
			hashes: { [name]: hashSkill(name, description) },
			expectedRevision: null,
		}], 5);
		const notifications: string[] = [];
		const ctx = {
			cwd: root,
			model: { provider: "test", id: "test" },
			modelRegistry: {
				async complete() {
					calls += 1;
					if (succeed) return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
						processedSkills: [name],
						queries: { [name]: ["new useful query"] },
						catalogCards: { [name]: { summary: "Current distinguishing capabilities.", tags: [CATALOG_TAGS[0]!.id] } },
					}) }] };
					return { stopReason: "error", errorMessage: "temporary network failure", content: [] };
				},
			},
			getSystemPromptOptions: () => ({ skills: [{
				name, description: currentDescription, filePath: join(root, "SKILL.md"), baseDir: root,
				disableModelInvocation: false, sourceInfo: { scope: "user" },
			}] }),
			ui: { notify(message: string) { notifications.push(message); }, setStatus() {} },
		} as unknown as ExtensionContext;

		const command = registerExtension();
		for (let attempt = 1; attempt <= 2; attempt++) {
			await command("init", ctx);
			const stored = readStoredProfile(paths.global);
			assert.deepEqual(stored.profile, legacyProfile, `failed migration ${attempt} must preserve every existing hint`);
			assert.deepEqual(stored.hashes, { [name]: hashSkill(name, description) },
				"retain the known unchanged source identity without inventing a catalog card");
			assert.equal(stored.profile.catalog, undefined);
			assert.equal(calls, attempt * 2, "a missing catalog card must still retry despite its known source hash");
			assert.ok(notifications.at(-1)?.includes("every batch failed"));
		}

		currentDescription = "Changed v6 skill description";
		await command("init", ctx);
		const changed = readStoredProfile(paths.global);
		assert.deepEqual(changed.profile, { critical: [], queries: {}, clusters: {}, negativeHints: {} },
			"a real source change must invalidate stale routing even if its replacement fails");
		assert.deepEqual(changed.hashes, {}, "a failed changed source must not advance its hash");
		assert.equal(calls, 6);

		succeed = true;
		await command("init", ctx);
		const accepted = readStoredProfile(paths.global);
		assert.deepEqual(accepted.hashes, { [name]: hashSkill(name, currentDescription) });
		assert.deepEqual(accepted.profile.queries, { [name]: ["new useful query"] });
		assert.equal(accepted.profile.catalog?.cards[name]?.sourceHash, hashSkill(name, currentDescription));
		assert.equal(calls, 7, "the valid replacement is accepted in one provider call");
		await command("init", ctx);
		assert.equal(calls, 7, "the accepted catalog stays current without additional provider calls");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("init resumes 275 missing cards, recovers smaller batches, and preserves the 80 completed owners", async () => {
	const root = mkdtempSync(join(tmpdir(), "sko-init-resume-355-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const paths = getProfilePaths(root);
		const skills = Array.from({ length: 355 }, (_, index) => ({
			name: `skill_${String(index).padStart(3, "0")}`,
			description: `Complete original description ${index}: 日本語; quotes " and newline\nremain intact.`,
			filePath: join(root, "skills", `skill_${index}`, "SKILL.md"),
			baseDir: join(root, "skills", `skill_${index}`),
			disableModelInvocation: false,
			sourceInfo: { scope: "user" },
		})) as unknown as Skill[];
		const card = (skill: Skill) => ({ summary: `Provides ${skill.name} capabilities.`, tags: [CATALOG_TAGS[0]!.id] });
		const existing = skills.slice(0, 80);
		writeProfileFiles([{
			path: paths.global,
			profile: {
				critical: [existing[0]!.name],
				queries: Object.fromEntries(existing.map(({ name }) => [name, ["Previously verified profile query"]])),
				clusters: {}, negativeHints: {},
				catalog: { version: 1, cards: Object.fromEntries(existing.map((skill) => [skill.name, {
					...card(skill), sourceHash: hashSkill(skill.name, skill.description),
				}])) },
			},
			skillCount: 355,
			hashes: Object.fromEntries(existing.map((skill) => [skill.name, hashSkill(skill.name, skill.description)])),
			expectedRevision: null,
		}], INIT_PROFILE_VERSION);
		const before = readStoredProfile(paths.global);
		const notifications: string[] = [];
		const requests: Array<{ skills: Array<{ name: string; description: string }>; retryFeedback?: string }> = [];
		const statuses: Array<string | undefined> = [];
		const ctx = {
			cwd: root, model: { provider: "test", id: "test" },
			modelRegistry: {
				async complete(_model: unknown, request: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }) {
					const body = JSON.parse(request.messages[0]!.content[0]!.text) as typeof requests[number];
					requests.push(body);
					assert.ok(body.skills.length <= 20, "init must bound the per-response skill count");
					for (const skill of body.skills) {
						assert.ok(!existing.some(({ name }) => name === skill.name), "completed owners cannot be regenerated");
						assert.equal(skill.description, skills.find(({ name }) => name === skill.name)!.description);
					}
					const invalid = body.skills.length > 10;
					return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({
						processedSkills: body.skills.map(({ name }) => name),
						catalogCards: invalid ? {} : Object.fromEntries(body.skills.map((skill) => [skill.name, card(skill as Skill)])),
					}) }] };
				},
			},
			getSystemPromptOptions: () => ({ skills }),
			ui: { notify(message: string) { notifications.push(message); }, setStatus(_key: string, text: string | undefined) { statuses.push(text); } },
		} as unknown as ExtensionContext;
		const command = registerExtension();
		await command("init", ctx);
		const stored = readStoredProfile(paths.global);
		assert.equal(Object.keys(stored.hashes).length, 355);
		assert.equal(Object.keys(stored.profile.catalog!.cards).length, 355);
		for (const { name } of existing) {
			assert.deepEqual(stored.profile.catalog!.cards[name], before.profile.catalog!.cards[name]);
			assert.deepEqual(stored.profile.queries[name], before.profile.queries[name]);
		}
		assert.deepEqual(stored.profile.critical, before.profile.critical);
		assert.ok(requests.some(({ retryFeedback }) => retryFeedback?.includes("missing or invalid semantic catalog cards")));
		assert.ok(statuses.some((text) => text?.includes("splitting")));
		assert.match(notifications.at(-1)!, /init done.*retry 0/);
		const callCount = requests.length;
		await command("init", ctx);
		assert.equal(requests.length, callCount, "a complete resumed init must remain current without model calls");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});
