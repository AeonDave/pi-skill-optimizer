import { isInjectedContextText, normalizeRequest } from "./request.ts";

export interface SkillUsageEntry {
	count: number;
	lastUsed: number;
}

export type SkillUsageStats = Record<string, SkillUsageEntry>;

export interface SkillUsageFile {
	version: 1;
	updatedAt: string;
	skills: SkillUsageStats;
}

export interface SkillUsageEvidence {
	key: string;
	name: string;
}

export const DEFAULT_USAGE_MAX_ENTRIES = 2_048;
export const DEFAULT_USAGE_STALE_DAYS = 180;
export const STALE_LOW_USAGE_MAX_COUNT = 1;

export interface UsagePruneOptions {
	/** Zero disables the hard cap. */
	maxEntries?: number;
	/** Zero disables stale one-off pruning. */
	staleDays?: number;
	/** Critical, explicitly full, or currently pinned skills. */
	protectedNames?: readonly string[];
	now?: number;
}

/**
 * Bound the user-message scan so a long transcript cannot make per-request
 * evidence collection unbounded. Evidence is deduplicated and capped anyway;
 * the window keeps the most recent human turns.
 */
export const MAX_USAGE_SCAN_MESSAGES = 512;

const MENTION_TOKEN_RUN = /[a-z0-9:_-]+/g;
const MENTION_TOKEN_NAME = /^[a-z0-9:_-]+$/;
const SKILL_TOKEN_PREFIX = "skill:";

function isMentionTokenCode(code: number): boolean {
	return (code >= 97 && code <= 122) // a-z
		|| (code >= 48 && code <= 57) // 0-9
		|| code === 58 // :
		|| code === 95 // _
		|| code === 45; // -
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Full matcher for names that contain characters outside the mention-token
 * alphabet (for example `c++` or `a b`). Precompiled once per request.
 */
function mentionPattern(name: string): RegExp {
	return new RegExp(`(^|[^a-z0-9:_-])(?:/skill:|/)?${escapeRegExp(name)}($|[^a-z0-9:_-])`);
}

interface SkillMatcher {
	lower: string;
	name: string;
	/** Present only for names the token scan cannot represent exactly. */
	pattern?: RegExp;
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

function objectId(value: Record<string, unknown>): string | undefined {
	for (const key of ["id", "messageId", "message_id", "toolCallId", "tool_call_id", "toolUseId", "tool_use_id"]) {
		const id = value[key];
		if ((typeof id === "string" || typeof id === "number") && String(id)) return String(id);
	}
	return undefined;
}

/**
 * One precompiled matcher per selected skill. Names made only of mention-token
 * characters are resolved by tokenizing each message once; that is exactly
 * equivalent to the boundary pattern, because any maximal token run is a
 * mention and a `skill:` run preceded by `/` and a boundary is the `/skill:`
 * mention form. Names with other characters keep the full regex.
 */
function collectMatchers(selectedSkills: readonly string[]): SkillMatcher[] {
	const matchers: SkillMatcher[] = [];
	const seen = new Set<string>();
	for (const name of selectedSkills) {
		if (!name) continue;
		const lower = name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		matchers.push(MENTION_TOKEN_NAME.test(lower)
			? { lower, name }
			: { lower, name, pattern: mentionPattern(lower) });
	}
	return matchers;
}

export function collectSkillUsageEvidence(payload: unknown, selectedSkills: readonly string[]): SkillUsageEvidence[] {
	const selected = new Map(selectedSkills.filter(Boolean).map((name) => [name.toLowerCase(), name]));
	if (selected.size === 0) return [];
	const normalizedMessages = normalizeRequest(payload).messages;

	const tokenSkills = new Map<string, string>();
	const patternSkills: SkillMatcher[] = [];
	for (const matcher of collectMatchers(selectedSkills)) {
		if (matcher.pattern) patternSkills.push(matcher);
		else tokenSkills.set(matcher.lower, matcher.name);
	}

	const userMessageIndices: number[] = [];
	for (let messageIndex = normalizedMessages.length - 1; messageIndex >= 0; messageIndex--) {
		if (userMessageIndices.length >= MAX_USAGE_SCAN_MESSAGES) break;
		if (normalizedMessages[messageIndex].role === "user") userMessageIndices.push(messageIndex);
	}
	userMessageIndices.reverse();

	const evidence = new Map<string, SkillUsageEvidence>();
	for (const messageIndex of userMessageIndices) {
		const message = normalizedMessages[messageIndex];
		if (isInjectedContextText(message.text)) continue;
		const text = message.text.toLowerCase();
		if (!text) continue;
		const source = message.sourceId === undefined
			? `index:${messageIndex}:${stableHash(text)}`
			: `id:${message.sourceId}`;
		if (tokenSkills.size > 0) {
			MENTION_TOKEN_RUN.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = MENTION_TOKEN_RUN.exec(text)) !== null) {
				const run = match[0];
				const direct = tokenSkills.get(run);
				if (direct !== undefined) {
					const key = `user:${source}:${run}`;
					evidence.set(key, { key, name: direct });
				}
				if (run.length <= SKILL_TOKEN_PREFIX.length || !run.startsWith(SKILL_TOKEN_PREFIX)) continue;
				const start = match.index;
				if (text.charCodeAt(start - 1) !== 47) continue; // "/"
				if (start >= 2 && isMentionTokenCode(text.charCodeAt(start - 2))) continue;
				const candidate = run.slice(SKILL_TOKEN_PREFIX.length);
				const prefixed = tokenSkills.get(candidate);
				if (prefixed === undefined) continue;
				const key = `user:${source}:${candidate}`;
				evidence.set(key, { key, name: prefixed });
			}
		}
		for (const matcher of patternSkills) {
			if (!matcher.pattern!.test(text)) continue;
			const key = `user:${source}:${matcher.lower}`;
			evidence.set(key, { key, name: matcher.name });
		}
	}

	const rawMessages = Array.isArray(payload)
		? payload
		: payload && typeof payload === "object" && Array.isArray((payload as { messages?: unknown }).messages)
			? (payload as { messages: unknown[] }).messages
			: [];
	for (let messageIndex = 0; messageIndex < rawMessages.length; messageIndex++) {
		const rawMessage = rawMessages[messageIndex];
		if (!rawMessage || typeof rawMessage !== "object") continue;
		const message = rawMessage as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		if (!Array.isArray(message.content)) continue;
		for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
			const rawBlock = message.content[blockIndex];
			if (!rawBlock || typeof rawBlock !== "object") continue;
			const block = rawBlock as Record<string, unknown>;
			if ((block.type !== "tool_use" && block.type !== "toolCall") || typeof block.name !== "string") continue;
			const toolName = block.name.toLowerCase();
			if (toolName !== "skill" && toolName !== "activate_skill") continue;
			const rawInput = block.type === "toolCall" ? block.arguments : block.input;
			if (!rawInput || typeof rawInput !== "object") continue;
			const input = rawInput as Record<string, unknown>;
			let serialized = "";
			try { serialized = JSON.stringify(input); } catch { serialized = String(input); }
			const sourceId = objectId(block);
			const source = sourceId === undefined
				? `index:${messageIndex}:${blockIndex}:${stableHash(serialized)}`
				: `id:${sourceId}`;
			for (const inputKey of ["skill", "skillName", "skill_name", "name"]) {
				const rawName = input[inputKey];
				if (typeof rawName !== "string") continue;
				const lower = rawName.trim().toLowerCase();
				const name = selected.get(lower);
				if (!name) continue;
				const key = `tool:${source}:${lower}`;
				evidence.set(key, { key, name });
			}
		}
	}
	return [...evidence.values()];
}

