import type { ExtensionAPI, ExtensionContext, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	ensureGlobalConfigTemplate,
	getConfig,
	getConfigPaths,
	getOutputConfig,
	getProfilePaths,
	getStatsFilePath,
	getUsageConfig,
	getUsageFilePath,
	isDisabled,
} from "./config.ts";
import {
	batchSkillsByWeight,
	generateProfileInBatches,
	interpretBatchResponse,
	isRetryableBatchException,
	responseText,
} from "./generate.ts";
import { deduplicateToolResultHistory, type HistoryArtifact } from "./history.ts";
import {
	buildInitCatalogKey,
	buildInitNoticeKey,
	buildInitReadiness,
	INIT_READINESS_ENTRY_TYPE,
	readInitNoticeKeys,
	type InitNoticeStatus,
	type InitReadiness,
	type InitReadinessInput,
} from "./init-readiness.ts";
import { buildInitProfileWrites, needsProfileScopeRepair } from "./init-profile.ts";
import { INIT_PROFILE_PROMPT, INIT_PROFILE_VERSION } from "./init-prompt.ts";
import { optimizePayload } from "./optimize.ts";
import {
	buildExtractPrompt,
	hasMinimumSavings,
	isExcludedCommand,
	isRtkSource,
	reduceJsonArrayColumnar,
	reduceOutput,
	shouldReduceToolResult,
	utf8ByteLength,
	validateExtractedOutput,
	type ExtractRejectionReason,
} from "./output.ts";
import {
	cleanupTemporaryOutputs,
	ConcurrentFileUpdateError,
	fileExists,
	loadStatsSnapshot,
	loadUsageFile,
	pruneUsageFile,
	readStoredProfile,
	resolveTemporaryOutput,
	saveStatsDeltas,
	saveTemporaryOutput,
	saveUsageDelta,
	writeProfileFiles,
	type SavedStats,
	type StoredProfile,
} from "./persistence.ts";
import {
	computeFinalHashes,
	diffSkills,
	EMPTY_PROFILE,
	mergeIncrementalProfile,
	mergeProfiles,
	pruneProfileNames,
	type SkillOptimizerProfile,
} from "./profile.ts";
import { sliceOutputLines } from "./output-recovery.ts";
import { createSkillRegistry, type SkillRegistry } from "./skill-loader.ts";
import { auditSkillDescriptions } from "./skills.ts";
import {
	addExtractionTelemetry,
	addProviderCacheTelemetry,
	addSavings,
	EMPTY_EXTRACTION_TELEMETRY,
	EMPTY_PROVIDER_CACHE_TELEMETRY,
	EMPTY_SAVINGS,
	totalSavings,
	type ExtractionTelemetry,
	type ProviderCacheTelemetry,
	type SavingsByArea,
} from "./stats.ts";
import {
	buildToolDiscoveryCatalog,
	planToolActivation,
	searchToolDiscoveryCatalog,
	type ToolDiscoveryCatalog,
} from "./tools.ts";
import {
	buildUsagePrior,
	collectSkillUsageEvidence,
	mergeUsageStats,
	pruneUsageStats,
	recordSkillUsage as updateSkillUsage,
	type SkillUsageStats,
	type UsagePruneOptions,
} from "./usage.ts";

const STATUS_KEY = "skill-optimizer";
const INIT_VERSION = INIT_PROFILE_VERSION;
const INIT_BATCH_MAX_SKILLS = 80;
const INIT_BATCH_MAX_UTF8_BYTES = 32 * 1024;
const INIT_BATCH_MAX_ATTEMPTS = 2;
const FLUSH_INTERVAL_MS = 15_000;
const LOAD_RETRY_MS = 1_000;
const MAX_SEEN_EVIDENCE = 4_096;
const MAX_HISTORY_ARTIFACTS = 128;
const PROTECTED_RUNTIME_TOOLS = ["skill_search", "optimizer_tool_search", "retrieve_output"] as const;
const RESOLVER_RESULT_TOOLS = new Set<string>([...PROTECTED_RUNTIME_TOOLS, "tool_search"]);

function isHostSearchableTool(tool: object): boolean {
	return "exposure" in tool && (tool.exposure === "deferred" || tool.exposure === "codemode");
}

function isHostHiddenTool(tool: object): boolean {
	return "exposure" in tool && tool.exposure === "hidden";
}

type ConfigRecord = ReturnType<typeof getConfig>;

const EMPTY_STORED_PROFILE: StoredProfile = {
	exists: false,
	profile: EMPTY_PROFILE,
	hashes: {},
	initVersion: 0,
	revision: null,
};

interface RuntimeSnapshot {
	cwd: string;
	config: ConfigRecord;
	profile: SkillOptimizerProfile;
	globalStoredProfile: StoredProfile;
	projectStoredProfile?: StoredProfile;
	usage: SkillUsageStats;
	profileKey: string;
	usagePath: string;
	initReadiness?: { catalogKey: string; value: InitReadiness };
}

interface PendingStats {
	savings: SavingsByArea;
	extraction: ExtractionTelemetry;
	cache: ProviderCacheTelemetry;
}

function emptyPendingStats(): PendingStats {
	return {
		savings: { ...EMPTY_SAVINGS },
		extraction: { ...EMPTY_EXTRACTION_TELEMETRY },
		cache: { ...EMPTY_PROVIDER_CACHE_TELEMETRY },
	};
}

function approxK(chars: number): string {
	return `${Math.round(chars / 400) / 10}k`;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// Cosmetic only.
	}
}

function profileSummary(profile: SkillOptimizerProfile): string {
	return `${profile.critical.length} critical, ${Object.keys(profile.queries).length} query sets, ${Object.keys(profile.clusters).length} clusters, ${Object.keys(profile.activation ?? {}).length} activation tags`;
}

function initReadinessSummary(readiness: InitReadiness): string {
	switch (readiness.status) {
		case "empty": return "not initialized";
		case "manual": return "manual profile";
		case "outdated": return "generated profile is outdated";
		case "incomplete": return "generated profile is incomplete";
		case "current": return "current";
	}
}

function usagePruneOptions(snapshot: RuntimeSnapshot): UsagePruneOptions {
	const usage = getUsageConfig(snapshot.config);
	return {
		...usage,
		protectedNames: [
			...snapshot.profile.critical,
			...snapshot.config.alwaysSkills,
		],
	};
}

function skillInputs(skills: readonly PiSkill[]): PiSkill[] {
	const seen = new Set<string>();
	return skills.filter((skill) => {
		if (skill.disableModelInvocation || seen.has(skill.name)) return false;
		seen.add(skill.name);
		return true;
	});
}

function makeSkillRegistry(skills: readonly PiSkill[]): SkillRegistry {
	return createSkillRegistry(skillInputs(skills).map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
	})));
}

