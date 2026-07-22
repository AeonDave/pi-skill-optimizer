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
 *
 * Provider-agnostic by default; scope with `PI_SKILL_OPTIMIZER_PROVIDERS`.
 * Pi has no `Skill` tool: the model loads a skill by `read`-ing its `<location>`,
 * so trimming the catalog affects only *proactive* discovery. Explicit
 * `/skill:name` invocation expands from Pi's on-disk skill registry before the
 * request is built (catalog-independent), so it always works.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { generateProfileInBatches, interpretBatchResponse, responseText } from "./generate.ts";
import { setUserAliasCandidates } from "./aliases.ts";
import { ensureGlobalConfigTemplate, getConfig, getConfigPaths, getOutputConfig, getPinnedTopK, getProfilePaths, getScopeProviders, getStatsFilePath, getUsageConfig, getUsageFilePath, isDisabled } from "./config.ts";
import { buildExtractPrompt, DEFAULT_OUTPUT_OPTIONS, isExcludedCommand, isRtkSource, reduceOutput, utf8ByteLength, validateExtractedOutput, type ExtractRejectionReason } from "./output.ts";
import { optimize } from "./optimize.ts";
import { ConcurrentFileUpdateError, fileExists, loadExtractionTelemetryFile, loadMergedProfile, loadStatsFile, loadUsageFile, pruneUsageFile, readStoredProfile, saveStatsDeltas, saveTemporaryOutput, saveUsageDelta, writeProfileFiles, type ProfileWrite } from "./persistence.ts";
import { computeFinalHashes, diffSkills, EMPTY_PROFILE, mergeIncrementalProfile, mergeProfiles, pruneProfileNames, splitProfileByScope, type SkillOptimizerProfile } from "./profile.ts";
import { collectSkillUsageEvidence, pruneUsageStats, recordSkillUsage, selectPinnedSkills, type SkillUsageStats, type UsagePruneOptions } from "./usage.ts";
import { addExtractionTelemetry, addSavings, EMPTY_EXTRACTION_TELEMETRY, EMPTY_SAVINGS, subtractExtractionTelemetry, subtractSavings, totalExtractionEvents, type ExtractionTelemetry, type SavingsByArea, totalSavings } from "./stats.ts";

const STATUS_KEY = "skill-optimizer";

/**
 * Bump when the init prompt or profile semantics change so an updated tool forces
 * a full regeneration instead of an incremental (hash-based) update.
 */
const INIT_VERSION = 3;

/**
 * Skills per profile-generation request. A full init on a large catalog (hundreds of
 * skills) is split into batches: one oversized request tends to come back with
 * `stopReason: "error"` (or truncated), which previously took down the whole init and
 * left no profile written. Batching bounds each request and isolates failures.
 */
const INIT_BATCH_SIZE = 80;

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
		const extracted = responseText(response);
		return extracted.trim() ? extracted : undefined;
	} catch {
		return undefined;
	}
}

