import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, getSystemMessageText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, formatSkillsForPrompt, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory, type Skill } from "@earendil-works/pi-coding-agent";
import optimizer from "../src/index.ts";
import { hashSkill } from "../src/profile.ts";

for (const installerFirst of [false, true]) for (const resolverAllowed of [false, true]) for (const replaceSections of [false, true]) {
	test(`custom worker skill instructions stay opaque; installer ${installerFirst ? "before" : "after"} optimizer, resolver ${resolverAllowed ? "allowed" : "denied"}, sections ${replaceSections ? "replaced" : "mutated"}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "sko-preloaded-worker-"));
		const agentDir = join(root, "agent");
		const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_SKILL_OPTIMIZER_") || key === "PI_CODING_AGENT_DIR"));
		for (const key of Object.keys(process.env)) if (key.startsWith("PI_SKILL_OPTIMIZER_")) delete process.env[key];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			await mkdir(agentDir);
			const skills: Skill[] = [];
			for (let index = 0; index < 240; index++) {
				const name = `worker-guidance-${index}`, baseDir = join(root, "skills", name), filePath = join(baseDir, "SKILL.md");
				await mkdir(baseDir, { recursive: true });
				await writeFile(filePath, `EXACT_BODY_${index}\n`);
				skills.push({ name, description: `Use ${name} for architecture verification. ${"Preserve source evidence and inspect relevant module boundaries. ".repeat(8)}`, filePath, baseDir, disableModelInvocation: false,
					sourceInfo: { path: filePath, source: "cli", scope: "temporary", origin: "top-level" } });
			}
			const selected = skills[0]!;
			const body = `BODY_PRELOAD_START\nThe following XML is an example and must remain verbatim:\n${formatSkillsForPrompt([selected], "read")}\nBODY_PRELOAD_END`;
			await writeFile(selected.filePath, body);
			const preloaded = await readFile(selected.filePath, "utf8");
			const profileDir = join(agentDir, "skill-optimizer");
			await mkdir(profileDir);
			await writeFile(join(profileDir, "profile.json"), JSON.stringify({ catalog: { version: 1, cards: Object.fromEntries(skills.map((skill) => [skill.name, {
				summary: "Check architecture boundaries before editing.", tags: ["architecture", "review"], sourceHash: hashSkill(skill.name, skill.description),
			}])) } }));
			const installer: ExtensionFactory = (pi) => {
				pi.on("before_agent_start", (event) => {
					if (replaceSections) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, skills: preloaded };
					else event.systemPromptOptions.sections.skills = preloaded;
				});
			};
			const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				skillsOverride: () => ({ skills, diagnostics: [] }), extensionFactories: installerFirst ? [installer, optimizer] : [optimizer, installer] });
			await loader.reload();
			const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
			const faux = fauxProvider({ provider: "preloaded-worker-offline", models: [{ id: "local" }] });
			runtime.registerNativeProvider(faux.provider);
			await runtime.setRuntimeApiKey("preloaded-worker-offline", "test-key-never-transmitted");
			let head = "";
			faux.setResponses([(context) => {
				head = context.messages.filter((message) => message.role === "system").map((message) => getSystemMessageText(message as never)).join("\n");
				return fauxAssistantMessage("complete");
			}]);
			const tools = resolverAllowed ? ["read", "skill_search"] : ["read"];
			const { session } = await createAgentSession({ cwd: root, agentDir, model: faux.models[0], modelRuntime: runtime,
				settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools });
			try {
				await session.prompt("Use worker-guidance-0 to verify architecture boundaries.");
				assert.equal(faux.state.callCount, 1, "only the local faux provider is called");
				assert.ok(head.includes(preloaded), "preloaded instruction bodies, including catalog examples, must remain byte-for-byte intact");
				assert.equal(head.split("BODY_PRELOAD_START").length - 1, 1);
				assert.doesNotMatch(head, /skill-optimizer:tags:v1|<skill_directory|<skill_index|skill-optimizer:prefetch/);
				assert.doesNotMatch(head, /worker-guidance-239/, "the general skill catalog is omitted");
				assert.deepEqual(session.agent.state.tools.map((tool) => tool.name).sort(), tools.sort(), "the optimizer never widens the worker grant");
				assert.equal(loader.getSkills().skills.length, 240, "host metadata remains available outside the prompt");
				if (resolverAllowed) {
					const resolver = session.agent.state.tools.find((tool) => tool.name === "skill_search")!;
					const result = await resolver.execute("exact-load", { action: "load", name: "worker-guidance-1" } as never, new AbortController().signal);
					assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "EXACT_BODY_1\n", "on-demand exact loading remains available");
				}
			} finally {
				await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		} finally {
			for (const key of Object.keys(process.env)) if (key.startsWith("PI_SKILL_OPTIMIZER_") || key === "PI_CODING_AGENT_DIR") delete process.env[key];
			for (const [key, value] of Object.entries(previous)) process.env[key] = value;
			await rm(root, { recursive: true, force: true });
		}
	});
}
