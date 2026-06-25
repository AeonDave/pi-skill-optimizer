/**
 * pi-skill-optimizer — a Pi extension that slims the system prompt before each
 * request to cut input-token cost.
 *
 * Pi inlines an `<available_skills>` catalog (one entry per installed skill) into
 * the system prompt of every request. With a large skills install this is the
 * single biggest input-token cost and it repeats every turn. Rather than nuking
 * it, this extension rewrites it (see skills.ts):
 *   - `hybrid` (default): keep relevant skills at full description and keep a
 *      short, loadable tail for missed skills.
 *   - `compact`: keep every skill, trim each description to its intent sentence.
 *   - `strip`: remove the catalog entirely (maximum savings, no discovery).
 *
 * Provider-agnostic by default; scope with `PI_SKILL_OPTIMIZER_PROVIDERS`.
 * Pi has no `Skill` tool: the model loads a skill by `read`-ing its `<location>`,
 * so trimming the catalog affects only *proactive* discovery. Explicit
 * `/skill:name` invocation expands from Pi's on-disk skill registry before the
 * request is built (catalog-independent), so it always works.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setUserAliasCandidates } from "./aliases.ts";
import { ensureGlobalConfigTemplate, getConfig, getConfigPaths, getOutputConfig, getPinnedTopK, getProfilePaths, getScopeProviders, getStatsFilePath, getUsageFilePath, isDisabled } from "./config.ts";
import { buildExtractPrompt, isExcludedCommand, mergeExtracted, reduceOutput, signalLines } from "./output.ts";
import { optimize } from "./optimize.ts";
import { diffSkills, EMPTY_PROFILE, mergeIncrementalProfile, mergeProfiles, normalizeProfile, pruneProfileNames, splitProfileByScope, type SkillOptimizerProfile } from "./profile.ts";
import { normalizeUsageFile, recordSkillUsage, selectPinnedSkills, selectUsageRecordSkills, toUsageFile, usageRecordSignature, type SkillUsageStats } from "./usage.ts";
import { addSavings, EMPTY_SAVINGS, normalizeStatsFile, type SavingsByArea, toStatsFile, totalSavings } from "./stats.ts";

const STATUS_KEY = "skill-optimizer";

/**
 * Bump when the init prompt or profile semantics change so an updated tool forces
 * a full regeneration instead of an incremental (hash-based) update.
 */
const INIT_VERSION = 3;

/** Approximate tokens from a char count (~4 chars/token), rounded to 0.1k. */
function approxK(chars: number): string {
	return `${Math.round(chars / 400) / 10}k`;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// Status badge is cosmetic — never let it break the session.
	}
}

function responseText(response: { content?: Array<{ type?: string; text?: string }> }): string {
	return (response.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/** Latest user request text on the active branch (for `extract` mode). Best-effort. */
function latestUserText(ctx: ExtensionContext): string {
	try {
		const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const c = entry.message.content;
			if (typeof c === "string") return c.slice(0, 2000);
			if (Array.isArray(c)) {
				const t = c
					.filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
					.map((b) => b.text)
					.join(" ")
					.trim();
				if (t) return t.slice(0, 2000);
			}
		}
	} catch {
		// best-effort
	}
	return "";
}

/** Resolve the `extract` model spec ("provider/id" or bare id) against the registry. */
function resolveOutputModel(ctx: ExtensionContext, spec: string): unknown {
	try {
		// No explicit model -> use the currently selected model.
		if (!spec) return ctx.model ?? undefined;
		const reg = ctx.modelRegistry as { find?: (provider: string, id: string) => unknown };
		if (typeof reg?.find !== "function") return ctx.model ?? undefined;
		if (spec.includes("/")) {
			const i = spec.indexOf("/");
			return reg.find(spec.slice(0, i), spec.slice(i + 1)) ?? ctx.model ?? undefined;
		}
		const provider = ctx.model?.provider;
		if (!provider) return undefined;
		return reg.find(provider, spec) ?? ctx.model ?? undefined;
	} catch {
		return undefined;
	}
}

/** Intelligent-grep extraction via a weak model. Returns undefined on any failure (fail-open). */
async function tryExtractOutput(ctx: ExtensionContext, spec: string, request: string, command: string, text: string): Promise<string | undefined> {
	try {
		const model = resolveOutputModel(ctx, spec);
		if (!model) return undefined;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Parameters<typeof ctx.modelRegistry.getApiKeyAndHeaders>[0]);
		if (!auth.ok || !auth.apiKey) return undefined;
		const { system, user } = buildExtractPrompt(request, command, text);
		const message: UserMessage = { role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() };
		const response = await complete(
			model as Parameters<typeof complete>[0],
			{ systemPrompt: system, messages: [message] },
			{ apiKey: auth.apiKey, headers: auth.headers },
		);
		const extracted = responseText(response).trim();
		if (!extracted) return undefined;
		const merged = mergeExtracted(extracted, signalLines(text));
		if (!merged || merged.length >= text.length) return undefined;
		return merged;
	} catch {
		return undefined;
	}
}

