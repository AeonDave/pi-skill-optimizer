import assert from "node:assert/strict";
import { test } from "node:test";
import { needsProfileScopeRepair } from "../src/init-profile.ts";
import { CATALOG_TAGS } from "../src/catalog.ts";
import {
	computeFinalHashes,
	diffSkills,
	hashSkill,
	mergeIncrementalProfile,
	mergeProfiles,
	normalizeProfile,
	pruneProfileNames,
	splitProfileByScope,
} from "../src/profile.ts";

test("normalizeProfile keeps only name-owned routing fields and ignores legacy aliases", () => {
	const profile = normalizeProfile({
		aliases: { apk: ["android"] },
		critical: [" alpha ", "alpha", 42],
		queries: { alpha: [" deploy it ", "deploy it"], empty: [], bad: "x" },
		clusters: { release: ["alpha", " beta "] },
		negativeHints: { beta: [" unrelated "] },
	});
	assert.deepEqual(profile, {
		critical: ["alpha"],
		queries: { alpha: ["deploy it"] },
		clusters: { release: ["alpha", "beta"] },
		negativeHints: { beta: ["unrelated"] },
	});
	assert.ok(!("aliases" in profile));
	assert.deepEqual(normalizeProfile({ critical: ["critical"] }).critical, ["critical"]);
	assert.ok(!("activation" in normalizeProfile({ critical: ["critical"] })));
});

test("normalizeProfile preserves prototype-named owners as own keys", () => {
	const names = ["constructor", "toString", "__proto__"];
	const ownerRecord = (prefix: string) => Object.fromEntries(names.map((name) => [name, [`${prefix} ${name}`]]));
	const profile = normalizeProfile({
		queries: ownerRecord("query"),
		negativeHints: ownerRecord("negative"),
		clusters: Object.fromEntries(names.map((name) => [name, [name]])),
	});

	for (const name of names) {
		assert.equal(Object.hasOwn(profile.queries, name), true, `query owner ${name}`);
		assert.deepEqual(profile.queries[name], [`query ${name}`]);
		assert.equal(Object.hasOwn(profile.negativeHints, name), true, `negative owner ${name}`);
		assert.deepEqual(profile.negativeHints[name], [`negative ${name}`]);
		assert.equal(Object.hasOwn(profile.clusters, name), true, `cluster ${name}`);
		assert.deepEqual(profile.clusters[name], [name]);
	}
});

test("profile merges preserve newly added prototype-named records", () => {
	const names = ["constructor", "toString", "__proto__"];
	const records = Object.fromEntries(names.map((name) => [name, [`route ${name}`]]));
	const merged = mergeProfiles(normalizeProfile({}), normalizeProfile({ queries: records }));
	for (const name of names) {
		assert.equal(Object.hasOwn(merged.queries, name), true, `query owner ${name}`);
		assert.deepEqual(merged.queries[name], [`route ${name}`]);
	}
});

test("incremental profile merge preserves prototype-named refreshed records", () => {
	const names = ["constructor", "toString", "__proto__"];
	const records = Object.fromEntries(names.map((name) => [name, [`route ${name}`]]));
	const merged = mergeIncrementalProfile(normalizeProfile({}), normalizeProfile({ queries: records }), names);
	for (const name of names) {
		assert.equal(Object.hasOwn(merged.queries, name), true, `query owner ${name}`);
		assert.deepEqual(merged.queries[name], [`route ${name}`]);
	}
});

test("normalizeProfile retains only valid owner-keyed skill activation metadata", () => {
	const profile = normalizeProfile({
		activation: {
			" primary ": { kind: "specialist", tasks: [" software-change ", "software-change", "software-test", 42] },
			invalid: { kind: "unknown", tasks: ["software-change"] },
			badTasks: { kind: "workflow", tasks: "software-change" },
			empty: { kind: "behavioral", tasks: [] },
		},
	});
	assert.deepEqual(profile.activation, {
		primary: { kind: "specialist", tasks: ["software-change", "software-test"] },
	});
});

