import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { OptimizeConfig } from "./optimize.js";

export type OutputMode = "off" | "smart" | "extract";

export interface OutputConfig {
  mode: OutputMode;
  maxLines: number;
  maxBytes: number;
  minSavingsBytes: number;
  minSavingsRatio: number;
  tools: string[];
  model: string;
  extractMinBytes: number;
  extractExclude: string[];
  archiveTtlMs: number;
}

export interface UsageConfig {
  maxEntries: number;
  staleDays: number;
  halfLifeDays: number;
}

export interface RuntimeConfig extends OptimizeConfig {
  alwaysSkills: string[];
  excludeSkills: string[];
  providers: string[];
  toolPrefetchMax: number;
  toolSearchPageSize: number;
  alwaysTools: string[];
  historyDedupMinBytes: number;
  usageHalfLifeDays: number;
  usageMaxEntries: number;
  usageStaleDays: number;
  outputMode: OutputMode;
  outputMaxLines: number;
  outputMaxBytes: number;
  outputMinSavingsBytes: number;
  outputMinSavingsRatio: number;
  outputTools: string[];
  outputModel: string;
  outputExtractMinBytes: number;
  outputExtractExclude: string[];
  outputArchiveTtlHours: number;
}

export const DEFAULT_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  catalogBudgetChars: 8_000,
  intentMaxChars: 96,
  prefetchTarget: 5,
  prefetchMin: 3,
  prefetchMax: 8,
  prefetchBudgetChars: 6_000,
  fuzzyCandidateLimit: 8,
  alwaysSkills: [],
  excludeSkills: [],
  providers: [],
  toolPrefetchMax: 5,
  toolSearchPageSize: 8,
  alwaysTools: [],
  historyDedupMinBytes: 4_096,
  usageHalfLifeDays: 30,
  usageMaxEntries: 2_048,
  usageStaleDays: 180,
  outputMode: "smart",
  outputMaxLines: 400,
  outputMaxBytes: 16_000,
  outputMinSavingsBytes: 512,
  outputMinSavingsRatio: 0.1,
  outputTools: ["*"],
  outputModel: "",
  outputExtractMinBytes: 32_000,
  outputExtractExclude: [
    "cat",
    "ls",
    "head",
    "tail",
    "tree",
    "find",
    "dir",
    "type",
  ],
  outputArchiveTtlHours: 168,
});

type JsonObject = Record<string, unknown>;

const INTEGER_FIELDS = {
  catalogBudgetChars: [256, 1_000_000],
  intentMaxChars: [24, 1_024],
  prefetchTarget: [0, 1_000],
  prefetchMin: [0, 1_000],
  prefetchMax: [0, 1_000],
  prefetchBudgetChars: [0, 1_000_000],
  fuzzyCandidateLimit: [0, 1_000],
  toolPrefetchMax: [0, 1_000],
  toolSearchPageSize: [1, 100],
  historyDedupMinBytes: [0, 100_000_000],
  usageHalfLifeDays: [1, 3_650],
  usageMaxEntries: [0, 1_000_000],
  usageStaleDays: [1, 3_650],
  outputMaxLines: [1, 1_000_000],
  outputMaxBytes: [256, 100_000_000],
  outputMinSavingsBytes: [0, 100_000_000],
  outputExtractMinBytes: [0, 100_000_000],
  outputArchiveTtlHours: [1, 8_760],
} as const satisfies Partial<Record<keyof RuntimeConfig, readonly [number, number]>>;

const ENV_FIELDS: Readonly<Record<string, keyof RuntimeConfig>> = {
  PI_SKILL_OPTIMIZER_CATALOG_BUDGET_CHARS: "catalogBudgetChars",
  PI_SKILL_OPTIMIZER_INTENT_MAX_CHARS: "intentMaxChars",
  PI_SKILL_OPTIMIZER_PREFETCH_TARGET: "prefetchTarget",
  PI_SKILL_OPTIMIZER_PREFETCH_MIN: "prefetchMin",
  PI_SKILL_OPTIMIZER_PREFETCH_MAX: "prefetchMax",
  PI_SKILL_OPTIMIZER_PREFETCH_BUDGET_CHARS: "prefetchBudgetChars",
  PI_SKILL_OPTIMIZER_FUZZY_CANDIDATE_LIMIT: "fuzzyCandidateLimit",
  PI_SKILL_OPTIMIZER_TOOL_PREFETCH_MAX: "toolPrefetchMax",
  PI_SKILL_OPTIMIZER_TOOL_SEARCH_PAGE_SIZE: "toolSearchPageSize",
  PI_SKILL_OPTIMIZER_HISTORY_DEDUP_MIN_BYTES: "historyDedupMinBytes",
  PI_SKILL_OPTIMIZER_USAGE_HALF_LIFE_DAYS: "usageHalfLifeDays",
  PI_SKILL_OPTIMIZER_USAGE_MAX_ENTRIES: "usageMaxEntries",
  PI_SKILL_OPTIMIZER_USAGE_STALE_DAYS: "usageStaleDays",
  PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES: "outputMaxLines",
  PI_SKILL_OPTIMIZER_OUTPUT_MAX_BYTES: "outputMaxBytes",
  PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_BYTES: "outputMinSavingsBytes",
  PI_SKILL_OPTIMIZER_OUTPUT_EXTRACT_MIN_BYTES: "outputExtractMinBytes",
  PI_SKILL_OPTIMIZER_OUTPUT_ARCHIVE_TTL_HOURS: "outputArchiveTtlHours",
};

