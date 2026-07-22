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

const STRUCTURED_PROFILE_KEYS = ["aliases", "critical", "queries", "clusters", "negativeHints"] as const;

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
	const structured = STRUCTURED_PROFILE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key));
	return {
		aliases: normalizeAliasRecord(structured ? source.aliases : source),
		critical: normalizeNameList(source.critical),
		queries: normalizeStringArrayRecord(source.queries),
		clusters: normalizeStringArrayRecord(source.clusters),
		negativeHints: normalizeStringArrayRecord(source.negativeHints),
	};
}

function mergeAliasRecords(base: AliasRecord, override: AliasRecord): AliasRecord {
	const out: AliasRecord = {};
	for (const [key, targets] of Object.entries(base)) out[key] = [...targets];
	for (const [key, targets] of Object.entries(override)) {
		out[key] = Array.from(new Set([...(out[key] ?? []), ...targets]));
	}
	return out;
}

function mergeStringArrayRecords(base: Record<string, string[]>, override: Record<string, string[]>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [key, items] of Object.entries(base)) out[key] = [...items];
	for (const [key, items] of Object.entries(override)) {
		out[key] = Array.from(new Set([...(out[key] ?? []), ...items]));
	}
	return out;
}

/** Stable, dependency-free FNV-1a hash of a skill's identity (name + description). */
export function hashSkill(name: string, description: string): string {
	const input = `${name}\n${description}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface SkillRef {
	name: string;
	description: string;
}

export interface SkillDiff {
	/** New or modified skill names (need (re)processing). */
	changed: string[];
	/** Skill names present in the stored hashes but gone from the catalog. */
	removed: string[];
	/** Fresh hash map for the current catalog. */
	hashes: Record<string, string>;
}

/** Compare the current catalog against stored per-skill hashes. */
export function diffSkills(current: readonly SkillRef[], stored: Record<string, string>): SkillDiff {
	const hashes: Record<string, string> = {};
	const changed: string[] = [];
	const present = new Set<string>();
	for (const skill of current) {
		present.add(skill.name);
		const hash = hashSkill(skill.name, skill.description);
		hashes[skill.name] = hash;
		if (stored[skill.name] !== hash) changed.push(skill.name);
	}
	const removed = Object.keys(stored).filter((name) => !present.has(name));
	return { changed, removed, hashes };
}

/**
 * Drop the `failed` skills from a fresh hash map so the next `init` re-detects them
 * as changed and retries only them (a batch that errored must not be recorded as
 * already profiled). Returns the same reference when there is nothing to drop.
 */
export function computeFinalHashes(hashes: Record<string, string>, failed: Iterable<string>): Record<string, string> {
	const drop = new Set(failed);
	if (drop.size === 0) return hashes;
	const out: Record<string, string> = {};
	for (const [name, hash] of Object.entries(hashes)) {
		if (!drop.has(name)) out[name] = hash;
	}
	return out;
}

function omitKeys(record: Record<string, string[]>, drop: ReadonlySet<string>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!drop.has(key)) out[key] = value;
	}
	return out;
}

/** Drop every reference to `removed` skills from name-keyed sections and cluster members. */
export function pruneProfileNames(profile: SkillOptimizerProfile, removed: Iterable<string>): SkillOptimizerProfile {
	const drop = new Set(removed);
	if (drop.size === 0) return profile;
	const clusters: Record<string, string[]> = {};
	for (const [topic, members] of Object.entries(profile.clusters)) {
		const kept = members.filter((m) => !drop.has(m));
		if (kept.length > 0) clusters[topic] = kept;
	}
	return {
		aliases: profile.aliases, // query-token routing, runtime-filtered against the live catalog
		critical: profile.critical.filter((n) => !drop.has(n)),
		queries: omitKeys(profile.queries, drop),
		clusters,
		negativeHints: omitKeys(profile.negativeHints, drop),
	};
}

/**
 * Merge a freshly generated `partial` profile (covering only `changed` skills)
 * into `base`. For changed skills the partial wins; unchanged skills keep their
 * base entries. Aliases accumulate because they are catalog-filtered at use;
 * every name-bound field, including cluster membership, is replaced.
 */
export function mergeIncrementalProfile(
	base: SkillOptimizerProfile,
	partial: SkillOptimizerProfile,
	changed: Iterable<string>,
): SkillOptimizerProfile {
	const ch = new Set(changed);
	const baseClusters: Record<string, string[]> = {};
	for (const [topic, members] of Object.entries(base.clusters)) {
		const unchanged = members.filter((name) => !ch.has(name));
		if (unchanged.length > 0) baseClusters[topic] = unchanged;
	}
	return {
		aliases: mergeAliasRecords(base.aliases, partial.aliases),
		critical: Array.from(new Set([...base.critical.filter((n) => !ch.has(n)), ...partial.critical.filter((n) => ch.has(n))])),
		queries: { ...omitKeys(base.queries, ch), ...filterByNames(partial.queries, ch) },
		clusters: mergeStringArrayRecords(baseClusters, filterClustersByNames(partial.clusters, ch)),
		negativeHints: { ...omitKeys(base.negativeHints, ch), ...filterByNames(partial.negativeHints, ch) },
	};
}

/** Merge two profiles; `override` (project) wins/extends over `base` (global). */
export function mergeProfiles(base: SkillOptimizerProfile, override: SkillOptimizerProfile): SkillOptimizerProfile {
	return {
		aliases: mergeAliasRecords(base.aliases, override.aliases),
		critical: Array.from(new Set([...base.critical, ...override.critical])),
		queries: mergeStringArrayRecords(base.queries, override.queries),
		clusters: mergeStringArrayRecords(base.clusters, override.clusters),
		negativeHints: mergeStringArrayRecords(base.negativeHints, override.negativeHints),
	};
}

function filterByNames(record: Record<string, string[]>, names: ReadonlySet<string>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [key, items] of Object.entries(record)) {
		if (names.has(key)) out[key] = [...items];
	}
	return out;
}

function filterClustersByNames(clusters: Record<string, string[]>, names: ReadonlySet<string>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [topic, members] of Object.entries(clusters)) {
		const kept = members.filter((m) => names.has(m));
		if (kept.length > 0) out[topic] = kept;
	}
	return out;
}

/**
 * Split a generated profile into the entries that reference `projectNames` and the rest.
 * Aliases are query-token routing (catalog-filtered at use), so they stay in the global slice.
 * Name-keyed sections (critical/queries/negativeHints) and cluster members are routed by scope.
 */
export function splitProfileByScope(
	profile: SkillOptimizerProfile,
	projectNames: ReadonlySet<string>,
): { global: SkillOptimizerProfile; project: SkillOptimizerProfile } {
	const globalCritical = profile.critical.filter((n) => !projectNames.has(n));
	const projectCritical = profile.critical.filter((n) => projectNames.has(n));
	const allNames = new Set([
		...profile.critical,
		...Object.keys(profile.queries),
		...Object.keys(profile.negativeHints),
	]);
	for (const members of Object.values(profile.clusters)) {
		for (const name of members) allNames.add(name);
	}
	const globalNames = new Set([...allNames].filter((n) => !projectNames.has(n)));
	return {
		global: {
			aliases: profile.aliases,
			critical: globalCritical,
			queries: filterByNames(profile.queries, globalNames),
			clusters: filterClustersByNames(profile.clusters, globalNames),
			negativeHints: filterByNames(profile.negativeHints, globalNames),
		},
		project: {
			aliases: {},
			critical: projectCritical,
			queries: filterByNames(profile.queries, projectNames),
			clusters: filterClustersByNames(profile.clusters, projectNames),
			negativeHints: filterByNames(profile.negativeHints, projectNames),
		},
	};
}
