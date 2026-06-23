import { normalizeAliasRecord, type AliasRecord } from "./aliases.ts";

export interface SkillOptimizerProfile {
	aliases: AliasRecord;
	critical: string[];
	queries: Record<string, string[]>;
	clusters: Record<string, string[]>;
	negativeHints: Record<string, string[]>;
}

export const EMPTY_PROFILE: SkillOptimizerProfile = {
	aliases: {},
	critical: [],
	queries: {},
	clusters: {},
	negativeHints: {},
};

function normalizeNameList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)));
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [rawKey, rawItems] of Object.entries(value)) {
		const key = rawKey.trim();
		if (!key || !Array.isArray(rawItems)) continue;
		const items = Array.from(new Set(rawItems.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)));
		if (items.length > 0) out[key] = items;
	}
	return out;
}

export function normalizeProfile(value: unknown): SkillOptimizerProfile {
	const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
	return {
		aliases: normalizeAliasRecord(source.aliases ?? source),
		critical: normalizeNameList(source.critical),
		queries: normalizeStringArrayRecord(source.queries),
		clusters: normalizeStringArrayRecord(source.clusters),
		negativeHints: normalizeStringArrayRecord(source.negativeHints),
	};
}
