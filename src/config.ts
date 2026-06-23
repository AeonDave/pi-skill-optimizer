/**
 * Environment-driven configuration for the skill optimizer. All optional.
 *
 * | Env var | Default | Purpose |
 * |---------|---------|---------|
 * | `PI_SKILL_OPTIMIZER_DISABLE`       | _(off)_  | Any non-empty value turns the optimizer off entirely. |
 * | `PI_SKILL_OPTIMIZER_MODE`          | `hybrid` | `off` \| `strip` \| `compact` \| `hybrid` — what to do with `<available_skills>`. |
 * | `PI_SKILL_OPTIMIZER_TOP_K`         | `16`     | hybrid: relevant skills kept at full description. |
 * | `PI_SKILL_OPTIMIZER_ADAPTIVE`      | `1`      | adapt top-K upward for ambiguous close scores. |
 * | `PI_SKILL_OPTIMIZER_MIN_TOP_K`     | `8`      | adaptive: minimum relevant skills kept full. |
 * | `PI_SKILL_OPTIMIZER_MAX_TOP_K`     | `24`     | adaptive: maximum relevant skills kept full. |
 * | `PI_SKILL_OPTIMIZER_TAIL_CHARS`    | `0`      | max chars for a compacted description (`0` = name-only). |
 * | `PI_SKILL_OPTIMIZER_FALLBACK_TAIL` | `80`     | weak query: short tail descriptions instead of name-only. |
 * | `PI_SKILL_OPTIMIZER_KEEP_LOCATIONS`| _(off)_  | keep `<location>` on compacted entries too (safer, larger). |
 * | `PI_SKILL_OPTIMIZER_STRIP`         | `[]`     | JSON array of extra XML tag blocks to remove. |
 * | `PI_SKILL_OPTIMIZER_ANCHORS`       | `[]`     | JSON array of substrings; drop whole paragraphs containing one. |
 * | `PI_SKILL_OPTIMIZER_PROVIDERS`     | _(all)_  | Comma list of `model.provider` ids to scope to. |
 * | `PI_SKILL_OPTIMIZER_PROFILE`       | `./.pi-skill-optimizer.profile.json` | Path for generated retrieval profile. |
 * | `PI_SKILL_OPTIMIZER_USAGE`         | `./.pi-skill-optimizer.usage.json` | Path for pinned skill usage stats. |
 * | `PI_SKILL_OPTIMIZER_PINNED_TOP_K`  | `8`      | usage-derived skills always kept full. |
 *
 * Tools array (opt-in — removing a tool has NO fallback; off by default):
 * | `PI_SKILL_OPTIMIZER_TOOLS_MODE`    | `off`    | `off` \| `drop` \| `relevance`. |
 * | `PI_SKILL_OPTIMIZER_TOOLS_DROP`    | `[]`     | drop mode: JSON array of tool name prefixes to remove (e.g. `["htb_","mcpwn_"]`). |
 * | `PI_SKILL_OPTIMIZER_TOOLS_TOP_K`   | `24`     | relevance mode: non-core tools to keep. |
 * | `PI_SKILL_OPTIMIZER_TOOLS_PROTECT` | `[]`     | extra protected tool names/prefixes. |
 */

import type { OptimizeConfig } from "./optimize.ts";
import type { SkillMode } from "./skills.ts";
import type { ToolsMode } from "./tools.ts";
import { join } from "node:path";

const MODES: readonly SkillMode[] = ["off", "strip", "compact", "hybrid"];
const TOOLS_MODES: readonly ToolsMode[] = ["off", "drop", "relevance"];

export const DEFAULTS = {
	mode: "hybrid" as SkillMode,
	topK: 16,
	adaptiveTopK: true,
	minTopK: 8,
	maxTopK: 24,
	// 0 = name-only tail (a skill name already declares intent, and relevance is
	// scored on the FULL descriptions, so a relevant skill is promoted to full
	// regardless). Raise it to keep a short intent line on the tail too.
	tailChars: 0,
	safeFallbackTailChars: 80,
	keepLocations: false,
	pinnedTopK: 8,
};

function warn(message: string): void {
	try {
		process.stderr.write(`[skill-optimizer] ${message}\n`);
	} catch {
		// best-effort
	}
}

function parseStringArray(envName: string): string[] {
	const raw = process.env[envName]?.trim();
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed;
		warn(`${envName}: expected a JSON array of strings`);
	} catch (err) {
		warn(`${envName}: invalid JSON (${(err as Error).message})`);
	}
	return [];
}