function profileSummary(profile: SkillOptimizerProfile): string {
	return `${Object.keys(profile.aliases).length} aliases, ${profile.critical.length} critical, ${Object.keys(profile.queries).length} query sets`;
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

export default function skillOptimizer(pi: ExtensionAPI) {
	let lastRemovedChars = 0;
	let lastSelected: string[] = [];
	let lastDroppedTools = 0;
	let loadedProfilePath: string | undefined;
	let loadedUsagePath: string | undefined;
	let activeProfile: SkillOptimizerProfile = EMPTY_PROFILE;
	let usageStats: SkillUsageStats = {};
	const pendingUsage = new Map<string, SkillUsageStats>();
	const seenUsageEvidence = new Set<string>();
	const maxUsageEvidence = 4096;
	const usagePruneOptions = (ctx: ExtensionContext, stats: SkillUsageStats): UsagePruneOptions => {
		const config = getConfig(ctx.cwd);
		return {
			...getUsageConfig(ctx.cwd),
			protectedNames: [
				...activeProfile.critical,
				...(config.alwaysFull ?? []),
				...selectPinnedSkills(stats, getPinnedTopK(ctx.cwd)),
			],
		};
	};

	// Savings are removed characters; extraction guard outcomes are event counts.
	let sessionSaved: SavingsByArea = { ...EMPTY_SAVINGS };
	let sessionExtraction: ExtractionTelemetry = { ...EMPTY_EXTRACTION_TELEMETRY };
	let baseLifetime: SavingsByArea = { ...EMPTY_SAVINGS };
	let baseExtraction: ExtractionTelemetry = { ...EMPTY_EXTRACTION_TELEMETRY };
	const pendingStats = new Map<string, SavingsByArea>();
	const pendingExtraction = new Map<string, ExtractionTelemetry>();
	let loadedStatsPath: string | undefined;
	let lastFlushAt = 0;
	const pendingSavings = (path: string): SavingsByArea => pendingStats.get(path) ?? { ...EMPTY_SAVINGS };
	const pendingExtract = (path: string): ExtractionTelemetry => pendingExtraction.get(path) ?? { ...EMPTY_EXTRACTION_TELEMETRY };
	const addPendingSavings = (path: string, delta: SavingsByArea): void => {
		pendingStats.set(path, addSavings(pendingSavings(path), delta));
	};
	const addPendingExtraction = (path: string, delta: ExtractionTelemetry): void => {
		pendingExtraction.set(path, addExtractionTelemetry(pendingExtract(path), delta));
	};
	const flushStats = (onlyPath?: string): void => {
		const paths = onlyPath ? [onlyPath] : [...new Set([...pendingStats.keys(), ...pendingExtraction.keys()])];
		for (const path of paths) {
			const savingsDelta = pendingSavings(path);
			const extractionDelta = pendingExtract(path);
			if (totalSavings(savingsDelta) === 0 && totalExtractionEvents(extractionDelta) === 0) continue;
			try {
				const saved = saveStatsDeltas(path, savingsDelta, extractionDelta);
				const remainingSavings = subtractSavings(pendingSavings(path), savingsDelta);
				const remainingExtraction = subtractExtractionTelemetry(pendingExtract(path), extractionDelta);
				if (totalSavings(remainingSavings) === 0) pendingStats.delete(path);
				else pendingStats.set(path, remainingSavings);
				if (totalExtractionEvents(remainingExtraction) === 0) pendingExtraction.delete(path);
				else pendingExtraction.set(path, remainingExtraction);
				if (loadedStatsPath === path) {
					baseLifetime = saved.savings;
					baseExtraction = saved.extraction;
				}
			} catch {
				// Keep the delta pending and fail open.
			}
		}
	};
	const ensureStatsLoaded = (ctx: ExtensionContext): string => {
		const path = getStatsFilePath(ctx.cwd);
		if (path !== loadedStatsPath) {
			loadedStatsPath = undefined;
			try {
				baseLifetime = loadStatsFile(path);
				baseExtraction = loadExtractionTelemetryFile(path);
				loadedStatsPath = path;
			} catch {
				baseLifetime = { ...EMPTY_SAVINGS };
				baseExtraction = { ...EMPTY_EXTRACTION_TELEMETRY };
			}
		}
		return path;
	};
	const flushUsage = (onlyPath?: string, ctx?: ExtensionContext): void => {
		const paths = onlyPath ? [onlyPath] : [...pendingUsage.keys()];
		for (const path of paths) {
			const delta = pendingUsage.get(path);
			if (!delta || usageCount(delta) === 0) continue;
			try {
				const saved = saveUsageDelta(path, delta, ctx ? usagePruneOptions(ctx, usageStats) : undefined);
				pendingUsage.delete(path);
				if (loadedUsagePath === path) usageStats = saved;
			} catch (err) {
				ctx?.ui.notify(`skill-optimizer: failed to save usage stats (${(err as Error).message})`, "warning");
			}
		}
	};
	const resetLastRequest = (ctx: ExtensionContext): void => {
		lastRemovedChars = 0;
		lastSelected = [];
		lastDroppedTools = 0;
		setStatus(ctx, undefined);
	};

	const ensureStateLoaded = (ctx: ExtensionContext): void => {
		const profilePaths = getProfilePaths(ctx.cwd);
		const profileKey = `${profilePaths.global}::${profilePaths.project}`;
		if (profileKey !== loadedProfilePath) {
			loadedProfilePath = undefined;
			try {
				activeProfile = loadMergedProfile(profilePaths);
				setUserAliasCandidates(activeProfile.aliases);
				loadedProfilePath = profileKey;
			} catch (err) {
				activeProfile = EMPTY_PROFILE;
				setUserAliasCandidates({});
				ctx.ui.notify(`skill-optimizer: failed to load profile (${(err as Error).message})`, "warning");
			}
		}
		const usagePath = getUsageFilePath(ctx.cwd);
		if (usagePath === loadedUsagePath) return;
		if (loadedUsagePath) flushUsage(loadedUsagePath, ctx);
		loadedUsagePath = undefined;
		try {
			const loaded = loadUsageFile(usagePath);
			const pruneOptions = usagePruneOptions(ctx, loaded);
			usageStats = pruneUsageStats(loaded, pruneOptions);
			if (usageStats !== loaded) usageStats = pruneUsageFile(usagePath, pruneOptions);
			loadedUsagePath = usagePath;
			seenUsageEvidence.clear();
		} catch (err) {
			usageStats = {};
			ctx.ui.notify(`skill-optimizer: failed to load usage stats (${(err as Error).message})`, "warning");
		}
	};

	const initAliases = async (ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]): Promise<void> => {
		if (!ctx.model) {
			ctx.ui.notify("skill-optimizer: no model selected", "error");
			return;
		}
		// Capture the (now non-null) model so the batch callback keeps the narrowed type
		// across its closure boundary.
		const model = ctx.model;
		const skills = ctx.getSystemPromptOptions().skills ?? [];
		if (skills.length === 0) {
			ctx.ui.notify("skill-optimizer: no skills available in current prompt options", "warning");
			return;
		}

		const paths = getProfilePaths(ctx.cwd);
		let stored: ReturnType<typeof readStoredProfile>;
		let projectStored: ReturnType<typeof readStoredProfile> | undefined;
		try {
			stored = readStoredProfile(paths.global);
			projectStored = paths.project !== paths.global ? readStoredProfile(paths.project) : undefined;
		} catch (err) {
			ctx.ui.notify(`skill-optimizer: failed to read existing profile (${(err as Error).message})`, "error");
			return;
		}
		const baseProfile = projectStored?.exists ? mergeProfiles(stored.profile, projectStored.profile) : stored.profile;
		const storedHashes = projectStored?.exists ? { ...stored.hashes, ...projectStored.hashes } : stored.hashes;

		// A tool/prompt upgrade (INIT_VERSION bump) forces a full regeneration; otherwise
		// only new/modified skills are sent to the model and removed ones are pruned.
		const forceFull = !stored.exists
			|| stored.initVersion !== INIT_VERSION
			|| (!!projectStored?.exists && projectStored.initVersion !== INIT_VERSION);
		const { changed, removed, hashes } = diffSkills(
			skills.map((skill) => ({ name: skill.name, description: skill.description })),
			forceFull ? {} : storedHashes,
		);

		if (!forceFull && changed.length === 0 && removed.length === 0) {
			ctx.ui.notify(`skill-optimizer: profile already up to date (${skills.length} skills)`, "info");
			return;
		}

		let partial: SkillOptimizerProfile = EMPTY_PROFILE;
		let appliedChanged: string[] = [];
		let failedChanged: string[] = [];
		if (changed.length > 0) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify(`skill-optimizer: ${auth.ok ? `no API key for ${ctx.model.provider}` : auth.error}`, "error");
				return;
			}
			const changedSet = new Set(changed);
			const targetSkills = skills.filter((skill) => changedSet.has(skill.name));
			const systemPrompt = [
				"You generate a compact JSON retrieval profile for lexical skill retrieval.",
				"Return only JSON. No markdown.",
				"Include processedSkills as an array containing every input skill name exactly as given after inspecting it.",
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
			const batchCount = Math.max(1, Math.ceil(targetSkills.length / INIT_BATCH_SIZE));
			ctx.ui.notify(`skill-optimizer: ${forceFull ? "regenerating" : "updating"} profile for ${targetSkills.length} skill(s) in ${batchCount} batch(es) with ${model.id}...`, "info");
			const result = await generateProfileInBatches(targetSkills, INIT_BATCH_SIZE, async (batch, i, total) => {
				const label = total > 1 ? `batch ${i + 1}/${total}` : "profile generation";
				const skillLines = batch
					.map((skill) => `- ${skill.name}: ${skill.description.slice(0, 240)}`)
					.join("\n");
				const userMessage: UserMessage = {
					role: "user",
					content: [{ type: "text", text: `Skills:\n${skillLines}` }],
					timestamp: Date.now(),
				};
				let response: Awaited<ReturnType<typeof complete>>;
				try {
					response = await complete(
						model,
						{ systemPrompt, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers },
					);
				} catch (err) {
					ctx.ui.notify(`skill-optimizer: ${label} request failed (${(err as Error).message})`, "warning");
					return undefined;
				}
				const outcome = interpretBatchResponse(response);
				if (outcome.status === "failed") {
					ctx.ui.notify(`skill-optimizer: ${label} ${outcome.reason}`, "warning");
					return undefined;
				}
				return { profile: outcome.profile, processedSkills: outcome.processedSkills };
			});
			if (!result) {
				ctx.ui.notify(`skill-optimizer: profile generation failed for all ${batchCount} batch(es); no changes written`, "error");
				return;
			}
			partial = result.partial;
			appliedChanged = changed.filter((name) => result.applied.has(name));
			failedChanged = changed.filter((name) => !result.applied.has(name));
		}

		// Failed batches keep their hashes dropped so the next init retries only them.
		const finalHashes = computeFinalHashes(hashes, failedChanged);
		const profile = mergeIncrementalProfile(pruneProfileNames(forceFull ? EMPTY_PROFILE : baseProfile, removed), partial, appliedChanged);
		const newCount = appliedChanged.filter((name) => !(name in storedHashes)).length;
		const summary = `${forceFull ? "full" : "incremental"}: +${newCount} new, ~${appliedChanged.length - newCount} changed, -${removed.length} removed${failedChanged.length > 0 ? `, ${failedChanged.length} failed (will retry)` : ""}`;
		const projectNames = new Set(
			skills
				.filter((skill) => (skill as { sourceInfo?: { scope?: string } }).sourceInfo?.scope === "project")
				.map((skill) => skill.name),
		);
		const splitEnabled = paths.project !== paths.global && projectNames.size > 0;

		if (!splitEnabled) {
			const writes: ProfileWrite[] = [{ path: paths.global, profile, skillCount: skills.length, hashes: finalHashes, expectedRevision: stored.revision }];
			if (projectStored?.exists) {
				writes.push({ path: paths.project, profile: EMPTY_PROFILE, skillCount: 0, hashes: {}, expectedRevision: projectStored.revision });
			}
			try {
				writeProfileFiles(writes, INIT_VERSION);
			} catch (err) {
				const detail = err instanceof ConcurrentFileUpdateError ? "profile changed concurrently; run init again" : (err as Error).message;
				ctx.ui.notify(`skill-optimizer: profile was not saved (${detail})`, "error");
				return;
			}
			activeProfile = profile;
			setUserAliasCandidates(profile.aliases);
			loadedProfilePath = `${paths.global}::${paths.project}`;
			ctx.ui.notify(`skill-optimizer: ${summary}; ${profileSummary(profile)} → ${paths.global}`, "info");
			return;
		}

		const { global: globalProfile, project: projectProfile } = splitProfileByScope(profile, projectNames);
		const globalHashes = pickKeys(finalHashes, (name) => !projectNames.has(name));
		const projectHashes = pickKeys(finalHashes, (name) => projectNames.has(name));
		try {
			writeProfileFiles([
				{ path: paths.global, profile: globalProfile, skillCount: Object.keys(globalHashes).length, hashes: globalHashes, expectedRevision: stored.revision },
				{ path: paths.project, profile: projectProfile, skillCount: Object.keys(projectHashes).length, hashes: projectHashes, expectedRevision: projectStored?.revision ?? null },
			], INIT_VERSION);
		} catch (err) {
			const detail = err instanceof ConcurrentFileUpdateError ? "profile changed concurrently; run init again" : (err as Error).message;
			ctx.ui.notify(`skill-optimizer: profiles were not saved (${detail})`, "error");
			return;
		}
		activeProfile = mergeProfiles(globalProfile, projectProfile);
		setUserAliasCandidates(activeProfile.aliases);
		loadedProfilePath = `${paths.global}::${paths.project}`;
		ctx.ui.notify(`skill-optimizer: ${summary}; global ${profileSummary(globalProfile)}, project ${profileSummary(projectProfile)}`, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		seenUsageEvidence.clear();
		sessionSaved = { ...EMPTY_SAVINGS };
		sessionExtraction = { ...EMPTY_EXTRACTION_TELEMETRY };
		lastFlushAt = 0;
		resetLastRequest(ctx);
		try {
			const created = ensureGlobalConfigTemplate();
			if (created) ctx.ui.notify(`skill-optimizer: wrote default config to ${created} (edit to configure)`, "info");
		} catch {
			// non-fatal: config template is a convenience
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		resetLastRequest(ctx);
		if (isDisabled(ctx.cwd)) {
			return;
		}
		const providers = getScopeProviders(ctx.cwd);
		if (providers && ctx.model && !providers.includes(ctx.model.provider)) {
			return;
		}
		ensureStateLoaded(ctx);
		if (loadedUsagePath) flushUsage(loadedUsagePath, ctx);

		const config = {
			...getConfig(ctx.cwd),
			profile: activeProfile,
			pinnedSkills: selectPinnedSkills(usageStats, getPinnedTopK(ctx.cwd)),
		};
		const statsPath = ensureStatsLoaded(ctx);
		const { next, removedChars, removedSkills, removedTools, selected, droppedTools } = optimize(event.payload, config);
		lastRemovedChars = removedChars;
		lastSelected = selected;
		lastDroppedTools = droppedTools.length;
		if (removedChars > 0) {
			sessionSaved.skills += removedSkills;
			sessionSaved.tools += removedTools;
			addPendingSavings(statsPath, { skills: removedSkills, tools: removedTools, output: 0 });
			setStatus(ctx, `✂ −${approxK(removedChars)} tok`);
		} else {
			setStatus(ctx, undefined);
		}
		// Persist telemetry periodically so it survives even without a clean shutdown.
		if (Date.now() - lastFlushAt > 15_000 && (totalSavings(pendingSavings(statsPath)) > 0 || totalExtractionEvents(pendingExtract(statsPath)) > 0)) {
			lastFlushAt = Date.now();
			flushStats(statsPath);
		}
		if (loadedUsagePath) {
			const evidence = collectSkillUsageEvidence(event.payload, selected).slice(-maxUsageEvidence);
			let delta = pendingUsage.get(loadedUsagePath) ?? {};
			const now = Date.now();
			for (const entry of evidence) {
				if (seenUsageEvidence.has(entry.key)) continue;
				seenUsageEvidence.add(entry.key);
				usageStats = recordSkillUsage(usageStats, [entry.name], now);
				delta = recordSkillUsage(delta, [entry.name], now);
				while (seenUsageEvidence.size > maxUsageEvidence) {
					const oldest = seenUsageEvidence.values().next().value as string | undefined;
					if (!oldest) break;
					seenUsageEvidence.delete(oldest);
				}
			}
			if (usageCount(delta) > 0) pendingUsage.set(loadedUsagePath, delta);
			flushUsage(loadedUsagePath, ctx);
		}
		return next === event.payload ? undefined : next;
	});

	// Transparent tool-output reduction: shrink noisy tool results (e.g. bash) once,
	// at production time. `smart` = deterministic head/tail/error keep; `extract` =
	// query-aware "intelligent grep" via a weak same-provider model (fails open to
	// `smart`). Errors stay verbatim and the full output is saved to a temp file.
	// Off by default; opt in via config `outputMode`.
	// Detect a coexisting `rtk`-named extension (it has its own output compaction).
	// These hooks expose no authoritative main-provider cache read/write usage, so
	// cache telemetry is deliberately not inferred and no dynamic prompt block is
	// injected merely to measure it.
	let rtkPresence: boolean | undefined;
	const rtkExtensionPresent = (): boolean => {
		if (rtkPresence !== undefined) return rtkPresence;
		rtkPresence = false;
		try {
			const getCommands = (pi as { getCommands?: () => Array<{ name?: string; source?: string; sourceInfo?: { path?: string; source?: string } }> }).getCommands;
			const commands = typeof getCommands === "function" ? getCommands.call(pi) : [];
			rtkPresence = commands.some((c) => isRtkSource(c.name ?? "", c.sourceInfo?.path ?? "", c.sourceInfo?.source ?? c.source ?? ""));
		} catch {
			rtkPresence = false;
		}
		return rtkPresence;
	};

	pi.on("tool_result", async (event, ctx) => {
		if (isDisabled(ctx.cwd)) return;
		const outCfg = getOutputConfig(ctx.cwd);
		if (outCfg.mode === "off") return;
		// Coexist with rtk: it already compacts tool output, so skip ours to avoid double-processing.
		if (outCfg.disableWithRtk && rtkExtensionPresent()) return;
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
		const statsPath = ensureStatsLoaded(ctx);

		let changed = false;
		const next: typeof content = [];
		for (const block of content) {
			if (!block || typeof block !== "object") { next.push(block); continue; }
			const b = block as { type?: unknown; text?: unknown };
			if (b.type !== "text" || typeof b.text !== "string") { next.push(block); continue; }
			const text = b.text;
			if (text.split(/\r?\n/).length <= outCfg.maxLines && utf8ByteLength(text) <= DEFAULT_OUTPUT_OPTIONS.maxBytes) { next.push(block); continue; }

			const smartOptions = {
				maxLines: outCfg.maxLines,
				minSavingsBytes: outCfg.minSavingsBytes,
				minSavingsRatio: outCfg.minSavingsRatio,
			};
			let result: ReturnType<typeof reduceOutput>;
			let how = "smart";
			if (outCfg.mode === "extract" && !isExcludedCommand(command, outCfg.extractExclude)) {
				const extracted = await tryExtractOutput(ctx, outCfg.model, request, command, text);
				let outcome: Exclude<keyof ExtractionTelemetry, "attempts">;
				if (extracted === undefined) {
					result = reduceOutput(text, smartOptions);
					outcome = "fallbackError";
					how = "smart fallback";
				} else {
					const validated = validateExtractedOutput(text, extracted, {
						smartOptions,
						minSavingsBytes: outCfg.minSavingsBytes,
						minSavingsRatio: outCfg.minSavingsRatio,
					});
					result = validated;
					if (validated.strategy === "extract") {
						outcome = "accepted";
						how = "extracted";
					} else {
						const reason: ExtractRejectionReason | undefined = validated.rejectionReason;
						outcome = reason === "insufficient-benefit"
							? "fallbackSavings"
							: reason === "empty-extraction"
								? "fallbackError"
								: "fallbackEvidence";
						how = validated.strategy === "smart" ? "smart fallback" : "original";
					}
				}
				const telemetry: ExtractionTelemetry = { ...EMPTY_EXTRACTION_TELEMETRY, attempts: 1 };
				telemetry[outcome] = 1;
				sessionExtraction = addExtractionTelemetry(sessionExtraction, telemetry);
				addPendingExtraction(statsPath, telemetry);
			} else {
				result = reduceOutput(text, smartOptions);
			}
			if (!result.reduced) { next.push(block); continue; }
			const body = result.text;
			const fullOutputPath = saveTemporaryOutput(text);
			if (!fullOutputPath) { next.push(block); continue; }
			const note = `${how} ${result.fromLines}\u2192${result.toLines} lines; ${text.length}\u2192${body.length} chars; ${result.fromBytes}\u2192${result.toBytes} UTF-8 bytes; estimated ~${approxK(text.length)}\u2192~${approxK(body.length)} tokens; full output: ${fullOutputPath}`;
			const rendered = `${body}\n[skill-optimizer: ${note}]`;
			changed = true;
			if (text.length > rendered.length) {
				const removedOutput = text.length - rendered.length;
				sessionSaved.output += removedOutput;
				addPendingSavings(statsPath, { skills: 0, tools: 0, output: removedOutput });
			}
			next.push({ ...b, text: rendered });
		}
		if (Date.now() - lastFlushAt > 15_000 && (totalSavings(pendingSavings(statsPath)) > 0 || totalExtractionEvents(pendingExtract(statsPath)) > 0)) {
			lastFlushAt = Date.now();
			flushStats(statsPath);
		}
		if (!changed) return;
		return { content: next };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		flushUsage(undefined, ctx);
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
				: `global ${profilePaths.global}${fileExists(profilePaths.project) ? `, project ${profilePaths.project}` : ""}`;
			const configPaths = getConfigPaths(ctx.cwd);
			const configLocations = `${fileExists(configPaths.global) ? configPaths.global : `${configPaths.global} (missing)`}${fileExists(configPaths.project) ? `, project ${configPaths.project}` : ""}`;
			const usagePath = getUsageFilePath(ctx.cwd);
			const statsPath = ensureStatsLoaded(ctx);
			flushStats(statsPath);
			const lifetime = addSavings(baseLifetime, pendingSavings(statsPath));
			const lifetimeExtraction = addExtractionTelemetry(baseExtraction, pendingExtract(statsPath));
			const byArea = (s: SavingsByArea): string => `skills ${s.skills}, tools ${s.tools}, output ${s.output} chars (total ${totalSavings(s)} chars, ~${approxK(totalSavings(s))} tok)`;
			const extractSummary = (s: ExtractionTelemetry): string => `${s.accepted}/${s.attempts} accepted; fallback evidence ${s.fallbackEvidence}, savings ${s.fallbackSavings}, error ${s.fallbackError}`;
			const lines = [
				"pi-skill-optimizer",
				`  enabled:        ${isDisabled(ctx.cwd) ? "no (disabled)" : "yes"}`,
				`  config:         ${configLocations}`,
				`  skills mode:    ${config.mode}${config.mode === "hybrid" ? ` (top ${config.topK}, tail ${config.tail})` : ""}`,
				`  tools mode:     ${config.toolsMode}${config.toolsMode === "drop" ? ` (${config.toolsDropPrefixes.join(", ") || "no prefixes set"})` : config.toolsMode === "relevance" ? ` (top ${config.toolsTopK} + core + used)` : ""}`,
				`  output mode:    ${(() => { const o = getOutputConfig(ctx.cwd); if (o.mode === "off") return "off"; if (o.disableWithRtk && rtkExtensionPresent()) return `off (rtk extension detected; set outputDisableWithRtk:false to override)`; return `${o.mode} (>${o.maxLines} lines; min ${o.minSavingsBytes} bytes and ${Math.round(o.minSavingsRatio * 100)}%; tools: ${o.tools.join(", ")})`; })()}`,
				`  scope:          ${providers ? providers.join(", ") : "all providers"}`,
				`  profile:        ${profileSummary(activeProfile)} (${profileLocations})`,
				`  critical:       ${activeProfile.critical.join(", ") || "none"}`,
				`  pinned:         ${selectPinnedSkills(usageStats, getPinnedTopK(ctx.cwd)).join(", ") || "none"} (${usageCount(usageStats)} tracked, ${usagePath})`,
				`  saved (session): ${byArea(sessionSaved)}`,
				`  saved (lifetime):${byArea(lifetime)}`,
				`  extract session: ${extractSummary(sessionExtraction)}`,
				`  extract lifetime:${extractSummary(lifetimeExtraction)}`,
				`  last request:   ${lastRemovedChars} chars removed (~${approxK(lastRemovedChars)} tokens), ${lastDroppedTools} tools dropped`,
			];
			if (config.alwaysFull && config.alwaysFull.length > 0) lines.push(`  always full:    ${config.alwaysFull.join(", ")}`);
			if (config.never && config.never.length > 0) lines.push(`  never:          ${config.never.join(", ")}`);
			if (lastSelected.length > 0) lines.push(`  last relevant:  ${lastSelected.join(", ")}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