export function normalizeUsageFile(value: unknown): SkillUsageStats {
	const source = value && typeof value === "object" ? value as { skills?: unknown } : {};
	const rawSkills = source.skills && typeof source.skills === "object" && !Array.isArray(source.skills)
		? source.skills as Record<string, unknown>
		: value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: {};
	const entries: Array<[string, SkillUsageEntry]> = [];
	for (const [name, raw] of Object.entries(rawSkills)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { count?: unknown; lastUsed?: unknown };
		const count = typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count > 0 ? Math.floor(entry.count) : 0;
		const lastUsed = typeof entry.lastUsed === "number" && Number.isFinite(entry.lastUsed) && entry.lastUsed > 0 ? Math.floor(entry.lastUsed) : 0;
		if (count > 0) entries.push([name, { count, lastUsed }]);
	}
	return Object.fromEntries(entries);
}

export function toUsageFile(stats: SkillUsageStats, now = Date.now()): SkillUsageFile {
	return { version: 1, updatedAt: new Date(now).toISOString(), skills: stats };
}

export function recordSkillUsage(stats: SkillUsageStats, names: readonly string[], now = Date.now()): SkillUsageStats {
	const next = new Map(Object.entries(stats));
	for (const name of new Set(names.filter(Boolean))) {
		const prev = next.get(name) ?? { count: 0, lastUsed: 0 };
		next.set(name, { count: prev.count + 1, lastUsed: now });
	}
	return Object.fromEntries(next);
}