function resolveOutputModel(ctx: ExtensionContext, spec: string): unknown {
	if (!spec.trim()) return undefined;
	try {
		const registry = ctx.modelRegistry as { find?: (provider: string, id: string) => unknown };
		if (typeof registry.find !== "function") return undefined;
		if (spec.includes("/")) {
			const separator = spec.indexOf("/");
			return registry.find(spec.slice(0, separator), spec.slice(separator + 1));
		}
		const provider = ctx.model?.provider;
		return provider ? registry.find(provider, spec) : undefined;
	} catch {
		return undefined;
	}
}

async function tryExtractOutput(
	ctx: ExtensionContext,
	spec: string,
	request: string,
	command: string,
	text: string,
): Promise<{ text: string; telemetry: ProviderCacheTelemetry } | undefined> {
	try {
		const model = resolveOutputModel(ctx, spec);
		if (!model) return undefined;
		const prompt = buildExtractPrompt(request, command, text);
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: prompt.user }],
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			model as NonNullable<ExtensionContext["model"]>,
			{ systemPrompt: prompt.system, messages: [message] },
		);
		const extracted = responseText(response).trim();
		return {
			text: extracted,
			telemetry: providerCacheDelta(response.usage),
		};
	} catch {
		return undefined;
	}
}

function providerCacheDelta(usage: {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}): ProviderCacheTelemetry {
	const nonNegative = (value: unknown): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.floor(value)
			: 0;
	return {
		requests: 1,
		input: nonNegative(usage.input),
		output: nonNegative(usage.output),
		cacheRead: nonNegative(usage.cacheRead),
		cacheWrite: nonNegative(usage.cacheWrite),
		totalCost:
			typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total)
				? Math.max(0, usage.cost.total)
				: 0,
	};
}