test("normalizeProfile preserves only valid semantic catalog cards, including prototype-named owners", () => {
	const tag = CATALOG_TAGS[0]!.id;
	const names = ["alpha", "__proto__"];
	const cards = Object.fromEntries(names.map((name) => [name, {
		summary: `Distinctive ${name} skill.`,
		tags: [tag],
		sourceHash: hashSkill(name, `${name} description`),
	}]));
	const profile = normalizeProfile({ catalog: { version: 1, cards: {
		...cards,
		invalid: { summary: "", tags: ["not-a-catalog-tag"], sourceHash: "bad" },
	} } });
	assert.deepEqual(Object.keys(profile.catalog?.cards ?? {}).sort(), names.sort());
	for (const name of names) {
		assert.equal(Object.hasOwn(profile.catalog!.cards, name), true, `catalog owner ${name}`);
		assert.deepEqual(profile.catalog!.cards[name], cards[name]);
	}
	assert.equal(normalizeProfile({ catalog: { version: 99, cards } }).catalog, undefined);
});

test("hashSkill is an unambiguous SHA-256 content fingerprint", () => {
	const hash = hashSkill("alpha", "description");
	assert.match(hash, /^[a-f0-9]{64}$/);
	assert.notEqual(hash, hashSkill("alpha", "description changed"));
	assert.notEqual(hashSkill("ab", "c"), hashSkill("a", "bc"));
});

test("diffSkills finds modifications, additions, and removals", () => {
	const stored = {
		alpha: hashSkill("alpha", "old"),
		removed: hashSkill("removed", "gone"),
	};
	const result = diffSkills([
		{ name: "alpha", description: "new" },
		{ name: "beta", description: "added" },
	], stored);
	assert.deepEqual(result.changed, ["alpha", "beta"]);
	assert.deepEqual(result.removed, ["removed"]);
	assert.deepEqual(Object.keys(result.hashes), ["alpha", "beta"]);
});

test("diffSkills hashes and removes prototype-named skill keys safely", () => {
	const names = ["constructor", "toString", "__proto__"];
	const current = names.map((name) => ({ name, description: `description for ${name}` }));
	const result = diffSkills(current, {});
	assert.deepEqual(result.changed, names);
	assert.deepEqual(result.removed, []);
	for (const skill of current) {
		assert.equal(Object.hasOwn(result.hashes, skill.name), true, `hash for ${skill.name}`);
		assert.equal(result.hashes[skill.name], hashSkill(skill.name, skill.description));
	}

	const stored = Object.fromEntries(names.map((name) => [name, hashSkill(name, `old ${name}`)]));
	assert.deepEqual(diffSkills([], stored).removed, names);
});

test("computeFinalHashes removes only failed current skills and preserves identity otherwise", () => {
	const hashes = { alpha: "a", beta: "b" };
	assert.deepEqual(computeFinalHashes(hashes, ["beta"]), { alpha: "a" });
	assert.equal(computeFinalHashes(hashes, []), hashes);
	assert.equal(computeFinalHashes(hashes, ["unknown"]), hashes);
});

test("computeFinalHashes ignores inherited prototype names when deciding whether to copy", () => {
	const hashes = { alpha: "a" };
	assert.equal(computeFinalHashes(hashes, ["constructor", "toString", "__proto__"]), hashes);
});

test("computeFinalHashes retains only previously verified unchanged source identities for pending owners", () => {
	const hashes = { unchanged: "same", changed: "new", fresh: "first", completed: "accepted" };
	const previous = { unchanged: "same", changed: "old" };
	assert.deepEqual(computeFinalHashes(hashes, ["unchanged", "changed", "fresh"], previous), {
		unchanged: "same", completed: "accepted",
	});
	assert.equal(computeFinalHashes(hashes, ["unchanged"], previous), hashes,
		"retaining known source identity must not copy or mark a missing card complete");
});