function stripCodeFences(text: string): string {
	const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)```\s*$/i);
	if (fenced) return fenced[1];
	return text;
}

/** Parse the model's JSON profile, tolerating code fences, comments, and trailing commas. */
function parseJsonObject(text: string): unknown {
	let cleaned = stripCodeFences(text).trim();
	// collapse multi-line strings into single lines (newlines are not valid JSON string chars)
	cleaned = cleaned.replace(/"((?:[^"\\]|\\.)*)"/g, (m) =>
		m.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"),
	);
	// strip // line comments
	cleaned = cleaned.replace(/\/\/.*$/gm, "");
	// strip /* */ block comments
	cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
	// remove trailing commas before } or ]
	cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("model response did not contain a JSON object");
	return JSON.parse(cleaned.slice(start, end + 1));
}

function profileSummary(profile: SkillOptimizerProfile): string {
	return `${Object.keys(profile.aliases).length} aliases, ${profile.critical.length} critical, ${Object.keys(profile.queries).length} query sets`;
}

interface StoredProfile {
	profile: SkillOptimizerProfile;
	hashes: Record<string, string>;
	initVersion: number;
}

function sanitizeHashes(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [name, hash] of Object.entries(value as Record<string, unknown>)) {
		if (typeof hash === "string" && hash) out[name] = hash;
	}
	return out;
}

function readStoredProfile(path: string): StoredProfile {
	if (!existsSync(path)) return { profile: EMPTY_PROFILE, hashes: {}, initVersion: 0 };
	const raw = JSON.parse(readFileSync(path, "utf8")) as { skillHashes?: unknown; initVersion?: unknown };
	return {
		profile: normalizeProfile(raw),
		hashes: sanitizeHashes(raw.skillHashes),
		initVersion: typeof raw.initVersion === "number" ? raw.initVersion : 0,
	};
}

/** Load global + project profiles and merge them (project extends global). */
function loadMergedProfile(paths: { global: string; project: string }): SkillOptimizerProfile {
	const globalProfile = readStoredProfile(paths.global).profile;
	const projectProfile = paths.project === paths.global ? EMPTY_PROFILE : readStoredProfile(paths.project).profile;
	const merged = mergeProfiles(globalProfile, projectProfile);
	setUserAliasCandidates(merged.aliases);
	return merged;
}

function writeProfileFile(
	path: string,
	profile: SkillOptimizerProfile,
	skillCount: number,
	hashes: Record<string, string>,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const body = { version: 2, initVersion: INIT_VERSION, generatedAt: new Date().toISOString(), skillCount, ...profile, skillHashes: hashes };
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function pickKeys(record: Record<string, string>, keep: (name: string) => boolean): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(record)) {
		if (keep(name)) out[name] = value;
	}
	return out;
}

function usageCount(stats: SkillUsageStats): number {
	return Object.keys(stats).length;
}

function loadUsageFile(path: string): SkillUsageStats {
	if (!existsSync(path)) return {};
	return normalizeUsageFile(JSON.parse(readFileSync(path, "utf8")));
}

function saveUsageFile(path: string, stats: SkillUsageStats): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(toUsageFile(stats), null, 2)}\n`, "utf8");
}

