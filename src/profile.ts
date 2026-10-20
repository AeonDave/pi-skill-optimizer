import { normalizeActivation, type SkillActivation } from "./activation.ts";
import {
	catalogSourceHash,
	normalizeCatalogMetadata,
	type CatalogCard,
	type CatalogMetadata,
} from "./catalog.ts";

export interface SkillOptimizerProfile {
	critical: string[];
	queries: Record<string, string[]>;
	clusters: Record<string, string[]>;
	negativeHints: Record<string, string[]>;
	activation?: Record<string, SkillActivation>;
	catalog?: CatalogMetadata;
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

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(record, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}

function ownRecordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
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
		if (name && values.length > 0) setOwnRecordValue(out, name, values);
	}
	return out;
}

export function normalizeProfile(value: unknown): SkillOptimizerProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { critical: [], queries: {}, clusters: {}, negativeHints: {} };
	}
	const source = value as Record<string, unknown>;
	const profile: SkillOptimizerProfile = {
		critical: normalizeStringArray(source.critical),
		queries: normalizeRecord(source.queries),
		clusters: normalizeRecord(source.clusters),
		negativeHints: normalizeRecord(source.negativeHints),
	};
	const activation = normalizeActivation(source.activation);
	if (Object.keys(activation).length > 0) profile.activation = activation;
	const catalog = normalizeCatalogMetadata(source.catalog);
	if (catalog && Object.keys(catalog.cards).length > 0) profile.catalog = catalog;
	return profile;
}

export function hashSkill(name: string, description: string): string {
	return catalogSourceHash(name, description);
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
		if (!name || Object.prototype.hasOwnProperty.call(hashes, name)) continue;
		const hash = hashSkill(name, skill.description);
		setOwnRecordValue(hashes, name, hash);
		if (!Object.prototype.hasOwnProperty.call(stored, name) || stored[name] !== hash) changed.push(name);
	}
	const removed = Object.keys(stored).filter((name) => !Object.prototype.hasOwnProperty.call(hashes, name));
	return { changed, removed, hashes };
}

/**
 * Pending replacements cannot advance a source identity. Preserve an already known,
 * unchanged identity so repeated catalog migrations retain valid prior hints;
 * missing or stale catalog cards independently keep those owners eligible for init.
 */
export function computeFinalHashes(
	hashes: Record<string, string>,
	failed: Iterable<string>,
	previousHashes?: Readonly<Record<string, string>>,
): Record<string, string> {
	const failedNames = new Set([...failed].filter((name) =>
		Object.prototype.hasOwnProperty.call(hashes, name)
		&& (!previousHashes || !Object.prototype.hasOwnProperty.call(previousHashes, name) || previousHashes[name] !== hashes[name]),
	));
	if (failedNames.size === 0) return hashes;
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
	return Object.fromEntries(Object.entries(clusters)
		.map(([cluster, names]) => [cluster, names.filter(predicate)] as const)
		.filter(([, retained]) => retained.length > 0));
}

function filterActivation(
	activation: Record<string, SkillActivation> | undefined,
	predicate: (owner: string) => boolean,
): Record<string, SkillActivation> {
	return Object.fromEntries(Object.entries(activation ?? [])
		.filter(([owner]) => predicate(owner))
		.map(([owner, value]) => [owner, { kind: value.kind, tasks: [...value.tasks] }]));
}

function filterCatalog(
	catalog: CatalogMetadata | undefined,
	predicate: (owner: string) => boolean,
): CatalogMetadata | undefined {
	if (!catalog) return undefined;
	const cards: Record<string, CatalogCard> = {};
	for (const [owner, card] of Object.entries(catalog.cards)) {
		if (predicate(owner)) setOwnRecordValue(cards, owner, {
			summary: card.summary,
			tags: [...card.tags],
			sourceHash: card.sourceHash,
		});
	}
	return Object.keys(cards).length > 0 ? { version: catalog.version, cards } : undefined;
}

function mergeCatalog(
	base: CatalogMetadata | undefined,
	override: CatalogMetadata | undefined,
): CatalogMetadata | undefined {
	const cards: Record<string, CatalogCard> = {};
	for (const source of [base, override]) {
		for (const [owner, card] of Object.entries(source?.cards ?? {})) {
			setOwnRecordValue(cards, owner, {
				summary: card.summary,
				tags: [...card.tags],
				sourceHash: card.sourceHash,
			});
		}
	}
	if (Object.keys(cards).length === 0) return undefined;
	return { version: override?.version ?? base!.version, cards };
}

function mergeActivation(
	base: Record<string, SkillActivation> | undefined,
	override: Record<string, SkillActivation> | undefined,
): Record<string, SkillActivation> {
	const entries = new Map<string, SkillActivation>();
	for (const [owner, value] of Object.entries(base ?? {})) {
		entries.set(owner, { kind: value.kind, tasks: [...value.tasks] });
	}
	for (const [owner, value] of Object.entries(override ?? {})) {
		entries.set(owner, { kind: value.kind, tasks: [...value.tasks] });
	}
	return Object.fromEntries(entries);
}