test("computeFinalHashes requires own prior hashes and preserves prototype-like skill owners", () => {
	const hashes = Object.fromEntries([["__proto__", "same"], ["constructor", "same"], ["toString", "same"]]);
	const previous = Object.create({ constructor: "same", toString: "same" }) as Record<string, string>;
	Object.defineProperty(previous, "__proto__", { value: "same", enumerable: true });
	const result = computeFinalHashes(hashes, Object.keys(hashes), previous);
	assert.deepEqual(Object.keys(result), ["__proto__"]);
	assert.equal(Object.hasOwn(result, "__proto__"), true);
	assert.equal(result["__proto__"], "same");
});

test("pruneProfileNames removes every reference and drops empty clusters", () => {
	const profile = normalizeProfile({
		critical: ["alpha", "beta"],
		queries: { alpha: ["a"], beta: ["b"] },
		clusters: { mixed: ["alpha", "beta"], alpha_only: ["alpha"] },
		negativeHints: { alpha: ["x"], beta: ["y"] },
	});
	const result = pruneProfileNames(profile, ["alpha"]);
	assert.deepEqual(result, {
		critical: ["beta"],
		queries: { beta: ["b"] },
		clusters: { mixed: ["beta"] },
		negativeHints: { beta: ["y"] },
	});
	assert.equal(pruneProfileNames(result, []), result);
});

test("pruneProfileNames removes activation records by owner without treating tasks as names", () => {
	const profile = normalizeProfile({
		activation: {
			owner: { kind: "specialist", tasks: ["software-change", "software-review"] },
			removedOwner: { kind: "workflow", tasks: ["software-design"] },
		},
	});
	assert.deepEqual(pruneProfileNames(profile, ["software-change", "removedOwner"]), {
		critical: [], queries: {}, clusters: {}, negativeHints: {},
		activation: { owner: { kind: "specialist", tasks: ["software-change", "software-review"] } },
	});
	assert.equal(pruneProfileNames(profile, ["owner", "removedOwner"]).activation, undefined);
});

test("pruneProfileNames removes semantic catalog cards by exact owner", () => {
	const tag = CATALOG_TAGS[0]!.id;
	const profile = normalizeProfile({ catalog: { version: 1, cards: {
		keep: { summary: "Keep this capability.", tags: [tag], sourceHash: hashSkill("keep", "keep desc") },
		remove: { summary: "Remove this capability.", tags: [tag], sourceHash: hashSkill("remove", "remove desc") },
	} } });
	assert.deepEqual(Object.keys(pruneProfileNames(profile, ["remove"]).catalog?.cards ?? {}), ["keep"]);
});

test("mergeIncrementalProfile replaces refreshed ownership and ignores batch leakage", () => {
	const base = normalizeProfile({
		critical: ["keep", "changed"],
		queries: { keep: ["old keep"], changed: ["old changed"] },
		clusters: { old: ["keep", "changed"] },
		negativeHints: { keep: ["keep hint"], changed: ["old hint"] },
	});
	const partial = normalizeProfile({
		critical: ["changed", "leaked"],
		queries: { changed: ["new changed"], leaked: ["must not appear"] },
		clusters: { fresh: ["changed", "leaked"] },
		negativeHints: { changed: ["new hint"], leaked: ["must not appear"] },
	});
	const result = mergeIncrementalProfile(base, partial, ["changed"]);
	assert.deepEqual(result, {
		critical: ["keep", "changed"],
		queries: { keep: ["old keep"], changed: ["new changed"] },
		clusters: { old: ["keep"], fresh: ["changed"] },
		negativeHints: { keep: ["keep hint"], changed: ["new hint"] },
	});
	assert.equal(mergeIncrementalProfile(base, partial, []), base);
});

