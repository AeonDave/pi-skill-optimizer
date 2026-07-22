import { normalizeRequest } from "./request.ts";

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

function isInjectedContextText(text: string): boolean {
	return text.trimStart().startsWith("context-mode active.");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMentioned(text: string, name: string): boolean {
	const escaped = escapeRegExp(name.toLowerCase());
	return new RegExp(`(^|[^a-z0-9:_-])(?:/skill:|/)?${escaped}($|[^a-z0-9:_-])`).test(text);
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

/** Stable per-message/tool-call evidence, suitable for bounded session deduplication. */
export function collectSkillUsageEvidence(payload: unknown, selectedSkills: readonly string[]): SkillUsageEvidence[] {
	const normalizedMessages = normalizeRequest(payload).messages;
	const selected = new Map(selectedSkills.filter(Boolean).map((name) => [name.toLowerCase(), name]));
	const evidence = new Map<string, SkillUsageEvidence>();
	for (let messageIndex = 0; messageIndex < normalizedMessages.length; messageIndex++) {
		const message = normalizedMessages[messageIndex];
		if (message.role !== "user") continue;
		const text = isInjectedContextText(message.text) ? "" : message.text.toLowerCase();
		if (!text) continue;
		const source = message.sourceId === undefined
			? `index:${messageIndex}:${stableHash(text)}`
			: `id:${message.sourceId}`;
		for (const [lower, name] of selected) {
			if (!isMentioned(text, lower)) continue;
			const key = `user:${source}:${lower}`;
			evidence.set(key, { key, name });
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
		if (!Array.isArray(message.content)) continue;
		for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
			const rawBlock = message.content[blockIndex];
			if (!rawBlock || typeof rawBlock !== "object") continue;
			const block = rawBlock as Record<string, unknown>;
			if (block.type !== "tool_use" || typeof block.name !== "string") continue;
			const toolName = block.name.toLowerCase();
			if (toolName !== "skill" && toolName !== "activate_skill") continue;
			if (!block.input || typeof block.input !== "object") continue;
			const input = block.input as Record<string, unknown>;
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
	const out: SkillUsageStats = {};
	for (const [name, raw] of Object.entries(rawSkills)) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as { count?: unknown; lastUsed?: unknown };
		const count = typeof entry.count === "number" && Number.isFinite(entry.count) && entry.count > 0 ? Math.floor(entry.count) : 0;
		const lastUsed = typeof entry.lastUsed === "number" && Number.isFinite(entry.lastUsed) && entry.lastUsed > 0 ? Math.floor(entry.lastUsed) : 0;
		if (count > 0) out[name] = { count, lastUsed };
	}
	return out;
}

export function toUsageFile(stats: SkillUsageStats, now = Date.now()): SkillUsageFile {
	return { version: 1, updatedAt: new Date(now).toISOString(), skills: stats };
}

export function recordSkillUsage(stats: SkillUsageStats, names: readonly string[], now = Date.now()): SkillUsageStats {
	const next: SkillUsageStats = { ...stats };
	for (const name of new Set(names.filter(Boolean))) {
		const prev = next[name] ?? { count: 0, lastUsed: 0 };
		next[name] = { count: prev.count + 1, lastUsed: now };
	}
	return next;
}

/** Merge a process-local increment delta into the latest persisted snapshot. */
export function mergeUsageStats(base: SkillUsageStats, delta: SkillUsageStats): SkillUsageStats {
	const next: SkillUsageStats = { ...base };
	for (const [name, entry] of Object.entries(delta)) {
		const previous = next[name] ?? { count: 0, lastUsed: 0 };
		next[name] = {
			count: previous.count + entry.count,
			lastUsed: Math.max(previous.lastUsed, entry.lastUsed),
		};
	}
	return next;
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

export function selectPinnedSkills(stats: SkillUsageStats, limit: number, now = Date.now()): string[] {
	if (limit <= 0) return [];
	const dayMs = 24 * 60 * 60 * 1000;
	return Object.entries(stats)
		.map(([name, entry]) => {
			const ageDays = Math.max(0, (now - entry.lastUsed) / dayMs);
			const recency = 1 / (1 + ageDays);
			const frequency = Math.log1p(entry.count);
			return { name, score: frequency + recency };
		})
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map((entry) => entry.name);
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