const SKILL_SEARCH_PARAMS = Type.Object({
	action: Type.Union([
		Type.Literal("search"),
		Type.Literal("load"),
		Type.Literal("resource"),
		Type.Literal("location"),
	]),
	query: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String()),
	pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const TOOL_SEARCH_PARAMS = Type.Object({
	query: Type.String(),
	cursor: Type.Optional(Type.String()),
	pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const RETRIEVE_OUTPUT_PARAMS = Type.Object({
	id: Type.String({ description: "Opaque sko: or htr: handle" }),
	startLine: Type.Optional(Type.Integer({ minimum: 1 })),
	lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
});

export default function skillOptimizer(pi: ExtensionAPI) {
	let snapshot: RuntimeSnapshot | undefined;
	let cachedConfig: { cwd: string; value: ConfigRecord } | undefined;
	let retryAfter = 0;
	let retryNoticeAt = 0;
	let registry: SkillRegistry | undefined;
	let toolCatalog: ToolDiscoveryCatalog | undefined;
	let permittedToolNames: Set<string> | undefined;
	const deactivatedToolNames = new Set<string>();
	const retainedToolNames = new Set<string>();
	let latestPrompt = "";
	let lastSelected: string[] = [];
	let lastRemovedChars = 0;
	let lastBudget = { usedChars: 0, requestedChars: 0, nameOnlyCount: 0 };
	let rtkPresence: boolean | undefined;
	let hasStatus = false;
	let lastStatusText: string | undefined;
	const usedTools = new Set<string>();
	const seenEvidence = new Set<string>();
	const seenProviderMessages = new Set<string>();
	const historyArtifacts = new Map<string, HistoryArtifact>();
	const historyOrder: string[] = [];
	const shownInitNoticeKeys = new Set<string>();

	let sessionSaved: SavingsByArea = { ...EMPTY_SAVINGS };
	let sessionExtraction: ExtractionTelemetry = { ...EMPTY_EXTRACTION_TELEMETRY };
	let sessionCache: ProviderCacheTelemetry = { ...EMPTY_PROVIDER_CACHE_TELEMETRY };
	const pendingStats = new Map<string, PendingStats>();
	const pendingUsage = new Map<string, SkillUsageStats>();
	const statsBase = new Map<string, SavedStats>();
	let lastFlushAt = 0;

	const setSessionStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		if (hasStatus && lastStatusText === text) return;
		setStatus(ctx, text);
		hasStatus = true;
		lastStatusText = text;
	};

	const reportInitProgress = (
		ctx: ExtensionContext,
		message: string,
		type: "info" | "warning" | "error" = "info",
		notify = true,
	): void => {
		if (notify) ctx.ui.notify(message, type);
		setSessionStatus(ctx, message);
	};

	const stateFallback = (ctx: ExtensionContext, config: ConfigRecord): RuntimeSnapshot => {
		const profilePaths = getProfilePaths(ctx.cwd);
		return {
			cwd: ctx.cwd,
			config,
			profile: EMPTY_PROFILE,
			globalStoredProfile: EMPTY_STORED_PROFILE,
			usage: {},
			profileKey: `${profilePaths.global}::${profilePaths.project}`,
			usagePath: getUsageFilePath(ctx.cwd),
		};
	};

	const getRuntimeConfig = (ctx: ExtensionContext, refresh = false): ConfigRecord => {
		if (refresh || cachedConfig?.cwd !== ctx.cwd) {
			cachedConfig = { cwd: ctx.cwd, value: getConfig(ctx.cwd) };
		}
		if (snapshot?.cwd === ctx.cwd) snapshot.config = cachedConfig.value;
		return cachedConfig.value;
	};

	const ensureSnapshot = (ctx: ExtensionContext, force = false): RuntimeSnapshot => {
		if (!force && snapshot?.cwd === ctx.cwd && retryAfter === 0) return snapshot;
		if (!force && Date.now() < retryAfter && snapshot?.cwd === ctx.cwd) return snapshot;
		const config = getRuntimeConfig(ctx);
		try {
			const profilePaths = getProfilePaths(ctx.cwd);
			const globalStoredProfile = readStoredProfile(profilePaths.global);
			const projectStoredProfile = profilePaths.project !== profilePaths.global
				? readStoredProfile(profilePaths.project)
				: undefined;
			const profile = projectStoredProfile
				? mergeProfiles(globalStoredProfile.profile, projectStoredProfile.profile)
				: globalStoredProfile.profile;
			const usagePath = getUsageFilePath(ctx.cwd);
			const candidate: RuntimeSnapshot = {
				cwd: ctx.cwd,
				config,
				profile,
				globalStoredProfile,
				...(projectStoredProfile ? { projectStoredProfile } : {}),
				usage: loadUsageFile(usagePath),
				profileKey: `${profilePaths.global}::${profilePaths.project}`,
				usagePath,
			};
			const originalUsageSize = Object.keys(candidate.usage).length;
			const pruned = pruneUsageStats(candidate.usage, usagePruneOptions(candidate));
			candidate.usage = pruned;
			if (Object.keys(pruned).length < originalUsageSize) {
				candidate.usage = pruneUsageFile(usagePath, usagePruneOptions(candidate));
			}
			// Explicit profile refreshes must retain usage not yet committed by this process.
			const pending = pendingUsage.get(usagePath);
			if (pending) candidate.usage = mergeUsageStats(candidate.usage, pending);
			snapshot = candidate;
			retryAfter = 0;
			return candidate;
		} catch (error) {
			retryAfter = Date.now() + LOAD_RETRY_MS;
			snapshot = snapshot?.cwd === ctx.cwd ? snapshot : stateFallback(ctx, config);
			if (Date.now() - retryNoticeAt > 5_000) {
				retryNoticeAt = Date.now();
				ctx.ui.notify(`skill-optimizer: state snapshot failed; retrying (${(error as Error).message})`, "warning");
			}
			return snapshot;
		}
	};

	const getInitReadiness = (state: RuntimeSnapshot, skills: readonly PiSkill[]): InitReadiness => {
		const hasProjectScope = state.projectStoredProfile !== undefined;
		const globalSkills = hasProjectScope
			? skills.filter((skill) => skill.sourceInfo.scope !== "project")
			: skills;
		const projectSkills = hasProjectScope
			? skills.filter((skill) => skill.sourceInfo.scope === "project")
			: undefined;
		const input: InitReadinessInput = {
			scopeKey: state.profileKey,
			initVersion: INIT_VERSION,
			global: { stored: state.globalStoredProfile, skills: globalSkills },
			...(state.projectStoredProfile && projectSkills
				? { project: { stored: state.projectStoredProfile, skills: projectSkills } }
				: {}),
		};
		const catalogKey = buildInitCatalogKey(input);
		if (state.initReadiness?.catalogKey === catalogKey) return state.initReadiness.value;
		const readiness = buildInitReadiness(input, catalogKey);
		state.initReadiness = { catalogKey: readiness.catalogKey, value: readiness };
		return readiness;
	};

	const maybeShowInitNotice = (
		ctx: ExtensionContext,
		state: RuntimeSnapshot,
		skills: readonly PiSkill[],
	): void => {
		if (!ctx.hasUI || skills.length === 0 || retryAfter !== 0) return;
		const readiness = getInitReadiness(state, skills);
		if (readiness.status !== "empty" && readiness.status !== "outdated" && readiness.status !== "incomplete") return;
		const status: InitNoticeStatus = readiness.status;
		const key = buildInitNoticeKey(state.profileKey, INIT_VERSION, status);
		if (shownInitNoticeKeys.has(key)) return;
		shownInitNoticeKeys.add(key);
		try {
			pi.appendEntry(INIT_READINESS_ENTRY_TYPE, { schema: 1, key });
		} catch {
			// The notice is useful even when session metadata cannot be persisted.
		}
		try {
			ctx.ui.notify("Optional setup: run `/skill-optimizer init` to improve skill matching (may incur model costs).", "info");
		} catch {
			// UI notification is cosmetic only.
		}
	};

	const ensureStatsBase = (ctx: ExtensionContext): { path: string; base: SavedStats } => {
		const path = getStatsFilePath(ctx.cwd);
		let base = statsBase.get(path);
		if (!base) {
			try {
				base = loadStatsSnapshot(path);
				statsBase.set(path, base);
			} catch {
				base = {
					savings: { ...EMPTY_SAVINGS },
					extraction: { ...EMPTY_EXTRACTION_TELEMETRY },
					cache: { ...EMPTY_PROVIDER_CACHE_TELEMETRY },
				};
				statsBase.set(path, base);
			}
		}
		return { path, base };
	};

	const addPending = (
		path: string,
		savings: SavingsByArea = EMPTY_SAVINGS,
		extraction: ExtractionTelemetry = EMPTY_EXTRACTION_TELEMETRY,
		cache: ProviderCacheTelemetry = EMPTY_PROVIDER_CACHE_TELEMETRY,
	): void => {
		const current = pendingStats.get(path) ?? emptyPendingStats();
		pendingStats.set(path, {
			savings: addSavings(current.savings, savings),
			extraction: addExtractionTelemetry(current.extraction, extraction),
			cache: addProviderCacheTelemetry(current.cache, cache),
		});
	};

	const flushStats = (): void => {
		for (const [path, delta] of pendingStats) {
			try {
				statsBase.set(path, saveStatsDeltas(path, delta.savings, delta.extraction, delta.cache));
				pendingStats.delete(path);
			} catch {
				// Keep the complete delta for the next flush.
			}
		}
	};

	const flushUsage = (ctx?: ExtensionContext): void => {
		for (const [path, delta] of pendingUsage) {
			try {
				const options = snapshot && snapshot.usagePath === path ? usagePruneOptions(snapshot) : undefined;
				const saved = saveUsageDelta(path, delta, options);
				pendingUsage.delete(path);
				if (snapshot?.usagePath === path) snapshot.usage = saved;
			} catch (error) {
				ctx?.ui.notify(`skill-optimizer: usage flush failed (${(error as Error).message})`, "warning");
			}
		}
	};

	const maybeFlush = (ctx: ExtensionContext, force = false): void => {
		if (!force && Date.now() - lastFlushAt < FLUSH_INTERVAL_MS) return;
		lastFlushAt = Date.now();
		flushUsage(ctx);
		flushStats();
	};

	const recordSkillUsage = (ctx: ExtensionContext, names: readonly string[]): void => {
		if (names.length === 0) return;
		const state = ensureSnapshot(ctx);
		const now = Date.now();
		state.usage = updateSkillUsage(state.usage, names, now);
		const delta = updateSkillUsage(pendingUsage.get(state.usagePath) ?? {}, names, now);
		pendingUsage.set(state.usagePath, delta);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		const denominator = sessionCache.input + sessionCache.cacheRead + sessionCache.cacheWrite;
		const cache = denominator > 0 ? `${Math.round(sessionCache.cacheRead * 100 / denominator)}% cache` : "cache n/a";
		const saved = totalSavings(sessionSaved);
		setSessionStatus(ctx, `AUTO | -${approxK(saved)} tok | ${cache}`);
	};

	const storeHistoryArtifact = (artifact: HistoryArtifact): void => {
		if (!historyArtifacts.has(artifact.id)) historyOrder.push(artifact.id);
		historyArtifacts.set(artifact.id, artifact);
		while (historyOrder.length > MAX_HISTORY_ARTIFACTS) {
			const id = historyOrder.shift();
			if (id) historyArtifacts.delete(id);
		}
	};

	const rtkExtensionPresent = (): boolean => {
		if (rtkPresence !== undefined) return rtkPresence;
		try {
			rtkPresence = pi.getCommands().some((command) =>
				isRtkSource(command.name, command.sourceInfo?.path ?? "", command.sourceInfo?.source ?? ""),
			);
		} catch {
			rtkPresence = false;
		}
		return rtkPresence;
	};

	const rebuildToolCatalog = (state: RuntimeSnapshot): ToolDiscoveryCatalog => {
		const allTools = pi.getAllTools();
		const activeNames = new Set(pi.getActiveTools().map((name) => name.toLowerCase()));
		const alwaysToolPrefixes = state.config.alwaysTools
			.map((pattern) => pattern.trim().toLowerCase())
			.filter((pattern) => pattern.length > 0);
		permittedToolNames ??= new Set([
			...activeNames,
			...PROTECTED_RUNTIME_TOOLS,
		]);
		for (const tool of allTools) {
			const name = tool.name.toLowerCase();
			if (isHostHiddenTool(tool)) {
				permittedToolNames.delete(name);
				retainedToolNames.delete(name);
				deactivatedToolNames.delete(name);
				continue;
			}
			if (activeNames.has(name)) {
				const newlyActive = !permittedToolNames.has(name);
				const reactivated = deactivatedToolNames.delete(name);
				if (newlyActive || reactivated) retainedToolNames.add(name);
				permittedToolNames.add(name);
			} else if (isHostSearchableTool(tool) && alwaysToolPrefixes.some((pattern) => name.startsWith(pattern))) {
				permittedToolNames.add(name);
			}
		}
		const discoverable = allTools.filter((tool) =>
			!isHostHiddenTool(tool) && permittedToolNames?.has(tool.name.toLowerCase()),
		);
		toolCatalog = buildToolDiscoveryCatalog(discoverable, {
			protect: [...PROTECTED_RUNTIME_TOOLS, ...state.config.alwaysTools],
		});
		return toolCatalog;
	};

	const buildToolSearchCatalog = (state: RuntimeSnapshot): ToolDiscoveryCatalog => {
		rebuildToolCatalog(state);
		return buildToolDiscoveryCatalog(pi.getAllTools().filter((tool) =>
			!isHostHiddenTool(tool)
				&& (permittedToolNames?.has(tool.name.toLowerCase()) || isHostSearchableTool(tool)),
		), {
			protect: [...PROTECTED_RUNTIME_TOOLS, ...state.config.alwaysTools],
		});
	};

	const activateAdditively = (names: readonly string[]): string[] => {
		const requested = new Set(names.map((name) => name.toLowerCase()));
		const current = new Set(pi.getActiveTools().map((name) => name.toLowerCase()));
		const added: string[] = [];
		for (const tool of pi.getAllTools()) {
			if (isHostHiddenTool(tool)) continue;
			if (!permittedToolNames?.has(tool.name.toLowerCase()) && !isHostSearchableTool(tool)) continue;
			if (!requested.has(tool.name.toLowerCase())) continue;
			permittedToolNames?.add(tool.name.toLowerCase());
			retainedToolNames.add(tool.name.toLowerCase());
			if (current.has(tool.name.toLowerCase())) continue;
			current.add(tool.name.toLowerCase());
			deactivatedToolNames.delete(tool.name.toLowerCase());
			added.push(tool.name);
		}
		const ordered = pi.getAllTools()
			.filter((tool) => !isHostHiddenTool(tool) && current.has(tool.name.toLowerCase()))
			.map((tool) => tool.name);
		pi.setActiveTools(ordered);
		return added;
	};

	const restorePermittedTools = (): void => {
		if (deactivatedToolNames.size === 0) {
			toolCatalog = undefined;
			return;
		}
		const active = new Set(pi.getActiveTools().map((name) => name.toLowerCase()));
		for (const name of deactivatedToolNames) active.add(name);
		pi.setActiveTools(
			pi.getAllTools()
				.filter((tool) => !isHostHiddenTool(tool) && active.has(tool.name.toLowerCase()))
				.map((tool) => tool.name),
		);
		deactivatedToolNames.clear();
		toolCatalog = undefined;
	};

	pi.registerTool({
		name: "skill_search",
		label: "Skill Search",
		description: "Search the local skill catalog or load one exact registered skill/resource on demand.",
		promptSnippet: "Search and load full skill instructions on demand",
		parameters: SKILL_SEARCH_PARAMS,
		async execute(_id, params, _signal, _update, ctx) {
			if (!registry) throw new Error("Skill registry is not initialized.");
			const state = ensureSnapshot(ctx);
			if (params.action === "search") {
				if (!params.query) throw new TypeError("query is required for search");
				const page = registry.search(params.query, {
					cursor: params.cursor,
					pageSize: params.pageSize,
					profile: state.profile,
					usagePrior: buildUsagePrior(state.usage, {
						halfLifeDays: state.config.usageHalfLifeDays,
					}),
					never: state.config.excludeSkills,
					fuzzyCandidateLimit: state.config.fuzzyCandidateLimit,
				});
				return { content: [{ type: "text", text: JSON.stringify(page) }], details: { action: "search", total: page.total } };
			}
			if (!params.name) throw new TypeError("name is required");
			if (params.action === "load") {
				const resource = registry.loadExact(params.name);
				recordSkillUsage(ctx, [resource.name]);
				return { content: [{ type: "text", text: resource.content }], details: { action: "load", name: resource.name } };
			}
			if (params.action === "resource") {
				if (!params.path) throw new TypeError("path is required for resource");
				const resource = registry.loadResource(params.name, params.path);
				recordSkillUsage(ctx, [resource.name]);
				return { content: [{ type: "text", text: resource.content }], details: { action: "resource", name: resource.name, relativePath: resource.relativePath } };
			}
			const location = registry.locateExact(params.name);
			recordSkillUsage(ctx, [location.name]);
			return { content: [{ type: "text", text: location.location }], details: { action: "location", name: location.name } };
		},
	});

	pi.registerTool({
		name: "optimizer_tool_search",
		label: "Optimizer Tool Search",
		description: "Search local tool definitions and activate matching inactive tools without disabling current tools.",
		promptSnippet: "Search and activate additional tools on demand",
		parameters: TOOL_SEARCH_PARAMS,
		async execute(_id, params, _signal, _update, ctx) {
			if (!params.query.trim()) throw new TypeError("query must not be empty");
			const state = ensureSnapshot(ctx);
			const catalog = buildToolSearchCatalog(state);
			const page = searchToolDiscoveryCatalog(catalog, params.query, {
				cursor: params.cursor,
				pageSize: Math.min(
					params.pageSize ?? state.config.toolSearchPageSize,
					state.config.toolSearchPageSize,
				),
			});
			const activated = activateAdditively(page.results
				.filter((result) => result.matchedTerms.length > 0)
				.map((result) => result.name));
			return {
				content: [{ type: "text", text: JSON.stringify({ ...page, activated }) }],
				details: { activated, confidence: page.confidence, failOpen: page.failOpen },
			};
		},
	});

	pi.registerTool({
		name: "retrieve_output",
		label: "Retrieve Output",
		description: "Retrieve exact archived output by an opaque sko: or htr: handle.",
		promptSnippet: "Retrieve exact content hidden behind an output handle",
		parameters: RETRIEVE_OUTPUT_PARAMS,
		async execute(_id, params, _signal, _update, ctx) {
			const output = getOutputConfig(getRuntimeConfig(ctx));
			const archived = params.id.startsWith("sko:")
				? resolveTemporaryOutput(params.id, { ttlMs: output.archiveTtlMs })
				: historyArtifacts.get(params.id)?.text;
			if (archived === undefined) {
				throw new Error(`Unknown or expired output handle: ${params.id}`);
			}
			const recovered = sliceOutputLines(archived, params.startLine, params.lineCount);
			return {
				content: [{ type: "text", text: recovered.text }],
				details: {
					id: params.id,
					found: true,
					startLine: recovered.startLine,
					lineCount: recovered.lineCount,
					totalLines: recovered.totalLines,
				},
			};
		},
	});

	const initializeToolSelection = (state: RuntimeSnapshot, query: string): void => {
		const catalog = rebuildToolCatalog(state);
		const retained = new Set([...usedTools, ...retainedToolNames]);
		const plan = planToolActivation(catalog, query, {
			topK: state.config.toolPrefetchMax,
			usedNames: retained,
		});
		const protectedNames = new Set(PROTECTED_RUNTIME_TOOLS.map((name) => name.toLowerCase()));
		const active = new Set(plan.activeNames.map((name) => name.toLowerCase()));
		for (const name of protectedNames) active.add(name);
		deactivatedToolNames.clear();
		for (const name of permittedToolNames ?? []) {
			if (!active.has(name)) deactivatedToolNames.add(name);
		}
		pi.setActiveTools(pi.getAllTools().map((tool) => tool.name).filter((name) =>
			permittedToolNames?.has(name.toLowerCase()) && active.has(name.toLowerCase()),
		));
	};

	const initProfile = async (ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]): Promise<void> => {
		if (!ctx.model) {
			reportInitProgress(ctx, "skill-optimizer: init failed: no model selected", "error");
			return;
		}
		const model = ctx.model;
		const skills = skillInputs(ctx.getSystemPromptOptions().skills ?? []);
		if (skills.length === 0) {
			reportInitProgress(ctx, "skill-optimizer: init failed: no model-invocable skills found", "warning");
			return;
		}
		const paths = getProfilePaths(ctx.cwd);
		let stored: ReturnType<typeof readStoredProfile>;
		let projectStored: ReturnType<typeof readStoredProfile> | undefined;
		try {
			stored = readStoredProfile(paths.global);
			projectStored = paths.project !== paths.global ? readStoredProfile(paths.project) : undefined;
		} catch (error) {
			reportInitProgress(ctx, `skill-optimizer: init failed: profile read failed (${(error as Error).message})`, "error");
			return;
		}
		const baseProfile = projectStored?.exists ? mergeProfiles(stored.profile, projectStored.profile) : stored.profile;
		const storedHashes = projectStored?.exists ? { ...stored.hashes, ...projectStored.hashes } : stored.hashes;
		const forceFull = !stored.exists
			|| stored.initVersion !== INIT_VERSION
			|| (!!projectStored?.exists && projectStored.initVersion !== INIT_VERSION);
		const refs = skills.map((skill) => ({ name: skill.name, description: skill.description }));
		const { changed, removed, hashes } = diffSkills(refs, forceFull ? {} : storedHashes);
		const projectNames = new Set(skills
			.filter((skill) => skill.sourceInfo.scope === "project")
			.map((skill) => skill.name));
		const scopeRepair = needsProfileScopeRepair({
			paths,
			projectNames,
			global: stored,
			project: projectStored,
		});
		if (!forceFull && changed.length === 0 && removed.length === 0 && !scopeRepair) {
			reportInitProgress(ctx, `skill-optimizer: init done: profile already current (${skills.length} skills)`);
			return;
		}

		const batchLimits = {
			maxSkills: INIT_BATCH_MAX_SKILLS,
			maxUtf8Bytes: INIT_BATCH_MAX_UTF8_BYTES,
			maxAttempts: INIT_BATCH_MAX_ATTEMPTS,
		};
		const changedNames = new Set(changed);
		const targetSkills = refs.filter((skill) => changedNames.has(skill.name));
		const batches = targetSkills.length > 0 ? batchSkillsByWeight(targetSkills, batchLimits) : [];
		const invalidatedNames = new Set([...removed, ...changed]);
		const prunedBase = pruneProfileNames(forceFull ? EMPTY_PROFILE : baseProfile, invalidatedNames);
		let partial = EMPTY_PROFILE;
		let appliedChanged: string[] = [];
		let savedCount = 0;
		let checkpointedProfile: SkillOptimizerProfile | undefined;
		let checkpointedApplied = new Set<string>();

		const persist = (nextPartial: SkillOptimizerProfile, applied: readonly string[]): SkillOptimizerProfile => {
			const appliedSet = new Set(applied);
			const profile = mergeIncrementalProfile(prunedBase, nextPartial, applied);
			const pending = changed.filter((name) => !appliedSet.has(name));
			writeProfileFiles(buildInitProfileWrites({
				paths,
				profile,
				hashes: computeFinalHashes(hashes, pending),
				skillCount: skills.length,
				projectNames,
				globalRevision: stored.revision,
				projectRevision: projectStored?.revision ?? null,
				projectExists: !!projectStored?.exists,
			}), INIT_VERSION);
			stored = readStoredProfile(paths.global);
			if (projectStored !== undefined) projectStored = readStoredProfile(paths.project);
			snapshot = undefined;
			retryAfter = 0;
			savedCount = appliedSet.size;
			checkpointedProfile = profile;
			checkpointedApplied = appliedSet;
			return profile;
		};

		const persistError = (error: unknown): string => error instanceof ConcurrentFileUpdateError
			? "profile changed concurrently; run init again"
			: (error as Error).message;

		reportInitProgress(
			ctx,
			`skill-optimizer: init starting (${skills.length} skills, ${batches.length} batch${batches.length === 1 ? "" : "es"}${removed.length > 0 ? `, ${removed.length} removed` : ""})`,
		);

		if (!forceFull && removed.length > 0) {
			try {
				persist(EMPTY_PROFILE, []);
			} catch (error) {
				reportInitProgress(ctx, `skill-optimizer: init failed: profile not saved (${persistError(error)})`, "error");
				return;
			}
			reportInitProgress(ctx, `skill-optimizer: init saved ${removed.length} removal(s)`, "info", false);
		}

		if (changed.length > 0) {
			const systemPrompt = INIT_PROFILE_PROMPT;
			let result: Awaited<ReturnType<typeof generateProfileInBatches>>;
			let lastBatchFailure: string | undefined;
			try {
				result = await generateProfileInBatches(
					targetSkills,
					batchLimits,
					async (batch, index, total, attempt) => {
						const label = `${index + 1}/${total}`;
						reportInitProgress(
							ctx,
							`skill-optimizer: init ${label} starting (${batch.length} skills${attempt > 1 ? `, attempt ${attempt}` : ""})`,
							"info",
							false,
						);
						const message: UserMessage = {
							role: "user",
							content: [{
								type: "text",
								text: JSON.stringify({
									skills: batch.map((skill) => ({
										name: skill.name,
										description: skill.description,
									})),
								}),
							}],
							timestamp: Date.now(),
						};
						try {
							const response = await ctx.modelRegistry.complete(
								model,
								{ systemPrompt, messages: [message] },
							);
							const outcome = interpretBatchResponse(response);
							if (outcome.status === "failed") {
								return outcome;
							}
							return {
								profile: mergeIncrementalProfile(EMPTY_PROFILE, outcome.profile, batch.map((skill) => skill.name)),
								processedSkills: outcome.processedSkills,
							};
						} catch (error) {
							return {
								status: "failed",
								reason: `failed (${(error as Error).message})`,
								retryable: isRetryableBatchException(error),
							};
						}
					},
					async (event) => {
						if (event.type === "rejected") {
							const willRetry = event.retryable && event.attempt < batchLimits.maxAttempts;
							lastBatchFailure = `${event.index + 1}/${event.total} attempt ${event.attempt}: ${event.reason}`;
							reportInitProgress(
								ctx,
								`skill-optimizer: init ${event.index + 1}/${event.total} attempt ${event.attempt} ${event.reason}${willRetry ? "; retrying" : ""}`,
								"warning",
								!willRetry,
							);
							return;
						}
						const applied = changed.filter((name) => event.applied.has(name));
						persist(event.partial, applied);
						appliedChanged = applied;
						partial = event.partial;
						reportInitProgress(
							ctx,
							`skill-optimizer: init ${event.index + 1}/${event.total} saved (${event.batchNames.length} skills, ${applied.length} written)`,
							"info",
							false,
						);
					},
				);
			} catch (error) {
				reportInitProgress(
					ctx,
					`skill-optimizer: init failed: profile not saved (${persistError(error)})${savedCount > 0 ? `; ${savedCount} skills already written` : ""}`,
					"error",
				);
				return;
			}
			if (!result) {
				let profile = checkpointedProfile;
				if (!profile) {
					try {
						profile = persist(EMPTY_PROFILE, []);
					} catch (error) {
						reportInitProgress(
							ctx,
							`skill-optimizer: init failed: profile not saved (${persistError(error)})`,
							"error",
						);
						return;
					}
				}
				reportInitProgress(
					ctx,
					`skill-optimizer: init failed: every batch failed (${lastBatchFailure ?? "unknown batch failure"}); ${changed.length} changed skill(s) left inactive for retry; ${profileSummary(profile)}`,
					"error",
				);
				return;
			}
			appliedChanged = changed.filter((name) => result.applied.has(name));
			partial = result.partial;
		}

		let profile: SkillOptimizerProfile;
		const finalApplied = new Set(appliedChanged);
		const checkpointIsFinal = checkpointedProfile !== undefined
			&& checkpointedApplied.size === finalApplied.size
			&& [...finalApplied].every((name) => checkpointedApplied.has(name));
		if (checkpointIsFinal && checkpointedProfile) {
			profile = checkpointedProfile;
		} else {
			try {
				profile = persist(partial, appliedChanged);
			} catch (error) {
				reportInitProgress(
					ctx,
					`skill-optimizer: init failed: profile not saved (${persistError(error)})${savedCount > 0 ? `; ${savedCount} skills already written` : ""}`,
					"error",
				);
				return;
			}
		}
		const appliedChangedSet = new Set(appliedChanged);
		const failedChanged = changed.filter((name) => !appliedChangedSet.has(name));
		const newCount = appliedChanged.filter((name) => !(name in storedHashes)).length;
		reportInitProgress(
			ctx,
			`skill-optimizer: init done v${INIT_VERSION} +${newCount}, ~${appliedChanged.length - newCount}, -${removed.length}, retry ${failedChanged.length}; ${profileSummary(profile)}`,
			failedChanged.length > 0 ? "warning" : "info",
		);
	};

	pi.on("session_start", (_event, ctx) => {
		hasStatus = false;
		lastStatusText = undefined;
		shownInitNoticeKeys.clear();
		try {
			for (const key of readInitNoticeKeys(ctx.sessionManager.getBranch())) shownInitNoticeKeys.add(key);
		} catch {
			// Dedupe recovery is best-effort; the marker is session metadata only.
		}
		restorePermittedTools();
		snapshot = undefined;
		cachedConfig = undefined;
		retryAfter = 0;
		registry = undefined;
		toolCatalog = undefined;
		permittedToolNames = undefined;
		deactivatedToolNames.clear();
		retainedToolNames.clear();
		latestPrompt = "";
		lastSelected = [];
		rtkPresence = undefined;
		usedTools.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			const message = (entry as { message?: { role?: unknown; toolName?: unknown } }).message;
			if (
				message?.role === "toolResult"
				&& typeof message.toolName === "string"
			) {
				usedTools.add(message.toolName.toLowerCase());
			}
		}
		seenEvidence.clear();
		seenProviderMessages.clear();
		historyArtifacts.clear();
		historyOrder.length = 0;
		sessionSaved = { ...EMPTY_SAVINGS };
		sessionExtraction = { ...EMPTY_EXTRACTION_TELEMETRY };
		sessionCache = { ...EMPTY_PROVIDER_CACHE_TELEMETRY };
		lastFlushAt = 0;
		const config = getRuntimeConfig(ctx, true);
		cleanupTemporaryOutputs({ ttlMs: getOutputConfig(config).archiveTtlMs });
		try {
			const created = ensureGlobalConfigTemplate();
			if (created) ctx.ui.notify(`skill-optimizer: wrote default config to ${created}`, "info");
		} catch {
			// Convenience only.
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		latestPrompt = event.prompt;
		if (isDisabled(ctx.cwd)) {
			restorePermittedTools();
			return;
		}
		const config = getRuntimeConfig(ctx, true);
		const providers = config.providers.length > 0 ? config.providers : undefined;
		if (providers && (!ctx.model || !providers.includes(ctx.model.provider))) {
			restorePermittedTools();
			return;
		}
		const state = ensureSnapshot(ctx);
		try {
			const skills = skillInputs(event.systemPromptOptions.skills ?? []);
			registry = makeSkillRegistry(skills);
			initializeToolSelection(state, event.prompt);
			maybeShowInitNotice(ctx, state, skills);
			updateStatus(ctx);
			return;
		} catch (error) {
			ctx.ui.notify(`skill-optimizer: AUTO prefetch failed open (${(error as Error).message})`, "warning");
			return;
		}
	});

	pi.on("context_with_system", (event, ctx) => {
		if (isDisabled(ctx.cwd)) return;
		const config = getRuntimeConfig(ctx);
		const providers = config.providers.length > 0 ? config.providers : undefined;
		if (providers && (!ctx.model || !providers.includes(ctx.model.provider))) return;
		const state = ensureSnapshot(ctx);
		const payload = { messages: event.messages };
		const transformed = optimizePayload(payload, {
			...state.config,
			profile: state.profile,
			usagePrior: buildUsagePrior(state.usage, {
				halfLifeDays: state.config.usageHalfLifeDays,
			}),
		});
		lastRemovedChars = transformed.removedChars;
		lastSelected = transformed.selected;
		lastBudget = {
			usedChars: transformed.budget.usedChars,
			requestedChars: transformed.budget.requestedChars,
			nameOnlyCount: transformed.budget.nameOnlyCount,
		};
		if (transformed.removedChars > 0) {
			sessionSaved.skills += transformed.removedChars;
			addPending(getStatsFilePath(ctx.cwd), { skills: transformed.removedChars, tools: 0, output: 0 });
		}
		if (registry) {
			const evidence = collectSkillUsageEvidence(payload, registry.skills.map((skill) => skill.name)).slice(-MAX_SEEN_EVIDENCE);
			const names: string[] = [];
			for (const item of evidence) {
				if (seenEvidence.has(item.key)) continue;
				seenEvidence.add(item.key);
				names.push(item.name);
				while (seenEvidence.size > MAX_SEEN_EVIDENCE) {
					const oldest = seenEvidence.values().next().value as string | undefined;
					if (oldest) seenEvidence.delete(oldest);
				}
			}
			recordSkillUsage(ctx, names);
		}
		maybeFlush(ctx);
		updateStatus(ctx);
		return transformed.next === payload
			? undefined
			: { messages: (transformed.next as typeof payload).messages };
	});

	pi.on("context", (event, ctx) => {
		if (isDisabled(ctx.cwd)) return;
		const config = getRuntimeConfig(ctx);
		const providers = config.providers.length > 0 ? config.providers : undefined;
		if (providers && (!ctx.model || !providers.includes(ctx.model.provider))) return;
		const state = ensureSnapshot(ctx);
		const positions: number[] = [];
		const results: Array<{ content: unknown; isError?: boolean }> = [];
		event.messages.forEach((message, index) => {
			if ((message as { role?: unknown }).role !== "toolResult") return;
			positions.push(index);
			results.push(message as unknown as { content: unknown; isError?: boolean });
		});
		const deduplicated = deduplicateToolResultHistory(results, {
			minBytes: state.config.historyDedupMinBytes,
		});
		if (deduplicated.next === results) return;
		for (const artifact of deduplicated.artifacts) storeHistoryArtifact(artifact);
		const messages = event.messages.slice();
		deduplicated.next.forEach((message, index) => {
			messages[positions[index]] = message as typeof messages[number];
		});
		return { messages };
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: unknown;
			responseId?: unknown;
			provider?: unknown;
			model?: unknown;
			timestamp?: unknown;
			usage?: {
				input?: unknown;
				output?: unknown;
				cacheRead?: unknown;
				cacheWrite?: unknown;
				cost?: { total?: unknown };
			};
		};
		if (message.role !== "assistant" || !message.usage) return;
		if (isDisabled(ctx.cwd)) return;
		const config = getRuntimeConfig(ctx);
		const providers = config.providers.length > 0 ? config.providers : undefined;
		const provider =
			typeof message.provider === "string" ? message.provider : ctx.model?.provider;
		if (providers && (!provider || !providers.includes(provider))) return;
		const signature = typeof message.responseId === "string"
			? message.responseId
			: JSON.stringify([message.provider, message.model, message.timestamp, message.usage]);
		if (seenProviderMessages.has(signature)) return;
		seenProviderMessages.add(signature);
		while (seenProviderMessages.size > MAX_SEEN_EVIDENCE) {
			const oldest = seenProviderMessages.values().next().value as string | undefined;
			if (oldest) seenProviderMessages.delete(oldest);
		}
		const delta = providerCacheDelta(message.usage);
		sessionCache = addProviderCacheTelemetry(sessionCache, delta);
		addPending(getStatsFilePath(ctx.cwd), EMPTY_SAVINGS, EMPTY_EXTRACTION_TELEMETRY, delta);
		maybeFlush(ctx);
		updateStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		usedTools.add(event.toolName.toLowerCase());
		if (RESOLVER_RESULT_TOOLS.has(event.toolName)) return;
		if (isDisabled(ctx.cwd) || event.isError) return;
		const config = getRuntimeConfig(ctx);
		const providers = config.providers.length > 0 ? config.providers : undefined;
		if (providers && (!ctx.model || !providers.includes(ctx.model.provider))) return;
		const output = getOutputConfig(config);
		if (output.mode === "off") return;
		const details = event.details && typeof event.details === "object"
			? event.details as Record<string, unknown>
			: {};
		const rtkHandled = details.rtkHandled === true || details.reducedBy === "rtk";
		const command = typeof event.input.command === "string" ? event.input.command : "";
		let changed = false;
		const content = [];
		for (const block of event.content) {
			if (block.type !== "text") {
				content.push(block);
				continue;
			}
			const text = block.text;
			if (!shouldReduceToolResult({
				toolName: event.toolName,
				outputTools: output.tools,
				rtkHandled,
				text,
			})) {
				content.push(block);
				continue;
			}
			if (text.split(/\r?\n/).length <= output.maxLines && utf8ByteLength(text) <= output.maxBytes) {
				content.push(block);
				continue;
			}

			let body: string | undefined;
			let strategy = "";
			let extractionOutcome: Exclude<keyof ExtractionTelemetry, "attempts"> | undefined;
			const columnar = reduceJsonArrayColumnar(text, {
				minSavingsBytes: output.minSavingsBytes,
				minSavingsRatio: output.minSavingsRatio,
			});
			if (columnar.reduced) {
				body = columnar.text;
				strategy = "columnar";
			} else if (
				output.mode === "extract"
				&& output.model.trim().length > 0
				&& utf8ByteLength(text) >= output.extractMinBytes
				&& !isExcludedCommand(command, output.extractExclude)
			) {
				const extraction = await tryExtractOutput(ctx, output.model, latestPrompt, command, text);
				if (extraction) {
					sessionCache = addProviderCacheTelemetry(sessionCache, extraction.telemetry);
					addPending(
						getStatsFilePath(ctx.cwd),
						EMPTY_SAVINGS,
						EMPTY_EXTRACTION_TELEMETRY,
						extraction.telemetry,
					);
				}
				if (!extraction?.text) {
					const smart = reduceOutput(text, {
						maxLines: output.maxLines,
						maxBytes: output.maxBytes,
						minSavingsBytes: output.minSavingsBytes,
						minSavingsRatio: output.minSavingsRatio,
					});
					if (smart.reduced) body = smart.text;
					strategy = smart.reduced ? "smart" : "original";
					extractionOutcome = "fallbackError";
				} else {
					const validated = validateExtractedOutput(text, extraction.text, {
						smartOptions: {
							maxLines: output.maxLines,
							maxBytes: output.maxBytes,
							minSavingsBytes: output.minSavingsBytes,
							minSavingsRatio: output.minSavingsRatio,
						},
						minSavingsBytes: output.minSavingsBytes,
						minSavingsRatio: output.minSavingsRatio,
					});
					if (validated.reduced) body = validated.text;
					strategy = validated.strategy;
					if (validated.strategy === "extract") extractionOutcome = "accepted";
					else {
						const reason: ExtractRejectionReason | undefined = validated.rejectionReason;
						extractionOutcome = reason === "insufficient-benefit"
							? "fallbackSavings"
							: reason === "empty-extraction"
								? "fallbackError"
								: "fallbackEvidence";
					}
				}
			} else {
				const smart = reduceOutput(text, {
					maxLines: output.maxLines,
					maxBytes: output.maxBytes,
					minSavingsBytes: output.minSavingsBytes,
					minSavingsRatio: output.minSavingsRatio,
				});
				if (smart.reduced) body = smart.text;
				strategy = smart.reduced ? "smart" : "original";
			}

			if (extractionOutcome) {
				const telemetry = { ...EMPTY_EXTRACTION_TELEMETRY, attempts: 1 };
				telemetry[extractionOutcome] = 1;
				sessionExtraction = addExtractionTelemetry(sessionExtraction, telemetry);
				addPending(getStatsFilePath(ctx.cwd), EMPTY_SAVINGS, telemetry);
			}
			if (!body) {
				content.push(block);
				continue;
			}
			const placeholder = `sko:${"0".repeat(43)}`;
			const candidate = `${body}\n[skill-optimizer:${strategy}; full=${placeholder}]`;
			const fromBytes = utf8ByteLength(text);
			const toBytes = utf8ByteLength(candidate);
			if (!hasMinimumSavings(fromBytes, toBytes, output.minSavingsBytes, output.minSavingsRatio)) {
				content.push(block);
				continue;
			}
			const archive = saveTemporaryOutput(text, { ttlMs: output.archiveTtlMs });
			if (!archive) {
				content.push(block);
				continue;
			}
			const rendered = `${body}\n[skill-optimizer:${strategy}; full=${archive}]`;
			changed = true;
			const removed = Math.max(0, text.length - rendered.length);
			sessionSaved.output += removed;
			addPending(getStatsFilePath(ctx.cwd), { skills: 0, tools: 0, output: removed });
			content.push({ ...block, text: rendered });
		}
		maybeFlush(ctx);
		updateStatus(ctx);
		return changed ? { content } : undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		maybeFlush(ctx, true);
		cleanupTemporaryOutputs({ ttlMs: getOutputConfig(getRuntimeConfig(ctx)).archiveTtlMs });
		restorePermittedTools();
		historyArtifacts.clear();
		historyOrder.length = 0;
		setSessionStatus(ctx, undefined);
	});

	pi.registerCommand("skill-optimizer", {
		description: "AUTO optimizer status; subcommands: init, audit",
		handler: async (args, ctx) => {
			getRuntimeConfig(ctx, true);
			const command = args.trim().toLowerCase();
			if (command === "init") {
				try {
					await initProfile(ctx);
				} finally {
					updateStatus(ctx);
				}
				return;
			}
			const skills = skillInputs(ctx.getSystemPromptOptions().skills ?? []);
			if (command === "audit") {
				const report = auditSkillDescriptions(skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					location: "",
				})));
				const issues = report.issues.slice(0, 30).map((issue) =>
					`  ${issue.name}: ${issue.code}${issue.relatedSkill ? ` (like ${issue.relatedSkill})` : ""}`);
				ctx.ui.notify([
					`skill-optimizer audit: ${report.issueCount} issue(s) across ${report.skillCount} skills`,
					`  long ${report.counts.too_long}, empty ${report.counts.near_empty}, routing ${report.counts.missing_routing}, duplicate ${report.counts.duplicate_description}`,
					`  estimated source reduction: ${report.estimatedReducibleChars} chars`,
					...issues,
					...(report.issues.length > issues.length ? [`  ... ${report.issues.length - issues.length} more`] : []),
				].join("\n"), report.issueCount > 0 ? "warning" : "info");
				return;
			}

			const state = ensureSnapshot(ctx, true);
			const readiness = getInitReadiness(state, skills);
			maybeFlush(ctx, true);
			const { path: statsPath, base } = ensureStatsBase(ctx);
			const saved = addSavings(base.savings, pendingStats.get(statsPath)?.savings ?? EMPTY_SAVINGS);
			const cache = addProviderCacheTelemetry(base.cache, pendingStats.get(statsPath)?.cache ?? EMPTY_PROVIDER_CACHE_TELEMETRY);
			const prior = Object.entries(buildUsagePrior(state.usage, {
				halfLifeDays: state.config.usageHalfLifeDays,
			})).slice(0, 8).map(([name]) => name);
			const configPaths = getConfigPaths(ctx.cwd);
			const profilePaths = getProfilePaths(ctx.cwd);
			const lines = [
				"pi-skill-optimizer",
				`  enabled:        ${isDisabled(ctx.cwd) ? "no" : "yes"}`,
				"  skills mode:    AUTO (stable TSV + skill_search resolver)",
				`  catalog budget:${lastBudget.usedChars}/${lastBudget.requestedChars} chars, ${lastBudget.nameOnlyCount} name-only`,
				`  tools:          ${pi.getActiveTools().length}/${pi.getAllTools().length} active; optimizer_tool_search additive`,
				`  output:         ${getOutputConfig(state.config).mode}; RTK ${rtkExtensionPresent() ? "detected per result" : "not detected"}`,
				`  scope:          ${state.config.providers.join(", ") || "all providers"}`,
				`  init readiness: ${retryAfter !== 0 ? "unavailable (profile could not be read)" : readiness.skillCount === 0 ? "not available (no model-invocable skills)" : initReadinessSummary(readiness)}`,
				`  profile:        ${profileSummary(state.profile)}`,
				`  critical:       ${state.profile.critical.join(", ") || "none"}`,
				`  usage prior:    ${prior.join(", ") || "none"} (${Object.keys(state.usage).length} tracked)`,
				`  cache lifetime: requests ${cache.requests}, input ${cache.input}, output ${cache.output}, read ${cache.cacheRead}, write ${cache.cacheWrite}, cost ${cache.totalCost.toFixed(4)}`,
				`  saved session:  ${totalSavings(sessionSaved)} chars (~${approxK(totalSavings(sessionSaved))} tok)`,
				`  saved lifetime: ${totalSavings(saved)} chars (~${approxK(totalSavings(saved))} tok)`,
				`  last request:   ${lastRemovedChars} chars; prefetch ${lastSelected.join(", ") || "none"}`,
				`  config:         ${fileExists(configPaths.project) ? configPaths.project : configPaths.global}`,
				`  profile files:  ${profilePaths.global}${fileExists(profilePaths.project) ? `, ${profilePaths.project}` : ""}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