export default function skillOptimizer(pi: ExtensionAPI) {
	let lastRemovedChars = 0;
	let lastSelected: string[] = [];
	let lastDroppedTools = 0;
	let loadedProfilePath: string | undefined;
	let loadedUsagePath: string | undefined;
	let activeProfile: SkillOptimizerProfile = EMPTY_PROFILE;
	let usageStats: SkillUsageStats = {};
	let lastUsageRecordSignature = "";

	// Granular savings telemetry (chars removed per area).
	let sessionSaved: SavingsByArea = { ...EMPTY_SAVINGS };
	let baseLifetime: SavingsByArea = { ...EMPTY_SAVINGS };
	let loadedStatsPath: string | undefined;
	let lastFlushAt = 0;
	const ensureStatsLoaded = (ctx: ExtensionContext): string => {
		const path = getStatsFilePath(ctx.cwd);
		if (path !== loadedStatsPath) {
			try {
				baseLifetime = existsSync(path) ? normalizeStatsFile(JSON.parse(readFileSync(path, "utf8"))) : { ...EMPTY_SAVINGS };
			} catch {
				baseLifetime = { ...EMPTY_SAVINGS };
			}
			loadedStatsPath = path;
		}
		return path;
	};
	const flushStats = (): void => {
		if (!loadedStatsPath || totalSavings(sessionSaved) === 0) return;
		try {
			mkdirSync(dirname(loadedStatsPath), { recursive: true });
			writeFileSync(loadedStatsPath, `${JSON.stringify(toStatsFile(addSavings(baseLifetime, sessionSaved)), null, 2)}\n`, "utf8");
		} catch {
			// telemetry is best-effort; never disrupt the session
		}
	};

	const ensureStateLoaded = (ctx: ExtensionContext): void => {
		const profilePaths = getProfilePaths(ctx.cwd);
		const profileKey = `${profilePaths.global}::${profilePaths.project}`;
		if (profileKey !== loadedProfilePath) {
			try {
				activeProfile = loadMergedProfile(profilePaths);
				loadedProfilePath = profileKey;
			} catch (err) {
				activeProfile = EMPTY_PROFILE;
				setUserAliasCandidates({});
				loadedProfilePath = profileKey;
				ctx.ui.notify(`skill-optimizer: failed to load profile (${(err as Error).message})`, "warning");
			}
		}
		const usagePath = getUsageFilePath(ctx.cwd);
		if (usagePath === loadedUsagePath) return;
		try {
			usageStats = loadUsageFile(usagePath);
			loadedUsagePath = usagePath;
		} catch (err) {
			usageStats = {};
			loadedUsagePath = usagePath;
			ctx.ui.notify(`skill-optimizer: failed to load usage stats (${(err as Error).message})`, "warning");
		}
	};

	const initAliases = async (ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]): Promise<void> => {
		if (!ctx.model) {
			ctx.ui.notify("skill-optimizer: no model selected", "error");
			return;
		}
		const skills = ctx.getSystemPromptOptions().skills ?? [];
		if (skills.length === 0) {
			ctx.ui.notify("skill-optimizer: no skills available in current prompt options", "warning");
			return;
		}

		const paths = getProfilePaths(ctx.cwd);
		const stored = readStoredProfile(paths.global);
		const projectStored = paths.project !== paths.global && existsSync(paths.project)
			? readStoredProfile(paths.project)
			: undefined;
		const baseProfile = projectStored ? mergeProfiles(stored.profile, projectStored.profile) : stored.profile;
		const storedHashes = projectStored ? { ...stored.hashes, ...projectStored.hashes } : stored.hashes;

		// A tool/prompt upgrade (INIT_VERSION bump) forces a full regeneration; otherwise
		// only new/modified skills are sent to the model and removed ones are pruned.
		const forceFull = !existsSync(paths.global) || stored.initVersion !== INIT_VERSION;
		const { changed, removed, hashes } = diffSkills(
			skills.map((skill) => ({ name: skill.name, description: skill.description })),
			forceFull ? {} : storedHashes,
		);

		if (!forceFull && changed.length === 0 && removed.length === 0) {
			ctx.ui.notify(`skill-optimizer: profile already up to date (${skills.length} skills)`, "info");
			return;
		}

		let partial: SkillOptimizerProfile = EMPTY_PROFILE;
		if (changed.length > 0) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify(`skill-optimizer: ${auth.ok ? `no API key for ${ctx.model.provider}` : auth.error}`, "error");
				return;
			}
			const changedSet = new Set(changed);
			const targetSkills = skills.filter((skill) => changedSet.has(skill.name));
			const skillLines = targetSkills
				.map((skill) => `- ${skill.name}: ${skill.description.slice(0, 240)}`)
				.join("\n");
			const systemPrompt = [
				"You generate a compact JSON retrieval profile for lexical skill retrieval.",
				"Return only JSON. No markdown.",
				"Schema: {\"aliases\":{\"query_token\":[\"catalog_token\"]},\"critical\":[\"skill-name\"],\"queries\":{\"skill-name\":[\"example user query\"]},\"clusters\":{\"topic\":[\"skill-name\"]},\"negativeHints\":{\"skill-name\":[\"misleading query\"]}}.",
				"aliases: keys are lowercase single query tokens; values are lowercase single tokens that appear in skill names/descriptions.",
				"critical = the ALWAYS-ON skills that define HOW to work in essentially every session, because lexical ranking can never surface them from a task query. Two kinds belong here:",
				"  1) cross-cutting engineering discipline (planning, debugging, testing, verification, evidence, code guidelines, context handling);",
				"  2) general operator-mode skills whose description sets default conduct (e.g. one described as 'structured operator behaviour that forces explicit reasoning/verification/safety').",
				"critical MUST EXCLUDE opt-in or triggered skills even if they call themselves a 'Mode': anything whose description says it triggers on a /command or subcommands, is 'used when the user wants X', assumes external setup/tools, or is domain/security/language/tool-specific. Those get query examples instead.",
				"Example: an operator-discipline mode that 'forces explicit reasoning and verification' is critical; a '/notes' or '/vault' mode that 'triggers on /x and assumes an external app' is NOT critical.",
				"queries: 2-4 realistic short user queries per high-value, creator/framework, or ambiguous skill; include common synonyms users may say (for example plugin vs extension).",
				"clusters: group skills users may confuse or often use together.",
				"negativeHints: queries that look similar but should not select that skill.",
				"Keep output compact: at most 140 aliases, 16 critical skills, and 140 skills with query examples.",
				...(forceFull ? [] : ["These skills are NEW or MODIFIED in an existing setup. Output entries ONLY for them, using the same schema."]),
			].join("\n");
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: `Skills:\n${skillLines}` }],
				timestamp: Date.now(),
			};
			ctx.ui.notify(`skill-optimizer: ${forceFull ? "regenerating" : "updating"} profile for ${targetSkills.length} skill(s) with ${ctx.model.id}...`, "info");
			const response = await complete(
				ctx.model,
				{ systemPrompt, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers },
			);
			if (response.stopReason !== "stop") {
				ctx.ui.notify(`skill-optimizer: profile generation stopped with ${response.stopReason}`, "warning");
			}
			partial = normalizeProfile(parseJsonObject(responseText(response)));
		}

		const profile = mergeIncrementalProfile(pruneProfileNames(forceFull ? EMPTY_PROFILE : baseProfile, removed), partial, changed);
		const newCount = changed.filter((name) => !(name in storedHashes)).length;
		const summary = `${forceFull ? "full" : "incremental"}: +${newCount} new, ~${changed.length - newCount} changed, -${removed.length} removed`;
		const projectNames = new Set(
			skills
				.filter((skill) => (skill as { sourceInfo?: { scope?: string } }).sourceInfo?.scope === "project")
				.map((skill) => skill.name),
		);
		const splitEnabled = paths.project !== paths.global && projectNames.size > 0;

		if (!splitEnabled) {
			writeProfileFile(paths.global, profile, skills.length, hashes);
			activeProfile = profile;
			setUserAliasCandidates(profile.aliases);
			loadedProfilePath = `${paths.global}::${paths.project}`;
			ctx.ui.notify(`skill-optimizer: ${summary}; ${profileSummary(profile)} → ${paths.global}`, "info");
			return;
		}

		const { global: globalProfile, project: projectProfile } = splitProfileByScope(profile, projectNames);
		const globalHashes = pickKeys(hashes, (name) => !projectNames.has(name));
		const projectHashes = pickKeys(hashes, (name) => projectNames.has(name));
		writeProfileFile(paths.global, globalProfile, Object.keys(globalHashes).length, globalHashes);
		writeProfileFile(paths.project, projectProfile, Object.keys(projectHashes).length, projectHashes);
		activeProfile = mergeProfiles(globalProfile, projectProfile);
		setUserAliasCandidates(activeProfile.aliases);
		loadedProfilePath = `${paths.global}::${paths.project}`;
		ctx.ui.notify(`skill-optimizer: ${summary}; global ${profileSummary(globalProfile)}, project ${profileSummary(projectProfile)}`, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			const created = ensureGlobalConfigTemplate();
			if (created) ctx.ui.notify(`skill-optimizer: wrote default config to ${created} (edit to configure)`, "info");
		} catch {
			// non-fatal: config template is a convenience
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (isDisabled(ctx.cwd)) return;
		const providers = getScopeProviders(ctx.cwd);
		if (providers && ctx.model && !providers.includes(ctx.model.provider)) return;
		ensureStateLoaded(ctx);

		const config = {
			...getConfig(ctx.cwd),
			profile: activeProfile,
			pinnedSkills: selectPinnedSkills(usageStats, getPinnedTopK(ctx.cwd)),
		};
		ensureStatsLoaded(ctx);
		const { next, removed, removedSkills, removedTools, selected, droppedTools } = optimize(event.payload, config);
		if (removed > 0) {
			lastRemovedChars = removed;
			lastSelected = selected;
			lastDroppedTools = droppedTools.length;
			sessionSaved.skills += removedSkills;
			sessionSaved.tools += removedTools;
			setStatus(ctx, `✂ −${approxK(removed)} tok`);
		}
		// Persist telemetry periodically so it survives even without a clean shutdown.
		if (Date.now() - lastFlushAt > 15_000 && totalSavings(sessionSaved) > 0) {
			lastFlushAt = Date.now();
			flushStats();
		}
		const messages = (event.payload as { messages?: unknown })?.messages;
		const recordable = selectUsageRecordSkills(messages, selected);
		const recordSignature = usageRecordSignature(messages, recordable);
		if (recordable.length > 0 && loadedUsagePath && recordSignature !== lastUsageRecordSignature) {
			lastUsageRecordSignature = recordSignature;
			usageStats = recordSkillUsage(usageStats, recordable);
			try {
				saveUsageFile(loadedUsagePath, usageStats);
			} catch (err) {
				ctx.ui.notify(`skill-optimizer: failed to save usage stats (${(err as Error).message})`, "warning");
			}
		}
		return next === event.payload ? undefined : next;
	});

	// Transparent tool-output reduction: shrink noisy tool results (e.g. bash) once,
	// at production time. `smart` = deterministic head/tail/error keep; `extract` =
	// query-aware "intelligent grep" via a weak same-provider model (fails open to
	// `smart`). Errors stay verbatim and the full output is saved to a temp file.
	// Off by default; opt in via config `outputMode`.
	const saveFullOutput = (text: string): string => {
		try {
			const file = join(tmpdir(), `sko-output-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
			writeFileSync(file, text, "utf8");
			return `; full output: ${file}`;
		} catch {
			return "";
		}
	};

	pi.on("tool_result", async (event, ctx) => {
		if (isDisabled(ctx.cwd)) return;
		const outCfg = getOutputConfig(ctx.cwd);
		if (outCfg.mode === "off") return;
		const toolName = String(event.toolName ?? "").toLowerCase();
		if (!outCfg.tools.some((t) => t.toLowerCase() === toolName)) return;
		const evt = event as { content?: unknown; input?: unknown };
		const content = evt.content;
		if (!Array.isArray(content)) return;

		const rawInput = evt.input;
		const command = rawInput && typeof rawInput === "object" && typeof (rawInput as { command?: unknown }).command === "string"
			? (rawInput as { command: string }).command
			: "";
		const request = outCfg.mode === "extract" ? latestUserText(ctx) : "";
		ensureStatsLoaded(ctx);

		let changed = false;
		const next: typeof content = [];
		for (const block of content) {
			if (!block || typeof block !== "object") { next.push(block); continue; }
			const b = block as { type?: unknown; text?: unknown };
			if (b.type !== "text" || typeof b.text !== "string") { next.push(block); continue; }
			const text = b.text;
			if (text.split(/\r?\n/).length <= outCfg.maxLines && text.length <= 16_000) { next.push(block); continue; }

			let body: string | undefined;
			let how = "reduced";
			if (outCfg.mode === "extract" && !isExcludedCommand(command, outCfg.extractExclude)) {
				const extracted = await tryExtractOutput(ctx, outCfg.model, request, command, text);
				if (extracted) { body = extracted; how = "extracted"; }
			}
			if (body === undefined) {
				const r = reduceOutput(text, { maxLines: outCfg.maxLines });
				if (!r.reduced) { next.push(block); continue; }
				body = r.text;
			}
			changed = true;
			if (text.length > body.length) sessionSaved.output += text.length - body.length;
			const fromLines = text.split(/\r?\n/).length;
			const note = `${how} ${fromLines}\u2192${body.split(/\r?\n/).length} lines (${approxK(text.length)}\u2192${approxK(body.length)} tok)${saveFullOutput(text)}`;
			next.push({ ...b, text: `${body}\n[skill-optimizer: ${note}]` });
		}
		if (!changed) return;
		return { content: next };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		flushStats();
		setStatus(ctx, undefined);
	});

	pi.registerCommand("skill-optimizer", {
		description: "Diagnostics for the skill optimizer; use `/skill-optimizer init` to generate alias hints",
		handler: async (args, ctx) => {
			if (args.trim() === "init") {
				await initAliases(ctx);
				return;
			}
			ensureStateLoaded(ctx);
			const config = getConfig(ctx.cwd);
			const providers = getScopeProviders(ctx.cwd);
			const profilePaths = getProfilePaths(ctx.cwd);
			const profileLocations = profilePaths.project === profilePaths.global
				? profilePaths.global
				: `global ${profilePaths.global}${existsSync(profilePaths.project) ? `, project ${profilePaths.project}` : ""}`;
			const configPaths = getConfigPaths(ctx.cwd);
			const configLocations = `${existsSync(configPaths.global) ? configPaths.global : `${configPaths.global} (missing)`}${existsSync(configPaths.project) ? `, project ${configPaths.project}` : ""}`;
			const usagePath = getUsageFilePath(ctx.cwd);
			ensureStatsLoaded(ctx);
			const lifetime = addSavings(baseLifetime, sessionSaved);
			const byArea = (s: SavingsByArea): string => `skills ~${approxK(s.skills)}, tools ~${approxK(s.tools)}, output ~${approxK(s.output)} (total ~${approxK(totalSavings(s))})`;
			const lines = [
				"pi-skill-optimizer",
				`  enabled:        ${isDisabled(ctx.cwd) ? "no (disabled)" : "yes"}`,
				`  config:         ${configLocations}`,
				`  skills mode:    ${config.mode}${config.mode === "hybrid" ? ` (top ${config.topK}, tail ${config.tail})` : ""}`,
				`  tools mode:     ${config.toolsMode}${config.toolsMode === "drop" ? ` (${config.toolsDropPrefixes.join(", ") || "no prefixes set"})` : config.toolsMode === "relevance" ? ` (top ${config.toolsTopK} + core + used)` : ""}`,
				`  output mode:    ${(() => { const o = getOutputConfig(ctx.cwd); return o.mode === "off" ? "off" : `${o.mode} (>${o.maxLines} lines; tools: ${o.tools.join(", ")})`; })()}`,
				`  scope:          ${providers ? providers.join(", ") : "all providers"}`,
				`  profile:        ${profileSummary(activeProfile)} (${profileLocations})`,
				`  pinned:         ${selectPinnedSkills(usageStats, getPinnedTopK(ctx.cwd)).join(", ") || "none"} (${usageCount(usageStats)} tracked, ${usagePath})`,
				`  saved (session): ${byArea(sessionSaved)}`,
				`  saved (lifetime):${byArea(lifetime)}`,
				`  last request:   −${approxK(lastRemovedChars)} tokens (${lastRemovedChars} chars), ${lastDroppedTools} tools dropped`,
			];
			flushStats();
			if (config.alwaysFull && config.alwaysFull.length > 0) lines.push(`  always full:    ${config.alwaysFull.join(", ")}`);
			if (config.never && config.never.length > 0) lines.push(`  never:          ${config.never.join(", ")}`);
			if (lastSelected.length > 0) lines.push(`  last relevant:  ${lastSelected.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
