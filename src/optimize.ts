import {
  AUTO_MARKER,
  planSkillPrefetch,
  inspectStableSkillCatalog,
  renderStableSkillCatalog,
  renderSkillPrefetch,
  parseSkills,
  type Skill,
} from "./skills.js";
import {
  appendToLatestHumanInput,
  extractRequestQuery,
  normalizeRequest,
} from "./request.js";
import { CATALOG_VERSION, renderTagDirectory, type CatalogMetadata, type createSkillCatalogBrowser } from "./catalog.ts";
import { normalize } from "node:path";

export interface OptimizeProfile {
  critical: string[];
  queries: Record<string, string[]>;
  clusters: Record<string, string[]>;
  negativeHints: Record<string, string[]>;
  catalog?: CatalogMetadata;
}

export interface OptimizeConfig {
  catalogBudgetChars: number;
  intentMaxChars: number;
  prefetchTarget: number;
  prefetchMin: number;
  prefetchMax: number;
  prefetchBudgetChars: number;
  fuzzyCandidateLimit: number;
  profile?: OptimizeProfile;
  usagePrior?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  alwaysSkills?: string[];
  excludeSkills?: string[];
  /** Host capability, not a permission grant. Missing resolver keeps native discovery. */
  resolverAvailable?: boolean;
  /** Authoritative host descriptions, before XML formatting/trimming. */
  skillSources?: readonly { name: string; description: string; location?: string }[];
  /** Private immutable host snapshot prepared outside provider hot hooks. */
  catalogSnapshot?: ReturnType<typeof createSkillCatalogBrowser>;
  /**
   * Decayed usage names captured once per session by the host. Receipt metadata only:
   * catalog mode appends them after the directory and drops them before it.
   */
  recentSkills?: readonly string[];
}

export interface OptimizeBudget extends SkillCatalogBudget {
  catalogs: number;
}

/**
 * Why the native `<available_skills>` catalog survived a request. Every value
 * comes from an existing guard in `optimizePayload`; none of them relaxes it.
 */
export type CatalogFallbackReason =
  | "no-catalog-profile"
  | "no-native-catalog"
  | "resolver-unavailable"
  | "extension-catalog-unregistered"
  | "registry-mismatch"
  | "directory-overflow"
  | "render-failed"
  | "quarantined-source"
  | "not-smaller";

/** Non-default substitutions: the small-catalog all-name index replaces the tag directory. */
export type CatalogReplacementReason = "small-catalog-index";

/** What this pass actually did to the request's skill catalog. */
export interface CatalogOutcome {
  mode: "replaced" | "native";
  reason?: CatalogFallbackReason | CatalogReplacementReason;
}

export const RECENT_SKILL_HINT_LIMIT = 8;

/**
 * Frozen usage receipt for catalog mode: names already loaded here, never a ranking
 * signal. Filtered to the eligible catalog so it can never advertise an unloadable name.
 */
function recentSkillHint(
  names: readonly string[] | undefined,
  eligible: ReadonlySet<string>,
): string {
  const picked = uniqueInOrder((names ?? [])
    .filter((name) => typeof name === "string" && eligible.has(name)))
    .slice(0, RECENT_SKILL_HINT_LIMIT);
  if (picked.length === 0) return "";
  return `\nRecently loaded here (usage metadata, not a recommendation): ${JSON.stringify(picked).replace(/</g, "\\u003c")}`;
}

export interface OptimizeResult<T> {
  next: T;
  removedChars: number;
  baseRemovedChars: number;
  addedPrefetchChars: number;
  selected: string[];
  catalogNames: string[];
  fingerprints: string[];
  budget: OptimizeBudget;
  catalogOutcome: CatalogOutcome;
}

type SkillCatalogBudget = ReturnType<typeof renderStableSkillCatalog>["budget"];

const PREFETCH_MARKER = "<!--skill-optimizer:prefetch:v2-->";

