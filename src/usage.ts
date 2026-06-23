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

function messageText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	const chunks: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const m = message as { role?: unknown; content?: unknown };
		if (m.role !== "user") continue;
		if (typeof m.content === "string") {
			if (!isInjectedContextText(m.content)) chunks.push(m.content);
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
					const text = (block as { text?: unknown }).text;
					if (typeof text === "string" && !isInjectedContextText(text)) chunks.push(text);
				}
			}
		}
	}
	return chunks.join("\n").toLowerCase();
}

function isInjectedContextText(text: string): boolean {
	return text.trimStart().startsWith("context-mode active.");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMentioned(text: string, name: string): boolean {
	const escaped = escapeRegExp(name.toLowerCase());
	return new RegExp(`(^|[^a-z0-9:_-])/?${escaped}($|[^a-z0-9:_-])`).test(text);
}

function collectSkillToolInputs(messages: unknown): string[] {
	if (!Array.isArray(messages)) return [];
	const out: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as { type?: unknown; name?: unknown; input?: unknown };
			if (b.type !== "tool_use" || typeof b.name !== "string") continue;
			const toolName = b.name.toLowerCase();
			if (toolName !== "skill" && toolName !== "activate_skill") continue;
			if (!b.input || typeof b.input !== "object") continue;
			const input = b.input as Record<string, unknown>;
			for (const key of ["skill", "skillName", "skill_name", "name"]) {
				const value = input[key];
				if (typeof value === "string" && value.trim()) out.push(value.trim().toLowerCase());
			}
		}
	}
	return out;
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

/**
 * Pick conservative usage signals for future pinning.
 *
 * Do not feed every ranked/selected skill back into usage stats: ranking is a
 * retrieval decision, not proof that the model actually wanted the skill. We
 * record only explicit user mentions or prior skill tool invocations visible in
 * the conversation, filtered to skills that survived the current optimizer pass.
 */
export function selectUsageRecordSkills(messages: unknown, selectedSkills: readonly string[]): string[] {
	const selected = [...new Set(selectedSkills.filter(Boolean))];
	if (selected.length === 0) return [];
	const userText = messageText(messages);
	const toolInputs = new Set(collectSkillToolInputs(messages));
	return selected.filter((name) => isMentioned(userText, name) || toolInputs.has(name.toLowerCase()));
}

export function usageRecordSignature(messages: unknown, names: readonly string[]): string {
	const selected = [...new Set(names.filter(Boolean))].sort();
	if (selected.length === 0) return "";
	return `${selected.join(",")}\n${messageText(messages).slice(0, 2000)}`;
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