function parseInt0(envName: string, fallback: number): number {
	const raw = process.env[envName]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 0) return n;
	warn(`${envName}: expected a non-negative integer`);
	return fallback;
}

function parseBool(envName: string, fallback: boolean): boolean {
	const raw = process.env[envName]?.trim().toLowerCase();
	if (!raw) return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	warn(`${envName}: expected boolean (1/0, true/false, yes/no, on/off)`);
	return fallback;
}

function parseMode(): SkillMode {
	const raw = process.env.PI_SKILL_OPTIMIZER_MODE?.trim().toLowerCase();
	if (!raw) return DEFAULTS.mode;
	if ((MODES as readonly string[]).includes(raw)) return raw as SkillMode;
	warn(`PI_SKILL_OPTIMIZER_MODE: unknown mode "${raw}" (use off|strip|compact|hybrid)`);
	return DEFAULTS.mode;
}

function parseToolsMode(): ToolsMode {
	const raw = process.env.PI_SKILL_OPTIMIZER_TOOLS_MODE?.trim().toLowerCase();
	if (!raw) return "off";
	if ((TOOLS_MODES as readonly string[]).includes(raw)) return raw as ToolsMode;
	warn(`PI_SKILL_OPTIMIZER_TOOLS_MODE: unknown mode "${raw}" (use off|drop|relevance)`);
	return "off";
}

/** True when the user has switched the optimizer off entirely. */
export function isDisabled(): boolean {
	return !!process.env.PI_SKILL_OPTIMIZER_DISABLE?.trim();
}

/** The full optimizer configuration: env overrides, else defaults. */
export function getConfig(): OptimizeConfig {
	return {
		mode: parseMode(),
		topK: parseInt0("PI_SKILL_OPTIMIZER_TOP_K", DEFAULTS.topK),
		adaptiveTopK: parseBool("PI_SKILL_OPTIMIZER_ADAPTIVE", DEFAULTS.adaptiveTopK),
		minTopK: parseInt0("PI_SKILL_OPTIMIZER_MIN_TOP_K", DEFAULTS.minTopK),
		maxTopK: parseInt0("PI_SKILL_OPTIMIZER_MAX_TOP_K", DEFAULTS.maxTopK),
		tailChars: parseInt0("PI_SKILL_OPTIMIZER_TAIL_CHARS", DEFAULTS.tailChars),
		safeFallbackTailChars: parseInt0("PI_SKILL_OPTIMIZER_FALLBACK_TAIL", DEFAULTS.safeFallbackTailChars),
		keepLocations: !!process.env.PI_SKILL_OPTIMIZER_KEEP_LOCATIONS?.trim(),
		extraStripTags: parseStringArray("PI_SKILL_OPTIMIZER_STRIP"),
		dropAnchors: parseStringArray("PI_SKILL_OPTIMIZER_ANCHORS"),
		toolsMode: parseToolsMode(),
		toolsDropPrefixes: parseStringArray("PI_SKILL_OPTIMIZER_TOOLS_DROP"),
		toolsTopK: parseInt0("PI_SKILL_OPTIMIZER_TOOLS_TOP_K", 24),
		toolsProtect: parseStringArray("PI_SKILL_OPTIMIZER_TOOLS_PROTECT"),
	};
}

/** Provider ids to scope to, or `undefined` for every provider. */
export function getScopeProviders(): string[] | undefined {
	const raw = process.env.PI_SKILL_OPTIMIZER_PROVIDERS?.trim();
	if (!raw) return undefined;
	const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
	return ids.length > 0 ? ids : undefined;
}

/** User profile file path. Relative env values are resolved from Pi's cwd. */
export function getProfileFilePath(cwd: string): string {
	const raw = process.env.PI_SKILL_OPTIMIZER_PROFILE?.trim() || process.env.PI_SKILL_OPTIMIZER_ALIASES?.trim();
	if (!raw) return join(cwd, ".pi-skill-optimizer.profile.json");
	return raw.match(/^[a-zA-Z]:[\\/]|^[/\\]/) ? raw : join(cwd, raw);
}

/** Usage stats file path. Relative env values are resolved from Pi's cwd. */
export function getUsageFilePath(cwd: string): string {
	const raw = process.env.PI_SKILL_OPTIMIZER_USAGE?.trim();
	if (!raw) return join(cwd, ".pi-skill-optimizer.usage.json");
	return raw.match(/^[a-zA-Z]:[\\/]|^[/\\]/) ? raw : join(cwd, raw);
}

export function getPinnedTopK(): number {
	return parseInt0("PI_SKILL_OPTIMIZER_PINNED_TOP_K", DEFAULTS.pinnedTopK);
}