function includeActivation(
	profile: SkillOptimizerProfile,
	activation: Record<string, SkillActivation>,
): SkillOptimizerProfile {
	if (Object.keys(activation).length > 0) profile.activation = activation;
	return profile;
}

export function pruneProfileNames(profile: SkillOptimizerProfile, removed: Iterable<string>): SkillOptimizerProfile {
	const removedNames = new Set(removed);
	if (removedNames.size === 0) return profile;
	const keep = (name: string): boolean => !removedNames.has(name);
	const next = includeActivation({
		critical: profile.critical.filter(keep),
		queries: filterRecord(profile.queries, keep),
		clusters: filterClusters(profile.clusters, keep),
		negativeHints: filterRecord(profile.negativeHints, keep),
	}, filterActivation(profile.activation, keep));
	const catalog = filterCatalog(profile.catalog, keep);
	if (catalog) next.catalog = catalog;
	const unchanged = next.critical.length === profile.critical.length
		&& Object.keys(next.queries).length === Object.keys(profile.queries).length
		&& Object.values(next.clusters).flat().length === Object.values(profile.clusters).flat().length
		&& Object.keys(next.negativeHints).length === Object.keys(profile.negativeHints).length
		&& Object.keys(next.activation ?? {}).length === Object.keys(profile.activation ?? {}).length
		&& Object.keys(next.catalog?.cards ?? {}).length === Object.keys(profile.catalog?.cards ?? {}).length;
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
	for (const [name, values] of Object.entries(override)) {
		setOwnRecordValue(out, name, union(ownRecordValue(out, name) ?? [], values));
	}
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
		if (isRefreshed(name)) setOwnRecordValue(queries, name, [...values]);
	}
	for (const [name, values] of Object.entries(partial.negativeHints)) {
		if (isRefreshed(name)) setOwnRecordValue(negativeHints, name, [...values]);
	}
	const clusters = filterClusters(base.clusters, keepOld);
	for (const [cluster, names] of Object.entries(partial.clusters)) {
		const owned = names.filter(isRefreshed);
		if (owned.length > 0) setOwnRecordValue(clusters, cluster, union(ownRecordValue(clusters, cluster) ?? [], owned));
	}
	const activation = mergeActivation(
		filterActivation(base.activation, keepOld),
		filterActivation(partial.activation, isRefreshed),
	);
	const result = includeActivation({
		critical: union(base.critical.filter(keepOld), partial.critical.filter(isRefreshed)),
		queries,
		clusters,
		negativeHints,
	}, activation);
	const catalog = mergeCatalog(
		filterCatalog(base.catalog, keepOld),
		filterCatalog(partial.catalog, isRefreshed),
	);
	if (catalog) result.catalog = catalog;
	return result;
}

export function mergeProfiles(base: SkillOptimizerProfile, override: SkillOptimizerProfile): SkillOptimizerProfile {
	const result = includeActivation({
		critical: union(base.critical, override.critical),
		queries: mergeRecord(base.queries, override.queries),
		clusters: mergeRecord(base.clusters, override.clusters),
		negativeHints: mergeRecord(base.negativeHints, override.negativeHints),
	}, mergeActivation(base.activation, override.activation));
	const catalog = mergeCatalog(base.catalog, override.catalog);
	if (catalog) result.catalog = catalog;
	return result;
}

export function splitProfileByScope(
	profile: SkillOptimizerProfile,
	projectNames: ReadonlySet<string>,
): { global: SkillOptimizerProfile; project: SkillOptimizerProfile } {
	const isProject = (name: string): boolean => projectNames.has(name);
	const isGlobal = (name: string): boolean => !projectNames.has(name);
	const global = includeActivation({
			critical: profile.critical.filter(isGlobal),
			queries: filterRecord(profile.queries, isGlobal),
			clusters: filterClusters(profile.clusters, isGlobal),
			negativeHints: filterRecord(profile.negativeHints, isGlobal),
		}, filterActivation(profile.activation, isGlobal));
	const project = includeActivation({
			critical: profile.critical.filter(isProject),
			queries: filterRecord(profile.queries, isProject),
			clusters: filterClusters(profile.clusters, isProject),
			negativeHints: filterRecord(profile.negativeHints, isProject),
		}, filterActivation(profile.activation, isProject));
	const globalCatalog = filterCatalog(profile.catalog, isGlobal);
	const projectCatalog = filterCatalog(profile.catalog, isProject);
	if (globalCatalog) global.catalog = globalCatalog;
	if (projectCatalog) project.catalog = projectCatalog;
	return { global, project };
}
