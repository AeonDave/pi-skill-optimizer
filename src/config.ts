/**
 * Configuration for the skill optimizer.
 *
 * Primary source is a `config.json` file; an env var overrides it for one-off
 * runs. Resolution order for every setting:
 *   env var > project `config.json` > global `config.json` > built-in default.
 *
 * Files mirror Pi's skill layout:
 *   - global: `<agentDir>/skill-optimizer/`     (e.g. `~/.pi/agent/skill-optimizer/`)
 *   - project: `<cwd>/.pi/skill-optimizer/`     (merged over global, project wins)
 *
 * config.json keys (see `defaultConfigJson`): disable, mode, topK, tail,
 * alwaysFull, never, providers, pinnedTopK, toolsMode, toolsDrop, toolsTopK,
 * toolsProtect, outputMode, outputMaxLines, outputTools, outputModel, outputExtractExclude.
 *
 * Matching env vars: PI_SKILL_OPTIMIZER_{DISABLE, MODE, TOP_K, TAIL, ALWAYS_FULL,
 * NEVER, PROVIDERS, PINNED_TOP_K, TOOLS_MODE, TOOLS_DROP, TOOLS_TOP_K,
 * TOOLS_PROTECT}. PI_SKILL_OPTIMIZER_PROFILE / PI_SKILL_OPTIMIZER_USAGE override
 * the generated profile / usage file paths.
 */

import type { OptimizeConfig } from "./optimize.ts";
import type { SkillMode, TailStyle } from "./skills.ts";
import type { ToolsMode } from "./tools.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Subdir name under the agent dir and the project `.pi` dir where optimizer state lives. */
const STATE_SUBDIR = "skill-optimizer";
const PROFILE_FILE = "profile.json";
const USAGE_FILE = "usage.json";
const CONFIG_FILE = "config.json";

/** Global per-user state dir (mirrors where Pi keeps global skills: ~/.pi/agent/skills). */
function globalStateDir(): string {
	try {
		return join(getAgentDir(), STATE_SUBDIR);
	} catch {
		return join(homedir(), CONFIG_DIR_NAME || ".pi", "agent", STATE_SUBDIR);
	}
}

/** Project-local state dir (mirrors where Pi keeps project skills: <cwd>/.pi/skills). */
function projectStateDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME || ".pi", STATE_SUBDIR);
}

const MODES: readonly SkillMode[] = ["off", "compact", "hybrid"];
const OUTPUT_MODES: readonly OutputMode[] = ["off", "smart", "extract"];
const TAILS: readonly TailStyle[] = ["name", "intent"];
const TOOLS_MODES: readonly ToolsMode[] = ["off", "drop", "relevance"];

export type OutputMode = "off" | "smart" | "extract";

export const DEFAULTS = {
	mode: "hybrid" as SkillMode,
	topK: 20,
	// Tail skills render as name-only and their derivable location is replaced by a
	// single path note, so every skill stays loadable at minimal token cost. Use
	// `intent` to also keep a short description on the tail (more discovery, more tokens).
	tail: "name" as TailStyle,
	pinnedTopK: 8,
	// Transparent tool-output reduction. Default ON in `smart` mode: large tool
	// outputs are deterministically reduced (head + tail + error lines, free), with
	// the full output saved to a temp file referenced inline. `extract` (opt-in)
	// instead turns big output into request-ready data via a model. `off` disables.
	outputMode: "smart" as OutputMode,
	outputMaxLines: 400,
	outputTools: ["bash"] as readonly string[],
	// `extract` mode: model spec "provider/id" or bare id. Empty → use selected model.
	outputModel: "",
	// `extract` mode: commands whose program name is in this list use deterministic
	// `smart` instead of the model — for pure data dumps you want kept verbatim.
	outputExtractExclude: ["cat", "ls", "head", "tail", "tree", "find", "dir", "type"] as readonly string[],
	// Auto-disable tool-output reduction when another loaded extension named like
	// `rtk` is present (it has its own output compaction) to avoid double-processing.
	outputDisableWithRtk: true,
};

export interface OutputConfig {
	mode: OutputMode;
	maxLines: number;
	tools: readonly string[];
	/** `extract` mode: model spec ("provider/id" or bare id). Empty → extract falls back to smart. */
	model: string;
	/** `extract` mode: program names that downgrade to deterministic `smart`. */
	extractExclude: readonly string[];
	/** Auto-disable output reduction when an `rtk`-named extension is also loaded. */
	disableWithRtk: boolean;
}

