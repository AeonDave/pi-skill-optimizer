import type { ProfileWrite, StoredProfile } from "./persistence.ts";
import {
	EMPTY_PROFILE,
	splitProfileByScope,
	type SkillOptimizerProfile,
} from "./profile.ts";

function pickKeys(record: Record<string, string>, keep: (name: string) => boolean): Record<string, string> {
	return Object.fromEntries(Object.entries(record).filter(([name]) => keep(name)));
}

function ownedProfileNames(profile: SkillOptimizerProfile): Set<string> {
	return new Set([
		...profile.critical,
		...Object.keys(profile.queries),
		...Object.keys(profile.negativeHints),
		...Object.values(profile.clusters).flat(),
	]);
}

function storedNames(stored: StoredProfile | undefined): Set<string> {
	if (!stored?.exists) return new Set();
	return new Set([
		...Object.keys(stored.hashes),
		...ownedProfileNames(stored.profile),
	]);
}

/** Detect profile/hash ownership that no longer matches Pi's current skill scope. */
export function needsProfileScopeRepair(options: {
	paths: { global: string; project: string };
	projectNames: ReadonlySet<string>;
	global: StoredProfile;
	project?: StoredProfile;
}): boolean {
	if (options.paths.global === options.paths.project) return false;
	if (options.projectNames.size > 0 && !options.project?.exists) return true;
	for (const name of storedNames(options.global)) {
		if (options.projectNames.has(name)) return true;
	}
	for (const name of storedNames(options.project)) {
		if (!options.projectNames.has(name)) return true;
	}
	return false;
}

/** Build the complete global/project checkpoint from one merged profile snapshot. */
export function buildInitProfileWrites(options: {
	paths: { global: string; project: string };
	profile: SkillOptimizerProfile;
	hashes: Record<string, string>;
	skillCount: number;
	projectNames: ReadonlySet<string>;
	globalRevision: string | null;
	projectRevision: string | null;
	projectExists: boolean;
}): ProfileWrite[] {
	const split = options.paths.project !== options.paths.global && options.projectNames.size > 0;
	if (!split) {
		const writes: ProfileWrite[] = [{
			path: options.paths.global,
			profile: options.profile,
			skillCount: options.skillCount,
			hashes: options.hashes,
			expectedRevision: options.globalRevision,
		}];
		if (options.projectExists) {
			writes.push({
				path: options.paths.project,
				profile: EMPTY_PROFILE,
				skillCount: 0,
				hashes: {},
				expectedRevision: options.projectRevision,
			});
		}
		return writes;
	}
	const scoped = splitProfileByScope(options.profile, options.projectNames);
	return [
		{
			path: options.paths.global,
			profile: scoped.global,
			skillCount: Object.keys(options.hashes).filter((name) => !options.projectNames.has(name)).length,
			hashes: pickKeys(options.hashes, (name) => !options.projectNames.has(name)),
			expectedRevision: options.globalRevision,
		},
		{
			path: options.paths.project,
			profile: scoped.project,
			skillCount: Object.keys(options.hashes).filter((name) => options.projectNames.has(name)).length,
			hashes: pickKeys(options.hashes, (name) => options.projectNames.has(name)),
			expectedRevision: options.projectRevision,
		},
	];
}