const ENV_LIST_FIELDS: Readonly<Record<string, keyof RuntimeConfig>> = {
  PI_SKILL_OPTIMIZER_ALWAYS_SKILLS: "alwaysSkills",
  PI_SKILL_OPTIMIZER_EXCLUDE_SKILLS: "excludeSkills",
  PI_SKILL_OPTIMIZER_PROVIDERS: "providers",
  PI_SKILL_OPTIMIZER_ALWAYS_TOOLS: "alwaysTools",
  PI_SKILL_OPTIMIZER_OUTPUT_TOOLS: "outputTools",
  PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE: "outputExtractExclude",
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.trunc(parsed)))
    : fallback;
}

function parseRatio(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function parseList(value: unknown, fallback: readonly string[]): string[] {
  const source =
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : fallback;
  return [
    ...new Set(
      source
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseOutputMode(value: unknown, fallback: OutputMode): OutputMode {
  return value === "off" || value === "smart" || value === "extract"
    ? value
    : fallback;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return undefined;
}

function readJsonObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeConfig(raw: JsonObject): RuntimeConfig {
  const next: RuntimeConfig = {
    ...DEFAULT_CONFIG,
    alwaysSkills: [...DEFAULT_CONFIG.alwaysSkills],
    excludeSkills: [...DEFAULT_CONFIG.excludeSkills],
    providers: [...DEFAULT_CONFIG.providers],
    alwaysTools: [...DEFAULT_CONFIG.alwaysTools],
    outputTools: [...DEFAULT_CONFIG.outputTools],
    outputExtractExclude: [...DEFAULT_CONFIG.outputExtractExclude],
  };

  for (const [field, bounds] of Object.entries(INTEGER_FIELDS) as Array<
    [keyof typeof INTEGER_FIELDS, readonly [number, number]]
  >) {
    const [min, max] = bounds;
    (next as unknown as Record<string, unknown>)[field] = parseInteger(
      raw[field],
      next[field] as number,
      min,
      max,
    );
  }

  next.alwaysSkills = parseList(raw.alwaysSkills, next.alwaysSkills);
  next.excludeSkills = parseList(raw.excludeSkills, next.excludeSkills);
  next.providers = parseList(raw.providers, next.providers).map((item) =>
    item.toLowerCase(),
  );
  next.alwaysTools = parseList(raw.alwaysTools, next.alwaysTools);
  next.outputTools = parseList(raw.outputTools, next.outputTools);
  next.outputExtractExclude = parseList(
    raw.outputExtractExclude,
    next.outputExtractExclude,
  );
  next.outputMode = parseOutputMode(raw.outputMode, next.outputMode);
  next.outputModel =
    typeof raw.outputModel === "string" ? raw.outputModel.trim() : next.outputModel;
  next.outputMinSavingsRatio = parseRatio(
    raw.outputMinSavingsRatio,
    next.outputMinSavingsRatio,
  );

  next.prefetchMax = Math.max(next.prefetchMin, next.prefetchMax);
  next.prefetchTarget = Math.min(
    next.prefetchMax,
    Math.max(next.prefetchMin, next.prefetchTarget),
  );
  return next;
}

function applyEnvironment(
  base: RuntimeConfig,
  environment: NodeJS.ProcessEnv,
): RuntimeConfig {
  const raw: JsonObject = { ...base };
  for (const [environmentName, field] of Object.entries(ENV_FIELDS)) {
    const value = environment[environmentName];
    if (value !== undefined) raw[field] = value;
  }
  for (const [environmentName, field] of Object.entries(ENV_LIST_FIELDS)) {
    const value = environment[environmentName];
    if (value !== undefined) raw[field] = value;
  }
  if (environment.PI_SKILL_OPTIMIZER_OUTPUT_MODE !== undefined) {
    raw.outputMode = environment.PI_SKILL_OPTIMIZER_OUTPUT_MODE;
  }
  if (environment.PI_SKILL_OPTIMIZER_OUTPUT_MODEL !== undefined) {
    raw.outputModel = environment.PI_SKILL_OPTIMIZER_OUTPUT_MODEL;
  }
  if (environment.PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO !== undefined) {
    raw.outputMinSavingsRatio =
      environment.PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO;
  }
  return normalizeConfig(raw);
}

export function getAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(environment.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

export function getStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  return join(getAgentDir(environment), "skill-optimizer");
}

export function getConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(environment), "config.json");
}

export function getGlobalProfilePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(getStateDir(environment), "profile.json");
}

export function getGlobalUsagePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return join(getStateDir(environment), "usage.json");
}