interface TextBlock {
  type?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

interface ToolLike {
  description?: unknown;
  function?: unknown;
  [key: string]: unknown;
}

interface PayloadLike {
  system?: unknown;
  systemInstruction?: unknown;
  instructions?: unknown;
  messages?: unknown;
  input?: unknown;
  context?: unknown;
  tools?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function emptyBudget(config: OptimizeConfig): OptimizeBudget {
  return {
    requestedChars: config.catalogBudgetChars,
    usedChars: 0,
    floorChars: 0,
    intentCount: 0,
    nameOnlyCount: 0,
    overBudgetChars: 0,
    catalogs: 0,
  };
}

function mergeBudget(
  target: OptimizeBudget,
  source: SkillCatalogBudget,
): void {
  target.usedChars += source.usedChars;
  target.floorChars += source.floorChars;
  target.intentCount += source.intentCount;
  target.nameOnlyCount += source.nameOnlyCount;
  target.overBudgetChars += source.overBudgetChars;
  target.catalogs += 1;
}

function replaceTextBlocks(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (typeof value === "string") return transform(value);
  if (!Array.isArray(value)) return value;

  let changed = false;
  const next = value.map((entry) => {
    if (!isRecord(entry) || typeof (entry as TextBlock).text !== "string") {
      return entry;
    }
    const text = transform((entry as TextBlock).text as string);
    if (text === (entry as TextBlock).text) return entry;
    changed = true;
    return { ...entry, text };
  });
  return changed ? next : value;
}

function replaceMessageContent(
  messages: unknown,
  transform: (text: string) => string,
): unknown {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((entry) => {
    if (!isRecord(entry)) return entry;
    const message = entry as MessageLike;
    if (message.role !== "system" && message.role !== "developer") return entry;
    let nextMessage: MessageLike = message;
    const content = replaceTextBlocks(message.content, transform);
    if (content !== message.content) nextMessage = { ...nextMessage, content };
    if (message.role === "system" && isRecord(message.sections)) {
      let sectionsChanged = false;
      const sections = Object.fromEntries(Object.entries(message.sections).map(([name, value]) => {
        if (typeof value !== "string") return [name, value];
        const text = transform(value);
        if (text !== value) sectionsChanged = true;
        return [name, text];
      }));
      if (sectionsChanged) nextMessage = { ...nextMessage, sections };
    }
    if (message.role === "system" && Array.isArray(message.toolsAdded)) {
      const toolsAdded = replaceToolDescriptions(message.toolsAdded, transform);
      if (toolsAdded !== message.toolsAdded) nextMessage = { ...nextMessage, toolsAdded };
    }
    if (nextMessage === message) return entry;
    changed = true;
    return nextMessage;
  });
  return changed ? next : messages;
}

function replaceTranscriptContext(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (!isRecord(value)) return value;
  const messages = replaceMessageContent(value.messages, transform);
  return messages === value.messages ? value : { ...value, messages };
}

function replaceToolDescriptions(
  tools: unknown,
  transform: (text: string) => string,
): unknown {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const next = tools.map((entry) => {
    if (!isRecord(entry)) return entry;
    const tool = entry as ToolLike;
    let nextTool: ToolLike = tool;
    if (typeof tool.description === "string") {
      const description = transform(tool.description);
      if (description !== tool.description) {
        nextTool = { ...nextTool, description };
      }
    }
    if (isRecord(tool.function) && typeof tool.function.description === "string") {
      const description = transform(tool.function.description);
      if (description !== tool.function.description) {
        nextTool = {
          ...nextTool,
          function: { ...tool.function, description },
        };
      }
    }
    if (nextTool === tool) return entry;
    changed = true;
    return nextTool;
  });
  return changed ? next : tools;
}

function replaceSystemInstruction(
  value: unknown,
  transform: (text: string) => string,
): unknown {
  if (typeof value === "string" || Array.isArray(value)) {
    return replaceTextBlocks(value, transform);
  }
  if (!isRecord(value)) return value;
  const parts = replaceTextBlocks(value.parts, transform);
  if (parts === value.parts) return value;
  return { ...value, parts };
}

function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sameSourceLocation(left: string, right: string): boolean {
  const canonicalText = (value: string): string => {
    const path = normalize(value).replaceAll("\\", "/");
    return process.platform === "win32" ? path.toLowerCase() : path;
  };
  return canonicalText(left) === canonicalText(right);
}

export function optimizePayload<T>(
  payload: T,
  config: OptimizeConfig,
): OptimizeResult<T> {
  if (!isRecord(payload)) {
    return {
      next: payload,
      removedChars: 0,
      baseRemovedChars: 0,
      addedPrefetchChars: 0,
      selected: [],
      catalogNames: [],
      fingerprints: [],
      budget: emptyBudget(config),
      catalogOutcome: { mode: "native", reason: "no-native-catalog" },
    };
  }
  if (config.resolverAvailable === false) {
    return {
      next: payload,
      removedChars: 0,
      baseRemovedChars: 0,
      addedPrefetchChars: 0,
      selected: [],
      catalogNames: [],
      fingerprints: [],
      budget: emptyBudget(config),
      catalogOutcome: { mode: "native", reason: "resolver-unavailable" },
    };
  }

  const originalLength = serializedLength(payload);
  const query = extractRequestQuery(normalizeRequest(payload));
  const source = payload as PayloadLike;
  const tagMetadata = config.profile?.catalog?.version === CATALOG_VERSION ? config.profile.catalog : undefined;
  const originalSkills = config.skillSources ? new Map(config.skillSources.map((skill) => [skill.name, skill])) : undefined;
  const catalogSkills: Skill[] = [];
  const catalogSkillNames = new Set<string>();
  const catalogNames: string[] = [];
  const fingerprints: string[] = [];
  const budget = emptyBudget(config);
  let baseRemovedChars = 0;
  const catalogFloors: number[] = [];
  // Honest status contract: report the guard that actually kept the native catalog.
  let catalogOutcome: CatalogOutcome = tagMetadata
    ? { mode: "native", reason: "no-native-catalog" }
    : { mode: "native", reason: "no-catalog-profile" };
  const noteReplaced = (reason?: CatalogReplacementReason): void => {
    catalogOutcome = reason ? { mode: "replaced", reason } : { mode: "replaced" };
  };
  const noteFallback = (reason: CatalogFallbackReason): void => {
    // A substitution that did happen stays reported; one guarded block does not
    // rewrite the whole request's outcome.
    if (catalogOutcome.mode === "replaced") return;
    catalogOutcome = { mode: "native", reason };
  };
  const inspect = (text: string): string => {
    if (tagMetadata) return text;
    const preview = inspectStableSkillCatalog(text, {
      never: config.excludeSkills,
      intentMaxChars: config.intentMaxChars,
    });
    if (preview.skills.length > 0) catalogFloors.push(preview.floorChars);
    return text;
  };
  replaceTextBlocks(source.system, inspect);
  replaceSystemInstruction(source.systemInstruction, inspect);
  if (typeof source.instructions === "string") inspect(source.instructions);
  replaceMessageContent(source.messages, inspect);
  replaceMessageContent(source.input, inspect);
  replaceTranscriptContext(source.context, inspect);
  replaceToolDescriptions(source.tools, inspect);

  let catalogIndex = 0;
  let remainingIntentBudget = Math.max(
    0,
    config.catalogBudgetChars -
      catalogFloors.reduce((sum, floor) => sum + floor, 0),
  );

  const transform = (text: string): string => {
    if (tagMetadata) {
      const excluded = new Set(config.excludeSkills ?? []);
      return text.replace(/<available_skills\b[^>]*>([\s\S]*?)<\/available_skills>/gi, (block: string, inner: string) => {
        // This pass already replaced the block (tag directory or stable index): a second
        // pass is an identity operation, never a registry-mismatch report against our own output.
        if (inner.includes(AUTO_MARKER)) return block;
        const parsed = parseSkills(inner).filter((skill) => !excluded.has(skill.name));
        // Do not replace an extension-supplied catalog with a resolver that cannot load its entries.
        if (originalSkills && parsed.some((skill) => !originalSkills.has(skill.name))) {
          noteFallback("extension-catalog-unregistered");
          return block;
        }
        if (originalSkills && parsed.some((skill) => {
          const registered = originalSkills.get(skill.name)!;
          return registered.description.trim() !== skill.description
            || (!!registered.location && (!skill.location || !sameSourceLocation(registered.location, skill.location)));
        })) {
          noteFallback("registry-mismatch");
          return block;
        }
        const skills = parsed
          .map((skill) => originalSkills?.get(skill.name) ?? skill);
        if (skills.length === 0) return block;
        const limit = Math.min(4_000, config.catalogBudgetChars);
        const eligibleNames = new Set(skills.map((skill) => skill.name));
        const priority = uniqueInOrder([...(config.profile?.critical ?? []), ...(config.alwaysSkills ?? [])])
          .filter((name) => eligibleNames.has(name));
        const priorityText = priority.length > 0
          ? `\nConfigured/universal skill names (metadata, not loaded): ${JSON.stringify(priority).replace(/</g, "\\u003c")}\nLoad relevant full instructions by exact name; no catalog acknowledgment is needed.`
          : "";
        // Session-frozen usage hints are receipt metadata, not discovery: they are the
        // first thing dropped when the complete directory does not fit beside them.
        let hintText = recentSkillHint(config.recentSkills, eligibleNames);
        const renderWithin = (): ReturnType<typeof renderTagDirectory> => {
          const directoryBudget = limit - priorityText.length - hintText.length;
          const snapshot = config.catalogSnapshot;
          const sameCatalog = snapshot?.prepared.total === skills.length
            && snapshot.prepared.skills.every((skill) => eligibleNames.has(skill.name));
          return sameCatalog ? snapshot!.renderDirectory(directoryBudget)
            : renderTagDirectory(skills, tagMetadata, directoryBudget);
        };
        let directory: ReturnType<typeof renderTagDirectory> | undefined;
        let failure: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            directory = renderWithin();
            break;
          }
          catch (error) {
            failure = error;
            if (attempt === 0 && error instanceof RangeError && hintText.length > 0) {
              hintText = "";
              continue;
            }
            break;
          }
        }
        if (!directory) {
          // Preserve native discovery when the complete directory cannot fit or a
          // catalog invariant rejects it. Defense in depth: a malformed-catalog
          // TypeError is a rendering failure here, never a reason to break the request.
          if (failure instanceof RangeError) {
            noteFallback("directory-overflow");
            return block;
          }
          if (failure instanceof TypeError) {
            noteFallback("render-failed");
            return block;
          }
          throw failure;
        }
        // Quarantined sources are not represented in the directory, so replacing the
        // native block would silently hide them. Keep native discovery in that case.
        if (directory.quarantined > 0) {
          noteFallback("quarantined-source");
          return block;
        }
        // Everything the substitution says before any receipt overlay.
        let text = directory.text + priorityText;
        let replacedReason: CatalogReplacementReason | undefined;
        let intentCount = 0;
        // Small catalogs: when the complete all-name index fits inside the directory's
        // own length, naming every eligible skill beats a tag-only directory at no extra
        // cost. The guard reads the directory, never the overlays, so usage evidence
        // cannot change which substitution a session uses.
        const stableFloor = inspectStableSkillCatalog(block, {
          never: config.excludeSkills,
          intentMaxChars: config.intentMaxChars,
        }).floorChars;
        if (stableFloor > 0 && stableFloor <= text.length) {
          const index = renderStableSkillCatalog(block, {
            never: config.excludeSkills,
            intentMaxChars: config.intentMaxChars,
            budgetChars: text.length - priorityText.length,
          });
          const indexed = index.text + priorityText;
          if (index.skills.length > 0 && indexed.length <= text.length) {
            text = indexed;
            replacedReason = "small-catalog-index";
            intentCount = index.budget.intentCount;
          }
        }
        text += hintText;
        if (text.length >= block.length) {
          noteFallback("not-smaller");
          return block;
        }
        noteReplaced(replacedReason);
        baseRemovedChars += block.length - text.length;
        catalogNames.push(...skills.map((skill) => skill.name));
        fingerprints.push(directory.fingerprint);
        mergeBudget(budget, {
          requestedChars: config.catalogBudgetChars,
          usedChars: text.length,
          floorChars: text.length,
          intentCount,
          nameOnlyCount: 0,
          overBudgetChars: 0,
        });
        return text;
      });
    }
    const floorChars = catalogFloors[catalogIndex] ?? 0;
    const result = renderStableSkillCatalog(text, {
      never: config.excludeSkills,
      intentMaxChars: config.intentMaxChars,
      budgetChars: floorChars + remainingIntentBudget,
    });
    if (result.skills.length === 0) return text;
    if (result.text !== text) noteReplaced();