test("mergeIncrementalProfile replaces complete activation metadata for refreshed owners only", () => {
	const base = normalizeProfile({
		activation: {
			refreshed: { kind: "specialist", tasks: ["software-change"] },
			otherOwner: { kind: "workflow", tasks: ["software-design"] },
		},
	});
	const partial = normalizeProfile({
		activation: {
			refreshed: { kind: "behavioral", tasks: ["software-review"] },
			otherOwner: { kind: "specialist", tasks: ["software-test"] },
			foreignOwner: { kind: "workflow", tasks: ["software-change"] },
		},
	});
	assert.deepEqual(mergeIncrementalProfile(base, partial, ["refreshed"]).activation, {
		otherOwner: { kind: "workflow", tasks: ["software-design"] },
		refreshed: { kind: "behavioral", tasks: ["software-review"] },
	});
});

test("mergeIncrementalProfile replaces catalog cards only for refreshed owners", () => {
	const tag = CATALOG_TAGS[0]!.id;
	const card = (name: string, summary: string, description = `${name} desc`) => ({
		summary,
		tags: [tag],
		sourceHash: hashSkill(name, description),
	});
	const base = normalizeProfile({ catalog: { version: 1, cards: {
		keep: card("keep", "Old kept card."),
		refresh: card("refresh", "Old refreshed card."),
	} } });
	const partial = normalizeProfile({ catalog: { version: 1, cards: {
		refresh: card("refresh", "New refreshed card."),
		foreign: card("foreign", "Must not leak."),
	} } });
	const merged = mergeIncrementalProfile(base, partial, ["refresh"]);
	assert.deepEqual(merged.catalog?.cards, {
		keep: card("keep", "Old kept card."),
		refresh: card("refresh", "New refreshed card."),
	});
});

test("mergeProfiles unions global and project routing evidence deterministically", () => {
	const base = normalizeProfile({
		critical: ["alpha"],
		queries: { alpha: ["one"] },
		clusters: { family: ["alpha"] },
		negativeHints: { alpha: ["avoid"] },
	});
	const override = normalizeProfile({
		critical: ["beta"],
		queries: { alpha: ["two"], beta: ["three"] },
		clusters: { family: ["beta"] },
		negativeHints: { alpha: ["skip"] },
	});
	assert.deepEqual(mergeProfiles(base, override), {
		critical: ["alpha", "beta"],
		queries: { alpha: ["one", "two"], beta: ["three"] },
		clusters: { family: ["alpha", "beta"] },
		negativeHints: { alpha: ["avoid", "skip"] },
	});
});

test("mergeProfiles replaces activation metadata per owner and omits empty optional fields", () => {
	const base = normalizeProfile({ activation: {
		alpha: { kind: "specialist", tasks: ["software-change"] },
		shared: { kind: "workflow", tasks: ["software-design"] },
	} });
	const override = normalizeProfile({ activation: {
		alpha: { kind: "behavioral", tasks: ["software-review"] },
		shared: { kind: "specialist", tasks: ["software-test"] },
	} });
	assert.deepEqual(mergeProfiles(base, override).activation, {
		alpha: { kind: "behavioral", tasks: ["software-review"] },
		shared: { kind: "specialist", tasks: ["software-test"] },
	});
	assert.ok(!("activation" in mergeProfiles(normalizeProfile({}), normalizeProfile({}))));
});

test("mergeProfiles replaces catalog metadata per owner with prototype-safe keys", () => {
	const tag = CATALOG_TAGS[0]!.id;
	const card = (name: string, summary: string) => ({
		summary,
		tags: [tag],
		sourceHash: hashSkill(name, `${name} desc`),
	});
	const merged = mergeProfiles(
		normalizeProfile({ catalog: { version: 1, cards: Object.fromEntries([
			["__proto__", card("__proto__", "Old prototype card.")],
			["keep", card("keep", "Keep this card.")],
		]) } }),
		normalizeProfile({ catalog: { version: 1, cards: Object.fromEntries([
			["__proto__", card("__proto__", "New prototype card.")],
		]) } }),
	);
	assert.equal(Object.hasOwn(merged.catalog!.cards, "__proto__"), true);
	assert.deepEqual(merged.catalog!.cards["__proto__"], card("__proto__", "New prototype card."));
	assert.deepEqual(merged.catalog!.cards.keep, card("keep", "Keep this card."));
});