export function getStatsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(environment), "stats.json");
}

export function getArchiveDir(environment: NodeJS.ProcessEnv = process.env): string {
  return join(getStateDir(environment), "output");
}

export function getProjectProfilePath(cwd: string = process.cwd()): string {
  return join(resolve(cwd), ".pi", "skill-optimizer", "profile.json");
}

export function getConfigPaths(cwd: string = process.cwd()): {
  global: string;
  project: string;
} {
  return {
    global: getConfigPath(),
    project: join(resolve(cwd), ".pi", "skill-optimizer", "config.json"),
  };
}

export function getProfilePaths(cwd: string = process.cwd()): {
  global: string;
  project: string;
} {
  return {
    global: getGlobalProfilePath(),
    project: getProjectProfilePath(cwd),
  };
}

export function getUsageFilePath(_cwd: string = process.cwd()): string {
  return getGlobalUsagePath();
}

export function getStatsFilePath(_cwd: string = process.cwd()): string {
  return getStatsPath();
}

export function ensureGlobalConfigTemplate(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = getConfigPath(environment);
  if (existsSync(path)) return undefined;
  mkdirSync(getStateDir(environment), { recursive: true });
  try {
    writeFileSync(path, defaultConfigJson(), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return undefined;
    throw error;
  }
  return path;
}

export function getConfig(
  cwd: string,
): RuntimeConfig;
export function getConfig(
  environment?: NodeJS.ProcessEnv,
  configPath?: string,
): RuntimeConfig;
export function getConfig(
  environmentOrCwd: NodeJS.ProcessEnv | string = process.env,
  configPath?: string,
): RuntimeConfig {
  if (typeof environmentOrCwd === "string") {
    const paths = getConfigPaths(environmentOrCwd);
    const raw = {
      ...readJsonObject(paths.global),
      ...readJsonObject(paths.project),
    };
    return applyEnvironment(normalizeConfig(raw), process.env);
  }
  const environment = environmentOrCwd;
  return applyEnvironment(
    normalizeConfig(readJsonObject(configPath ?? getConfigPath(environment))),
    environment,
  );
}

export function getOutputConfig(configOrCwd: RuntimeConfig | string): OutputConfig {
  const config =
    typeof configOrCwd === "string" ? getConfig(configOrCwd) : configOrCwd;
  return {
    mode: config.outputMode,
    maxLines: config.outputMaxLines,
    maxBytes: config.outputMaxBytes,
    minSavingsBytes: config.outputMinSavingsBytes,
    minSavingsRatio: config.outputMinSavingsRatio,
    tools: [...config.outputTools],
    model: config.outputModel,
    extractMinBytes: config.outputExtractMinBytes,
    extractExclude: [...config.outputExtractExclude],
    archiveTtlMs: config.outputArchiveTtlHours * 60 * 60 * 1_000,
  };
}

export function getUsageConfig(configOrCwd: RuntimeConfig | string): UsageConfig {
  const config =
    typeof configOrCwd === "string" ? getConfig(configOrCwd) : configOrCwd;
  return {
    maxEntries: config.usageMaxEntries,
    staleDays: config.usageStaleDays,
    halfLifeDays: config.usageHalfLifeDays,
  };
}

export function isOptimizerDisabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBoolean(environment.PI_SKILL_OPTIMIZER_DISABLE) === true;
}

export function isDisabled(_cwd: string = process.cwd()): boolean {
  return isOptimizerDisabled();
}

export function getScopeProviders(cwd: string = process.cwd()): string[] | undefined {
  const providers = getConfig(cwd).providers;
  return providers.length > 0 ? providers : undefined;
}

export function isProviderEnabled(
  config: Pick<RuntimeConfig, "providers">,
  provider: string | undefined,
): boolean {
  if (config.providers.length === 0) return true;
  if (!provider) return false;
  return config.providers.includes(provider.toLowerCase());
}

export function defaultConfigJson(): string {
  return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}