function warn(message: string): void {
	try {
		process.stderr.write(`[skill-optimizer] ${message}\n`);
	} catch {
		// best-effort
	}
}

// ----------------------------------------------------------------------------
// File config (config.json): global `<agentDir>/skill-optimizer/config.json`
// overridden by project `<cwd>/.pi/skill-optimizer/config.json`. Resolution
// order for every setting: env var > project config.json > global config.json >
// built-in default.
// ----------------------------------------------------------------------------

type FileConfig = Record<string, unknown>;

let fileConfigCache: { key: string; value: FileConfig } | undefined;

function fileSignature(path: string): string {
	try {
		const s = statSync(path);
		return `${s.size}:${s.mtimeMs}`;
	} catch {
		return "none";
	}
}

function readConfigFile(path: string): FileConfig {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as FileConfig;
		warn(`${path}: expected a JSON object`);
	} catch (err) {
		warn(`${path}: invalid JSON (${(err as Error).message})`);
	}
	return {};
}

/** Load + merge global then project config.json (project keys win). Cached by mtime. */
function loadFileConfig(cwd: string): FileConfig {
	const { global, project } = getConfigPaths(cwd);
	const key = `${global}|${fileSignature(global)}|${project}|${fileSignature(project)}`;
	if (fileConfigCache?.key === key) return fileConfigCache.value;
	const merged: FileConfig = { ...readConfigFile(global), ...(project === global ? {} : readConfigFile(project)) };
	fileConfigCache = { key, value: merged };
	return merged;
}

function pickInt(envName: string, fileVal: unknown, fallback: number): number {
	const raw = process.env[envName]?.trim();
	if (raw) {
		const n = Number(raw);
		if (Number.isInteger(n) && n >= 0) return n;
		warn(`${envName}: expected a non-negative integer`);
	}
	if (typeof fileVal === "number" && Number.isInteger(fileVal) && fileVal >= 0) return fileVal;
	if (fileVal !== undefined && fileVal !== null) warn(`config "${envName}": expected a non-negative integer`);
	return fallback;
}

function pickStringArray(envName: string, fileVal: unknown): string[] {
	const raw = process.env[envName]?.trim();
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
			warn(`${envName}: expected a JSON array of strings`);
		} catch (err) {
			warn(`${envName}: invalid JSON (${(err as Error).message})`);
		}
	}
	if (Array.isArray(fileVal) && fileVal.every((v) => typeof v === "string")) return fileVal as string[];
	if (fileVal !== undefined && fileVal !== null) warn(`config "${envName}": expected an array of strings`);
	return [];
}

function pickMode(fileVal: unknown): SkillMode {
	const raw = process.env.PI_SKILL_OPTIMIZER_MODE?.trim().toLowerCase();
	if (raw) {
		if ((MODES as readonly string[]).includes(raw)) return raw as SkillMode;
		warn(`PI_SKILL_OPTIMIZER_MODE: unknown mode "${raw}" (use off|compact|hybrid)`);
	}
	if (typeof fileVal === "string" && (MODES as readonly string[]).includes(fileVal.toLowerCase())) {
		return fileVal.toLowerCase() as SkillMode;
	}
	if (fileVal !== undefined && fileVal !== null) warn(`config "mode": expected off|compact|hybrid`);
	return DEFAULTS.mode;
}

function pickToolsMode(fileVal: unknown): ToolsMode {
	const raw = process.env.PI_SKILL_OPTIMIZER_TOOLS_MODE?.trim().toLowerCase();
	if (raw) {
		if ((TOOLS_MODES as readonly string[]).includes(raw)) return raw as ToolsMode;
		warn(`PI_SKILL_OPTIMIZER_TOOLS_MODE: unknown mode "${raw}" (use off|drop|relevance)`);
	}
	if (typeof fileVal === "string" && (TOOLS_MODES as readonly string[]).includes(fileVal.toLowerCase())) {
		return fileVal.toLowerCase() as ToolsMode;
	}
	if (fileVal !== undefined && fileVal !== null) warn(`config "toolsMode": expected off|drop|relevance`);
	return "off";
}