test("splitProfileByScope preserves skills referenced only by clusters", () => {
	const profile = normalizeProfile({
		critical: ["global", "project"],
		queries: { global: ["g"], project: ["p"] },
		clusters: { mixed: ["global", "project"], only_cluster: ["orphan"] },
		negativeHints: { global: ["x"], project: ["y"] },
	});
	const { global, project } = splitProfileByScope(profile, new Set(["project"]));
	assert.deepEqual(global, {
		critical: ["global"],
		queries: { global: ["g"] },
		clusters: { mixed: ["global"], only_cluster: ["orphan"] },
		negativeHints: { global: ["x"] },
	});
	assert.deepEqual(project, {
		critical: ["project"],
		queries: { project: ["p"] },
		clusters: { mixed: ["project"] },
		negativeHints: { project: ["y"] },
	});
});

test("splitProfileByScope assigns activation metadata by owner key", () => {
	const profile = normalizeProfile({
		activation: {
			globalOwner: { kind: "specialist", tasks: ["software-change"] },
			projectOwner: { kind: "workflow", tasks: ["software-design"] },
		},
	});
	const { global, project } = splitProfileByScope(profile, new Set(["projectOwner", "projectTarget"]));
	assert.deepEqual(global.activation, { globalOwner: { kind: "specialist", tasks: ["software-change"] } });
	assert.deepEqual(project.activation, { projectOwner: { kind: "workflow", tasks: ["software-design"] } });
});

test("splitProfileByScope assigns catalog cards by exact owner name", () => {
	const tag = CATALOG_TAGS[0]!.id;
	const profile = normalizeProfile({ catalog: { version: 1, cards: {
		globalOwner: { summary: "Global capability.", tags: [tag], sourceHash: hashSkill("globalOwner", "d") },
		projectOwner: { summary: "Project capability.", tags: [tag], sourceHash: hashSkill("projectOwner", "d") },
	} } });
	const { global, project } = splitProfileByScope(profile, new Set(["projectOwner"]));
	assert.deepEqual(Object.keys(global.catalog?.cards ?? {}), ["globalOwner"]);
	assert.deepEqual(Object.keys(project.catalog?.cards ?? {}), ["projectOwner"]);
});

test("activation owner keys participate in profile scope repair but task labels do not", () => {
	const stored = (profile: unknown) => ({
		exists: true,
		profile: normalizeProfile(profile),
		hashes: {},
		initVersion: 4,
		revision: "revision",
	});
	const paths = { global: "global.json", project: "project.json" };
	assert.equal(needsProfileScopeRepair({
		paths,
		projectNames: new Set(["project-owner"]),
		global: stored({ activation: { "project-owner": { kind: "specialist", tasks: ["software-change"] } } }),
		project: stored({}),
	}), true);
	assert.equal(needsProfileScopeRepair({
		paths,
		projectNames: new Set(["project-owner"]),
		global: stored({ activation: { "global-owner": { kind: "specialist", tasks: ["software-change"] } } }),
		project: stored({}),
	}), false);
});

test("catalog card owners participate in profile scope repair", () => {
	const tag = CATALOG_TAGS[0]!.id;
	const stored = (profile: unknown) => ({
		exists: true,
		profile: normalizeProfile(profile),
		hashes: {},
		initVersion: 5,
		revision: "revision",
	});
	assert.equal(needsProfileScopeRepair({
		paths: { global: "global.json", project: "project.json" },
		projectNames: new Set(["project-owner"]),
		global: stored({ catalog: { version: 1, cards: {
			"project-owner": { summary: "Project capability.", tags: [tag], sourceHash: hashSkill("project-owner", "d") },
		} } }),
		project: stored({}),
	}), true);
});
