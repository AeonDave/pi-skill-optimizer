/**
 * pi-skill-optimizer — a Pi extension that slims the system prompt before each
 * request to cut input-token cost.
 *
 * Pi inlines an `<available_skills>` catalog (one entry per installed skill) into
 * the system prompt of every request. With a large skills install this is the
 * single biggest input-token cost and it repeats every turn. Rather than nuking
 * it, this extension rewrites it (see skills.ts):
 *   - `hybrid` (default): keep the skills relevant to the request's query at full
 *      description, compact the long tail — nothing becomes undiscoverable.
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
import { getUserAliasCandidates, setUserAliasCandidates } from "./aliases.ts";
import { getConfig, getPinnedTopK, getProfileFilePath, getScopeProviders, getUsageFilePath, isDisabled } from "./config.ts";
import { optimize } from "./optimize.ts";
import { EMPTY_PROFILE, normalizeProfile, type SkillOptimizerProfile } from "./profile.ts";
import { normalizeUsageFile, recordSkillUsage, selectPinnedSkills, selectUsageRecordSkills, toUsageFile, usageRecordSignature, type SkillUsageStats } from "./usage.ts";

const STATUS_KEY = "skill-optimizer";

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

function parseJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("model response did not contain a JSON object");
	return JSON.parse(text.slice(start, end + 1));
}

function aliasCount(profile: SkillOptimizerProfile): number {
	return Object.keys(profile.aliases).length || Object.keys(getUserAliasCandidates()).length;
}

function profileSummary(profile: SkillOptimizerProfile): string {
	return `${aliasCount(profile)} aliases, ${profile.critical.length} critical, ${Object.keys(profile.queries).length} query sets`;
}

function loadProfileFile(path: string): SkillOptimizerProfile {
	if (!existsSync(path)) {
		setUserAliasCandidates({});
		return EMPTY_PROFILE;
	}
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	const profile = normalizeProfile(parsed);
	setUserAliasCandidates(profile.aliases);
	return profile;
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
		const profilePath = getProfileFilePath(ctx.cwd);
		if (profilePath !== loadedProfilePath) {
			try {
				activeProfile = loadProfileFile(profilePath);
				loadedProfilePath = profilePath;
			} catch (err) {
				activeProfile = EMPTY_PROFILE;
				setUserAliasCandidates({});
				loadedProfilePath = profilePath;
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

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(`skill-optimizer: ${auth.ok ? `no API key for ${ctx.model.provider}` : auth.error}`, "error");
			return;
		}

		const skillLines = skills
			.map((skill) => `- ${skill.name}: ${skill.description.slice(0, 240)}`)
			.join("\n");
		const systemPrompt = [
			"You generate a compact JSON retrieval profile for lexical skill retrieval.",
			"Return only JSON. No markdown.",
			"Schema: {\"aliases\":{\"query_token\":[\"catalog_token\"]},\"critical\":[\"skill-name\"],\"queries\":{\"skill-name\":[\"example user query\"]},\"clusters\":{\"topic\":[\"skill-name\"]},\"negativeHints\":{\"skill-name\":[\"misleading query\"]}}.",
			"aliases: keys are lowercase single query tokens; values are lowercase single tokens that appear in skill names/descriptions.",
			"critical: only skills that are broadly foundational or commonly needed and should not be reduced to name-only.",
			"queries: 2-4 realistic short user queries per high-value or ambiguous skill.",
			"clusters: group skills users may confuse or often use together.",
			"negativeHints: queries that look similar but should not select that skill.",
			"Keep output compact: at most 120 aliases, 30 critical skills, and 120 skills with query examples.",
		].join("\n");
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: `Skills:\n${skillLines}` }],
			timestamp: Date.now(),
		};

		ctx.ui.notify(`skill-optimizer: generating retrieval profile for ${skills.length} skills with ${ctx.model.id}...`, "info");
		const response = await complete(
			ctx.model,
			{ systemPrompt, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers },
		);
		if (response.stopReason !== "stop") {
			ctx.ui.notify(`skill-optimizer: alias generation stopped with ${response.stopReason}`, "warning");
		}

		const parsed = parseJsonObject(responseText(response));
		const profile = normalizeProfile(parsed);
		const path = getProfileFilePath(ctx.cwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), skillCount: skills.length, ...profile }, null, 2)}\n`,
			"utf8",
		);
		activeProfile = profile;
		setUserAliasCandidates(profile.aliases);
		loadedProfilePath = path;
		ctx.ui.notify(`skill-optimizer: wrote ${profileSummary(profile)} to ${path}`, "info");
	};

	pi.on("before_provider_request", (event, ctx) => {
		if (isDisabled()) return;
		const providers = getScopeProviders();
		if (providers && ctx.model && !providers.includes(ctx.model.provider)) return;
		ensureStateLoaded(ctx);

		const config = {
			...getConfig(),
			profile: activeProfile,
			pinnedSkills: selectPinnedSkills(usageStats, getPinnedTopK()),
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
			const config = getConfig();
			const providers = getScopeProviders();
			const profilePath = getProfileFilePath(ctx.cwd);
			const usagePath = getUsageFilePath(ctx.cwd);
			const lines = [
				"pi-skill-optimizer",
				`  enabled:        ${isDisabled() ? "no (PI_SKILL_OPTIMIZER_DISABLE set)" : "yes"}`,
				`  skills mode:    ${config.mode}${config.mode === "hybrid" ? ` (top ${config.topK}, adaptive ${config.adaptiveTopK ? `${config.minTopK}-${config.maxTopK}` : "off"}, tail ${config.tailChars} chars)` : ""}`,
				`  tools mode:     ${config.toolsMode}${config.toolsMode === "drop" ? ` (${config.toolsDropPrefixes.join(", ") || "no prefixes set"})` : config.toolsMode === "relevance" ? ` (top ${config.toolsTopK} + core + used)` : ""}`,
				`  scope:          ${providers ? providers.join(", ") : "all providers"}`,
				`  profile:        ${profileSummary(activeProfile)} (${profilePath})`,
				`  pinned:         ${selectPinnedSkills(usageStats, getPinnedTopK()).join(", ") || "none"} (${usageCount(usageStats)} tracked, ${usagePath})`,
				`  last request:   −${approxK(lastRemovedChars)} tokens (${lastRemovedChars} chars), ${lastDroppedTools} tools dropped`,
			];
			if (lastSelected.length > 0) lines.push(`  last relevant:  ${lastSelected.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