/** Merge a process-local increment delta into the latest persisted snapshot. */
export function mergeUsageStats(base: SkillUsageStats, delta: SkillUsageStats): SkillUsageStats {
	const next = new Map(Object.entries(base));
	for (const [name, entry] of Object.entries(delta)) {
		const previous = next.get(name) ?? { count: 0, lastUsed: 0 };
		next.set(name, {
			count: previous.count + entry.count,
			lastUsed: Math.max(previous.lastUsed, entry.lastUsed),
		});
	}
	return Object.fromEntries(next);
}

/**
 * Pick conservative usage signals for future pinning.
 *
 * Do not feed every ranked/selected skill back into usage stats: ranking is a
 * retrieval decision, not proof that the model actually wanted the skill. We
 * record only explicit user mentions or prior skill tool invocations visible in
 * the conversation, filtered to skills that survived the current optimizer pass.
 */
export function selectUsageRecordSkills(payload: unknown, selectedSkills: readonly string[]): string[] {
	return [...new Set(collectSkillUsageEvidence(payload, selectedSkills).map((entry) => entry.name))];
}

export function usageRecordSignature(payload: unknown, names: readonly string[]): string {
	return collectSkillUsageEvidence(payload, names).map((entry) => entry.key).sort().join("\n");
}

export const DEFAULT_USAGE_HALF_LIFE_DAYS = 30;

export interface UsagePriorOptions {
	now?: number;
	halfLifeDays?: number;
	minimumScore?: number;
}

/**
 * Frequency is useful evidence only while it is recent. Exponential decay
 * prevents an old high count from becoming a permanent routing decision.
 */
export function scoreSkillUsage(
	entry: SkillUsageEntry,
	now = Date.now(),
	halfLifeDays = DEFAULT_USAGE_HALF_LIFE_DAYS,
): number {
	if (entry.count <= 0 || entry.lastUsed <= 0) return 0;
	const safeHalfLife = Math.max(1, halfLifeDays);
	const ageDays = Math.max(0, now - entry.lastUsed) / 86_400_000;
	return Math.log1p(entry.count) * 2 ** (-ageDays / safeHalfLife);
}

export function buildUsagePrior(
	stats: SkillUsageStats,
	options: UsagePriorOptions = {},
): Record<string, number> {
	const now = options.now ?? Date.now();
	const halfLifeDays = options.halfLifeDays ?? DEFAULT_USAGE_HALF_LIFE_DAYS;
	const minimumScore = Math.max(0, options.minimumScore ?? 1e-6);
	const entries = Object.entries(stats)
		.map(([name, entry]) => [name, scoreSkillUsage(entry, now, halfLifeDays)] as const)
		.filter(([, score]) => score >= minimumScore)
		.sort(([leftName, leftScore], [rightName, rightScore]) => rightScore - leftScore || leftName.localeCompare(rightName));
	return Object.fromEntries(entries);
}

/**
 * Conservatively bound usage history. Age removes only one-off unprotected
 * entries. The cap then keeps protected entries plus the strongest remaining
 * entries; protected names may intentionally exceed it.
 */
export function pruneUsageStats(stats: SkillUsageStats, options: UsagePruneOptions = {}): SkillUsageStats {
	const maxEntries = Number.isInteger(options.maxEntries) && (options.maxEntries as number) >= 0
		? options.maxEntries as number
		: DEFAULT_USAGE_MAX_ENTRIES;
	const staleDays = typeof options.staleDays === "number" && Number.isFinite(options.staleDays) && options.staleDays >= 0
		? options.staleDays
		: DEFAULT_USAGE_STALE_DAYS;
	const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
	const cutoff = staleDays === 0 ? Number.NEGATIVE_INFINITY : now - staleDays * 86_400_000;
	const protectedNames = new Set((options.protectedNames ?? []).map((name) => name.toLowerCase()));
	const source = Object.entries(stats);
	const ageFiltered = source.filter(([name, entry]) => {
		if (protectedNames.has(name.toLowerCase())) return true;
		return !(entry.count <= STALE_LOW_USAGE_MAX_COUNT && entry.lastUsed > 0 && entry.lastUsed <= cutoff);
	});

	let kept = ageFiltered;
	if (maxEntries > 0 && ageFiltered.length > maxEntries) {
		const protectedEntries = ageFiltered.filter(([name]) => protectedNames.has(name.toLowerCase()));
		const candidates = ageFiltered
			.filter(([name]) => !protectedNames.has(name.toLowerCase()))
			.sort((a, b) => b[1].count - a[1].count || b[1].lastUsed - a[1].lastUsed || a[0].localeCompare(b[0]));
		const keepNames = new Set([
			...protectedEntries,
			...candidates.slice(0, Math.max(0, maxEntries - protectedEntries.length)),
		].map(([name]) => name));
		kept = ageFiltered.filter(([name]) => keepNames.has(name));
	}
	if (kept.length === source.length) return stats;
	return Object.fromEntries(kept);
}