function pickTail(fileVal: unknown): TailStyle {
	const raw = process.env.PI_SKILL_OPTIMIZER_TAIL?.trim().toLowerCase();
	if (raw) {
		if ((TAILS as readonly string[]).includes(raw)) return raw as TailStyle;
		warn(`PI_SKILL_OPTIMIZER_TAIL: unknown style "${raw}" (use name|intent)`);
	}
	if (typeof fileVal === "string" && (TAILS as readonly string[]).includes(fileVal.toLowerCase())) {
		return fileVal.toLowerCase() as TailStyle;
	}
	if (fileVal !== undefined && fileVal !== null) warn(`config "tail": expected name|intent`);
	return DEFAULTS.tail;
}

/** True when the user has switched the optimizer off entirely (env or config.json). */
export function isDisabled(cwd = process.cwd()): boolean {
	if (process.env.PI_SKILL_OPTIMIZER_DISABLE?.trim()) return true;
	return loadFileConfig(cwd).disable === true;
}

/** The full optimizer configuration: env > project config.json > global config.json > defaults. */
export function getConfig(cwd = process.cwd()): OptimizeConfig {
	const file = loadFileConfig(cwd);
	return {
		mode: pickMode(file.mode),
		topK: pickInt("PI_SKILL_OPTIMIZER_TOP_K", file.topK, DEFAULTS.topK),
		tail: pickTail(file.tail),
		alwaysFull: pickStringArray("PI_SKILL_OPTIMIZER_ALWAYS_FULL", file.alwaysFull),
		never: pickStringArray("PI_SKILL_OPTIMIZER_NEVER", file.never),
		toolsMode: pickToolsMode(file.toolsMode),
		toolsDropPrefixes: pickStringArray("PI_SKILL_OPTIMIZER_TOOLS_DROP", file.toolsDrop),
		toolsTopK: pickInt("PI_SKILL_OPTIMIZER_TOOLS_TOP_K", file.toolsTopK, 24),
		toolsProtect: pickStringArray("PI_SKILL_OPTIMIZER_TOOLS_PROTECT", file.toolsProtect),
	};
}

/** Tool-output reduction config: env > project config.json > global config.json > defaults. */
export function getOutputConfig(cwd = process.cwd()): OutputConfig {
	const file = loadFileConfig(cwd);
	const rawMode = process.env.PI_SKILL_OPTIMIZER_OUTPUT?.trim().toLowerCase();
	let mode: OutputMode = DEFAULTS.outputMode;
	if (rawMode) {
		if ((OUTPUT_MODES as readonly string[]).includes(rawMode)) mode = rawMode as OutputMode;
		else warn(`PI_SKILL_OPTIMIZER_OUTPUT: unknown mode "${rawMode}" (use off|smart|extract)`);
	} else if (typeof file.outputMode === "string" && (OUTPUT_MODES as readonly string[]).includes(file.outputMode.toLowerCase())) {
		mode = file.outputMode.toLowerCase() as OutputMode;
	} else if (file.outputMode !== undefined && file.outputMode !== null) {
		warn(`config "outputMode": expected off|smart|extract`);
	}
	const tools = pickStringArray("PI_SKILL_OPTIMIZER_OUTPUT_TOOLS", file.outputTools);
	const modelEnv = process.env.PI_SKILL_OPTIMIZER_OUTPUT_MODEL?.trim();
	const model = modelEnv || (typeof file.outputModel === "string" ? file.outputModel.trim() : "");
	const exclude = pickStringArray("PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE", file.outputExtractExclude);
	const rawDwr = process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK?.trim().toLowerCase();
	let disableWithRtk = DEFAULTS.outputDisableWithRtk;
	if (rawDwr) disableWithRtk = ["1", "true", "yes", "on"].includes(rawDwr);
	else if (typeof file.outputDisableWithRtk === "boolean") disableWithRtk = file.outputDisableWithRtk;
	return {
		mode,
		maxLines: pickInt("PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES", file.outputMaxLines, DEFAULTS.outputMaxLines),
		tools: tools.length > 0 ? tools : DEFAULTS.outputTools,
		model,
		extractExclude: exclude.length > 0 ? exclude : DEFAULTS.outputExtractExclude,
		disableWithRtk,
	};
}

/** Provider ids to scope to, or `undefined` for every provider (env or config.json). */
export function getScopeProviders(cwd = process.cwd()): string[] | undefined {
	const raw = process.env.PI_SKILL_OPTIMIZER_PROVIDERS?.trim();
	if (raw) {
		const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
		return ids.length > 0 ? ids : undefined;
	}
	const fileVal = loadFileConfig(cwd).providers;
	if (Array.isArray(fileVal)) {
		const ids = fileVal.filter((v): v is string => typeof v === "string").map((id) => id.trim()).filter(Boolean);
		return ids.length > 0 ? ids : undefined;
	}
	return undefined;
}