    catalogIndex += 1;
    remainingIntentBudget = Math.max(
      0,
      remainingIntentBudget - Math.max(0, result.budget.usedChars - floorChars),
    );
    baseRemovedChars += result.removedChars;
    catalogNames.push(...result.skills.map((skill) => skill.name));
    fingerprints.push(result.fingerprint);
    mergeBudget(budget, result.budget);

    for (const skill of result.skills) {
      if (catalogSkillNames.has(skill.name)) continue;
      catalogSkillNames.add(skill.name);
      catalogSkills.push(skill);
    }
    return result.text;
  };

  let next: PayloadLike = source;

  const system = replaceTextBlocks(source.system, transform);
  if (system !== source.system) next = { ...next, system };

  const systemInstruction = replaceSystemInstruction(
    source.systemInstruction,
    transform,
  );
  if (systemInstruction !== source.systemInstruction) {
    next = { ...next, systemInstruction };
  }

  if (typeof source.instructions === "string") {
    const instructions = transform(source.instructions);
    if (instructions !== source.instructions) next = { ...next, instructions };
  }

  const messages = replaceMessageContent(source.messages, transform);
  if (messages !== source.messages) next = { ...next, messages };

  const input = replaceMessageContent(source.input, transform);
  if (input !== source.input) next = { ...next, input };

