import {
  planSkillPrefetch,
  renderStableSkillCatalog,
  renderSkillPrefetch,
  type Skill,
} from "./skills.js";
import {
  appendToLatestHumanInput,
  extractRequestQuery,
  normalizeRequest,
} from "./request.js";

export interface OptimizeProfile {
  critical: string[];
  queries: Record<string, string[]>;
  clusters: Record<string, string[]>;
  negativeHints: Record<string, string[]>;
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
}

export interface OptimizeBudget extends SkillCatalogBudget {
  catalogs: number;
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
    const content = replaceTextBlocks(message.content, transform);
    if (content === message.content) return entry;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
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
    };
  }

  const originalLength = serializedLength(payload);
  const query = extractRequestQuery(normalizeRequest(payload));
  const source = payload as PayloadLike;
  const catalogSkills: Skill[] = [];
  const catalogSkillNames = new Set<string>();
  const catalogNames: string[] = [];
  const fingerprints: string[] = [];
  const budget = emptyBudget(config);
  let baseRemovedChars = 0;
  const catalogFloors: number[] = [];
  const inspect = (text: string): string => {
    const preview = renderStableSkillCatalog(text, {
      never: config.excludeSkills,
      intentMaxChars: config.intentMaxChars,
      budgetChars: 0,
    });
    if (preview.skills.length > 0) catalogFloors.push(preview.budget.floorChars);
    return text;
  };
  replaceTextBlocks(source.system, inspect);
  replaceSystemInstruction(source.systemInstruction, inspect);
  if (typeof source.instructions === "string") inspect(source.instructions);
  replaceMessageContent(source.messages, inspect);
  replaceToolDescriptions(source.tools, inspect);

  let catalogIndex = 0;
  let remainingIntentBudget = Math.max(
    0,
    config.catalogBudgetChars -
      catalogFloors.reduce((sum, floor) => sum + floor, 0),
  );

  const transform = (text: string): string => {
    const floorChars = catalogFloors[catalogIndex] ?? 0;
    const result = renderStableSkillCatalog(text, {
      never: config.excludeSkills,
      intentMaxChars: config.intentMaxChars,
      budgetChars: floorChars + remainingIntentBudget,
    });
    if (result.skills.length === 0) return text;

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
    };
  }

  let addedPrefetchChars = 0;
  const selectedSkills =
    planSkillPrefetch(catalogSkills, query, {
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
    }).selected;
  if (selectedSkills.length > 0) {
    const appendix = renderSkillPrefetch({
      selected: selectedSkills,
    } as Parameters<typeof renderSkillPrefetch>[0]);
    if (appendix) {
      const withPrefetch = appendToLatestHumanInput(
        next,
        appendix,
        PREFETCH_MARKER,
      ) as PayloadLike;
      if (withPrefetch !== next) {
        addedPrefetchChars = serializedLength(withPrefetch) - serializedLength(next);
        next = withPrefetch;
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
    };
  }

  return {
    next: next as T,
    removedChars: originalLength - finalLength,
    baseRemovedChars,
    addedPrefetchChars: Math.max(0, addedPrefetchChars),
    selected: selectedSkills.map((skill) => skill.name),
    catalogNames: uniqueInOrder(catalogNames),
    fingerprints: uniqueInOrder(fingerprints),
    budget,
  };
}