function isAbsolutePath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]|^[/\\]/.test(value);
}

/**
 * Global + project config.json paths. Both are loaded and merged at runtime
 * (project keys override global). Layout mirrors Pi's skill dirs.
 */
export function getConfigPaths(cwd: string): { global: string; project: string } {
	return {
		global: join(globalStateDir(), CONFIG_FILE),
		project: join(projectStateDir(cwd), CONFIG_FILE),
	};
}

/** A documented default config.json template users can edit. */
export function defaultConfigJson(): string {
	const template = {
		disable: false,
		mode: DEFAULTS.mode, // off | compact | hybrid
		topK: DEFAULTS.topK, // hybrid: skills kept full (name + description + location)
		tail: DEFAULTS.tail, // name | intent (how the rest are rendered)
		alwaysFull: [] as string[], // skill names to always keep full
		never: [] as string[], // skill names/prefix* to hide entirely
		providers: [] as string[], // model.provider ids to scope to; [] = all
		pinnedTopK: DEFAULTS.pinnedTopK, // usage-derived skills kept full
		toolsMode: "off", // off | drop | relevance
		toolsDrop: [] as string[], // drop: tool name prefixes to remove
		toolsTopK: 24, // relevance: non-core tools to keep
		toolsProtect: [] as string[], // extra protected tool names/prefixes
		outputMode: DEFAULTS.outputMode, // off | smart | extract
		outputMaxLines: DEFAULTS.outputMaxLines, // reduce a tool result only above this many lines
		outputTools: DEFAULTS.outputTools as string[], // which tool results to reduce
		outputModel: DEFAULTS.outputModel, // extract mode: weak model id ("provider/id" or bare id)
		outputExtractExclude: DEFAULTS.outputExtractExclude as string[], // extract: program names kept on deterministic smart
		outputDisableWithRtk: DEFAULTS.outputDisableWithRtk, // auto-off output reduction if an rtk extension is loaded
	};
	return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Write the global config.json template if it does not exist yet, so users have
 * a discoverable, editable file. Never overwrites an existing config. Returns the
 * path when created, otherwise `undefined`.
 */
export function ensureGlobalConfigTemplate(): string | undefined {
	const path = getConfigPaths(process.cwd()).global;
	if (existsSync(path)) return undefined;
	try {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, defaultConfigJson(), "utf8");
		return path;
	} catch (err) {
		warn(`failed to write default config (${(err as Error).message})`);
		return undefined;
	}
}

/**
 * Global + project profile file paths, mirroring how Pi loads skills:
 * global from `<agentDir>/skill-optimizer/`, project from `<cwd>/.pi/skill-optimizer/`.
 * An explicit `PI_SKILL_OPTIMIZER_PROFILE` collapses both onto that single file.
 */
export function getProfilePaths(cwd: string): { global: string; project: string } {
	const raw = process.env.PI_SKILL_OPTIMIZER_PROFILE?.trim();
	if (raw) {
		const resolved = isAbsolutePath(raw) ? raw : join(cwd, raw);
		return { global: resolved, project: resolved };
	}
	return {
		global: join(globalStateDir(), PROFILE_FILE),
		project: join(projectStateDir(cwd), PROFILE_FILE),
	};
}

/** Usage stats path (global only). Overridable with `PI_SKILL_OPTIMIZER_USAGE`. */
export function getUsageFilePath(cwd: string): string {
	const raw = process.env.PI_SKILL_OPTIMIZER_USAGE?.trim();
	if (raw) return isAbsolutePath(raw) ? raw : join(cwd, raw);
	return join(globalStateDir(), USAGE_FILE);
}

/** Telemetry stats path (global only). Overridable with `PI_SKILL_OPTIMIZER_STATS`. */
export function getStatsFilePath(cwd: string): string {
	const raw = process.env.PI_SKILL_OPTIMIZER_STATS?.trim();
	if (raw) return isAbsolutePath(raw) ? raw : join(cwd, raw);
	return join(globalStateDir(), "stats.json");
}

export function getPinnedTopK(cwd = process.cwd()): number {
	return pickInt("PI_SKILL_OPTIMIZER_PINNED_TOP_K", loadFileConfig(cwd).pinnedTopK, DEFAULTS.pinnedTopK);
}