  const context = replaceTranscriptContext(source.context, transform);
  if (context !== source.context) next = { ...next, context };

  const tools = replaceToolDescriptions(source.tools, transform);
  if (tools !== source.tools) next = { ...next, tools };

  budget.overBudgetChars = Math.max(
    budget.overBudgetChars,
    Math.max(0, budget.usedChars - config.catalogBudgetChars),
  );

  if (next === source || budget.catalogs === 0) {
    return {
      next: payload,
      removedChars: 0,
      baseRemovedChars: 0,
      addedPrefetchChars: 0,
      selected: [],
      catalogNames: uniqueInOrder(catalogNames),
      fingerprints: uniqueInOrder(fingerprints),
      budget,
      catalogOutcome,
    };
  }

  let addedPrefetchChars = 0;
  let injectedSkills: string[] = [];
  const prefetchPlan = tagMetadata ? undefined : planSkillPrefetch(catalogSkills, query, {
    profile: config.profile,
    usagePrior: config.usagePrior,
    always: uniqueInOrder([
      ...(config.profile?.critical ?? []),
      ...(config.alwaysSkills ?? []),
    ]),
    never: config.excludeSkills,
    targetTopK: config.prefetchTarget,
    minTopK: config.prefetchMin,
    maxTopK: config.prefetchMax,
    fullRenderBudgetChars: config.prefetchBudgetChars,
    fuzzyCandidateLimit: config.fuzzyCandidateLimit,
  });
  const selectedSkills = prefetchPlan?.selected ?? [];
  if (prefetchPlan && selectedSkills.length > 0) {
    const appendix = renderSkillPrefetch(prefetchPlan);
    if (appendix) {
      const withPrefetch = appendToLatestHumanInput(
        next,
        appendix,
        PREFETCH_MARKER,
      ) as PayloadLike;
      if (withPrefetch !== next) {
        addedPrefetchChars = serializedLength(withPrefetch) - serializedLength(next);
        next = withPrefetch;
        injectedSkills = selectedSkills.map((skill) => skill.name);
      }
    }
  }

  const finalLength = serializedLength(next);
  if (
    !Number.isFinite(originalLength) ||
    !Number.isFinite(finalLength) ||
    finalLength >= originalLength
  ) {
    return {
      next: payload,
      removedChars: 0,
      baseRemovedChars: 0,
      addedPrefetchChars: 0,
      selected: [],
      catalogNames: uniqueInOrder(catalogNames),
      fingerprints: uniqueInOrder(fingerprints),
      budget,
      // The whole payload was rejected as never-worse, so the request keeps the
      // native catalog even if one section was replaced during the pass.
      catalogOutcome: catalogOutcome.mode === "replaced"
        ? { mode: "native", reason: "not-smaller" }
        : catalogOutcome,
    };
  }

  return {
    next: next as T,
    removedChars: originalLength - finalLength,
    baseRemovedChars,
    addedPrefetchChars: Math.max(0, addedPrefetchChars),
    selected: injectedSkills,
    catalogNames: uniqueInOrder(catalogNames),
    fingerprints: uniqueInOrder(fingerprints),
    budget,
    catalogOutcome,
  };
}
