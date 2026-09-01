import { createHash } from "node:crypto";

export interface SkillOptimizerProfile {
	critical: string[];
	queries: Record<string, string[]>;
	clusters: Record<string, string[]>;
	negativeHints: Record<string, string[]>;
}

export const EMPTY_PROFILE: SkillOptimizerProfile = {
	critical: [],
	queries: {},
	clusters: {},
	negativeHints: {},
};

function normalizeName(value: string): string {
	return value.trim();
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.replace(/\s+/g, " ").trim())
		.filter(Boolean))];
}

function normalizeRecord(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string[]> = {};
	for (const [rawName, rawValues] of Object.entries(value)) {
		const name = normalizeName(rawName);
		const values = normalizeStringArray(rawValues);
		if (name && values.length > 0) out[name] = values;
	}
	return out;
}

export function normalizeProfile(value: unknown): SkillOptimizerProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { critical: [], queries: {}, clusters: {}, negativeHints: {} };
	}
	const source = value as Record<string, unknown>;
	return {
		critical: normalizeStringArray(source.critical),
		queries: normalizeRecord(source.queries),
		clusters: normalizeRecord(source.clusters),
		negativeHints: normalizeRecord(source.negativeHints),
	};
}

export function hashSkill(name: string, description: string): string {
	const hash = createHash("sha256");
	hash.update("pi-skill-optimizer:skill:v2\0", "utf8");
	hash.update(String(Buffer.byteLength(name, "utf8")), "utf8");
	hash.update(":", "utf8");
	hash.update(name, "utf8");
	hash.update(String(Buffer.byteLength(description, "utf8")), "utf8");
	hash.update(":", "utf8");
	hash.update(description, "utf8");
	return hash.digest("hex");
}

export interface SkillRef {
	name: string;
	description: string;
}

export interface SkillDiff {
	changed: string[];
	removed: string[];
	hashes: Record<string, string>;
}

export function diffSkills(current: readonly SkillRef[], stored: Record<string, string>): SkillDiff {
	const hashes: Record<string, string> = {};
	const changed: string[] = [];
	for (const skill of current) {
		const name = normalizeName(skill.name);
		if (!name || name in hashes) continue;
		const hash = hashSkill(name, skill.description);
		hashes[name] = hash;
		if (stored[name] !== hash) changed.push(name);
	}
	const removed = Object.keys(stored).filter((name) => !(name in hashes));
	return { changed, removed, hashes };
}

export function computeFinalHashes(hashes: Record<string, string>, failed: Iterable<string>): Record<string, string> {
	const failedNames = new Set(failed);
	if (![...failedNames].some((name) => name in hashes)) return hashes;
	const out = { ...hashes };
	for (const name of failedNames) delete out[name];
	return out;
}

function filterRecord(
	record: Record<string, string[]>,
	predicate: (name: string) => boolean,
): Record<string, string[]> {
	return Object.fromEntries(Object.entries(record)
		.filter(([name]) => predicate(name))
		.map(([name, values]) => [name, [...values]]));
}

function filterClusters(
	clusters: Record<string, string[]>,
	predicate: (name: string) => boolean,
): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [cluster, names] of Object.entries(clusters)) {
		const retained = names.filter(predicate);
		if (retained.length > 0) out[cluster] = retained;
	}
	return out;
}

export function pruneProfileNames(profile: SkillOptimizerProfile, removed: Iterable<string>): SkillOptimizerProfile {
	const removedNames = new Set(removed);
	if (removedNames.size === 0) return profile;
	const keep = (name: string): boolean => !removedNames.has(name);
	const next: SkillOptimizerProfile = {
		critical: profile.critical.filter(keep),
		queries: filterRecord(profile.queries, keep),
		clusters: filterClusters(profile.clusters, keep),
		negativeHints: filterRecord(profile.negativeHints, keep),
	};
	const unchanged = next.critical.length === profile.critical.length
		&& Object.keys(next.queries).length === Object.keys(profile.queries).length
		&& Object.values(next.clusters).flat().length === Object.values(profile.clusters).flat().length
		&& Object.keys(next.negativeHints).length === Object.keys(profile.negativeHints).length;
	return unchanged ? profile : next;
}

function union(left: readonly string[], right: readonly string[]): string[] {
	return [...new Set([...left, ...right])];
}

function mergeRecord(
	base: Record<string, string[]>,
	override: Record<string, string[]>,
): Record<string, string[]> {
	const out = Object.fromEntries(Object.entries(base).map(([name, values]) => [name, [...values]]));
	for (const [name, values] of Object.entries(override)) out[name] = union(out[name] ?? [], values);
	return out;
}

/**
 * Replace all name-owned data for refreshed skills. Partial output for names
 * outside refreshedNames is ignored, so a malformed batch cannot leak data.
 */
export function mergeIncrementalProfile(
	base: SkillOptimizerProfile,
	partial: SkillOptimizerProfile,
	refreshedNames: Iterable<string>,
): SkillOptimizerProfile {
	const refreshed = new Set(refreshedNames);
	if (refreshed.size === 0) return base;
	const keepOld = (name: string): boolean => !refreshed.has(name);
	const isRefreshed = (name: string): boolean => refreshed.has(name);
	const queries = filterRecord(base.queries, keepOld);
	const negativeHints = filterRecord(base.negativeHints, keepOld);
	for (const [name, values] of Object.entries(partial.queries)) {
		if (isRefreshed(name)) queries[name] = [...values];
	}
	for (const [name, values] of Object.entries(partial.negativeHints)) {
		if (isRefreshed(name)) negativeHints[name] = [...values];
	}
	const clusters = filterClusters(base.clusters, keepOld);
	for (const [cluster, names] of Object.entries(partial.clusters)) {
		const owned = names.filter(isRefreshed);
		if (owned.length > 0) clusters[cluster] = union(clusters[cluster] ?? [], owned);
	}
	return {
		critical: union(base.critical.filter(keepOld), partial.critical.filter(isRefreshed)),
		queries,
		clusters,
		negativeHints,
	};
}

export function mergeProfiles(base: SkillOptimizerProfile, override: SkillOptimizerProfile): SkillOptimizerProfile {
	return {
		critical: union(base.critical, override.critical),
		queries: mergeRecord(base.queries, override.queries),
		clusters: mergeRecord(base.clusters, override.clusters),
		negativeHints: mergeRecord(base.negativeHints, override.negativeHints),
	};
}

export function splitProfileByScope(
	profile: SkillOptimizerProfile,
	projectNames: ReadonlySet<string>,
): { global: SkillOptimizerProfile; project: SkillOptimizerProfile } {
	const isProject = (name: string): boolean => projectNames.has(name);
	const isGlobal = (name: string): boolean => !projectNames.has(name);
	return {
		global: {
			critical: profile.critical.filter(isGlobal),
			queries: filterRecord(profile.queries, isGlobal),
			clusters: filterClusters(profile.clusters, isGlobal),
			negativeHints: filterRecord(profile.negativeHints, isGlobal),
		},
		project: {
			critical: profile.critical.filter(isProject),
			queries: filterRecord(profile.queries, isProject),
			clusters: filterClusters(profile.clusters, isProject),
			negativeHints: filterRecord(profile.negativeHints, isProject),
		},
	};
}
