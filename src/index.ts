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
import { dirname } from "node:path";
import { setUserAliasCandidates } from "./aliases.ts";
import { ensureGlobalConfigTemplate, getConfig, getConfigPaths, getPinnedTopK, getProfilePaths, getScopeProviders, getUsageFilePath, isDisabled } from "./config.ts";
import { optimize } from "./optimize.ts";
import { diffSkills, EMPTY_PROFILE, mergeIncrementalProfile, mergeProfiles, normalizeProfile, pruneProfileNames, splitProfileByScope, type SkillOptimizerProfile } from "./profile.ts";
import { normalizeUsageFile, recordSkillUsage, selectPinnedSkills, selectUsageRecordSkills, toUsageFile, usageRecordSignature, type SkillUsageStats } from "./usage.ts";

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
		const { next, removed, selected, droppedTools } = optimize(event.payload, config);
		if (removed > 0) {
			lastRemovedChars = removed;
			lastSelected = selected;
			lastDroppedTools = droppedTools.length;
			setStatus(ctx, `✂ −${approxK(removed)} tok`);
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

	pi.on("session_shutdown", (_event, ctx) => {
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
			const lines = [
				"pi-skill-optimizer",
				`  enabled:        ${isDisabled(ctx.cwd) ? "no (disabled)" : "yes"}`,
				`  config:         ${configLocations}`,
				`  skills mode:    ${config.mode}${config.mode === "hybrid" ? ` (top ${config.topK}, tail ${config.tail})` : ""}`,
				`  tools mode:     ${config.toolsMode}${config.toolsMode === "drop" ? ` (${config.toolsDropPrefixes.join(", ") || "no prefixes set"})` : config.toolsMode === "relevance" ? ` (top ${config.toolsTopK} + core + used)` : ""}`,
				`  scope:          ${providers ? providers.join(", ") : "all providers"}`,
				`  profile:        ${profileSummary(activeProfile)} (${profileLocations})`,
				`  pinned:         ${selectPinnedSkills(usageStats, getPinnedTopK(ctx.cwd)).join(", ") || "none"} (${usageCount(usageStats)} tracked, ${usagePath})`,
				`  last request:   −${approxK(lastRemovedChars)} tokens (${lastRemovedChars} chars), ${lastDroppedTools} tools dropped`,
			];
			if (config.alwaysFull && config.alwaysFull.length > 0) lines.push(`  always full:    ${config.alwaysFull.join(", ")}`);
			if (config.never && config.never.length > 0) lines.push(`  never:          ${config.never.join(", ")}`);
			if (lastSelected.length > 0) lines.push(`  last relevant:  ${lastSelected.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
