import assert from "node:assert/strict";
import test from "node:test";

import {
	INIT_READINESS_ENTRY_TYPE,
	buildInitNoticeKey,
	buildInitReadiness,
	readInitNoticeKeys,
	type InitReadinessProfile,
} from "../src/init-readiness.ts";
import { EMPTY_PROFILE, hashSkill, normalizeProfile } from "../src/profile.ts";

const currentVersion = 5;
const catalogInitVersion = 6;
const skill = { name: "typescript", description: "Review TypeScript code." };
const skillHash = hashSkill(skill.name, skill.description);

function catalogProfile(sourceHash = skillHash) {
	return normalizeProfile({
		catalog: {
			version: 1,
			cards: {
				typescript: { summary: "Review TypeScript code", tags: ["programming"], sourceHash },
			},
		},
	});
}

function storedProfile(overrides: Partial<InitReadinessProfile> = {}): InitReadinessProfile {
	return {
		exists: true,
		profile: EMPTY_PROFILE,
		hashes: { typescript: skillHash },
		initVersion: currentVersion,
		...overrides,
	};
}

test("readiness distinguishes an absent or empty profile from generated metadata", () => {
	assert.equal(buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: { stored: { ...storedProfile(), exists: false, hashes: {}, initVersion: 0 }, skills: [skill] },
	}).status, "empty");

	assert.equal(buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: { stored: { ...storedProfile(), profile: EMPTY_PROFILE, hashes: {}, initVersion: 0 }, skills: [skill] },
	}).status, "empty");
});

test("readiness identifies a nonempty unversioned profile as intentional manual data", () => {
	const manual = {
		critical: ["typescript"],
		queries: {},
		clusters: {},
		negativeHints: {},
	};
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: {
			stored: { ...storedProfile(), profile: manual, hashes: {}, initVersion: 0 },
			skills: [skill],
		},
	});
	assert.equal(readiness.status, "manual");
});

test("readiness distinguishes generated profiles with an old init version", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: {
			stored: storedProfile({ initVersion: currentVersion - 1 }),
			skills: [skill],
		},
	});
	assert.equal(readiness.status, "outdated");
});

test("readiness detects missing hashes in otherwise current generated profiles", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: {
			stored: storedProfile({ hashes: {} }),
			skills: [skill],
		},
	});
	assert.equal(readiness.status, "incomplete");
});

test("readiness accepts current hashes even when no activation tags were generated", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: { stored: storedProfile(), skills: [skill] },
	});
	assert.equal(readiness.status, "current");
});

test("version 6 generated readiness rejects missing and stale per-skill catalog cards", () => {
	const missing = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: catalogInitVersion,
		global: { stored: storedProfile({ initVersion: catalogInitVersion }), skills: [skill] },
	});
	assert.equal(missing.status, "incomplete");

	const stale = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: catalogInitVersion,
		global: {
			stored: storedProfile({
				profile: catalogProfile("0".repeat(64)),
				initVersion: catalogInitVersion,
			}),
			skills: [skill],
		},
	});
	assert.equal(stale.status, "incomplete");
});

test("version 6 generated readiness accepts complete current catalog cards and hashes", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: catalogInitVersion,
		global: {
			stored: storedProfile({ profile: catalogProfile(), initVersion: catalogInitVersion }),
			skills: [skill],
		},
	});
	assert.equal(readiness.status, "current");
});

test("an unversioned catalog-only profile is manual rather than empty", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: catalogInitVersion,
		global: {
			stored: storedProfile({ profile: catalogProfile(), hashes: {}, initVersion: 0 }),
			skills: [skill],
		},
	});
	assert.equal(readiness.status, "manual");
});

test("readiness checks project and global skill scopes independently", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: { stored: storedProfile(), skills: [skill] },
		project: {
			stored: { ...storedProfile(), exists: false, hashes: {}, initVersion: 0 },
			skills: [{ name: "project-skill", description: "Project-only skill." }],
		},
	});
	assert.equal(readiness.status, "incomplete");
});

test("an existing empty profile cannot stand in for a missing generated scope", () => {
	const readiness = buildInitReadiness({
		scopeKey: "global::project",
		initVersion: currentVersion,
		global: { stored: storedProfile(), skills: [skill] },
		project: {
			stored: {
				...storedProfile(),
				profile: EMPTY_PROFILE,
				hashes: {},
				initVersion: 0,
			},
			skills: [{ name: "project-skill", description: "Project-only skill." }],
		},
	});
	assert.equal(readiness.status, "incomplete");
});

test("notice keys bind profile scope, init version, and readiness state", () => {
	const key = buildInitNoticeKey("global::project", currentVersion, "incomplete");
	assert.equal(key, buildInitNoticeKey("global::project", currentVersion, "incomplete"));
	assert.notEqual(key, buildInitNoticeKey("other::project", currentVersion, "incomplete"));
	assert.notEqual(key, buildInitNoticeKey("global::project", currentVersion + 1, "incomplete"));
	assert.notEqual(key, buildInitNoticeKey("global::project", currentVersion, "outdated"));
});

test("notice keys rehydrate from custom session entries without exposing messages", () => {
	const key = buildInitNoticeKey("global::project", currentVersion, "empty");
	const keys = readInitNoticeKeys([
		{ type: "custom", customType: INIT_READINESS_ENTRY_TYPE, data: { schema: 1, key } },
		{ type: "custom", customType: "other-extension", data: { schema: 1, key: "ignored" } },
		{ type: "message", message: { role: "user", content: "ignored" } },
	]);
	assert.deepEqual([...keys], [key]);
});
