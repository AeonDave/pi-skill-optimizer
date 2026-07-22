import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ConcurrentFileUpdateError,
	loadStatsFile,
	loadExtractionTelemetryFile,
	loadUsageFile,
	pruneUsageFile,
	readStoredProfile,
	saveStatsDelta,
	saveStatsDeltas,
	saveTemporaryOutput,
	saveUsageDelta,
	writeProfileFiles,
} from "../src/persistence.ts";
import { EMPTY_PROFILE } from "../src/profile.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skill-optimizer-test-"));
}

test("profile writes reject stale snapshots instead of replacing newer data", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "profile.json");
		const empty = readStoredProfile(path);
		writeProfileFiles([{
			path,
			profile: { ...EMPTY_PROFILE, critical: ["first"] },
			skillCount: 1,
			hashes: { first: "one" },
			expectedRevision: empty.revision,
		}], 3, 1_700_000_000_000);
		assert.throws(() => writeProfileFiles([{
			path,
			profile: { ...EMPTY_PROFILE, critical: ["stale"] },
			skillCount: 1,
			hashes: { stale: "two" },
			expectedRevision: empty.revision,
		}], 3), ConcurrentFileUpdateError);
		const stored = readStoredProfile(path);
		assert.deepEqual(stored.profile.critical, ["first"]);
		assert.deepEqual(stored.hashes, { first: "one" });
		assert.equal(stored.initVersion, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("usage and stats persistence merge deltas into the latest locked snapshot", () => {
	const dir = tempDir();
	try {
		const usagePath = join(dir, "usage.json");
		const statsPath = join(dir, "stats.json");
		saveUsageDelta(usagePath, { alpha: { count: 2, lastUsed: 100 } });
		saveUsageDelta(usagePath, { alpha: { count: 1, lastUsed: 200 }, beta: { count: 1, lastUsed: 150 } });
		assert.deepEqual(loadUsageFile(usagePath), {
			alpha: { count: 3, lastUsed: 200 },
			beta: { count: 1, lastUsed: 150 },
		});
		saveStatsDelta(statsPath, { skills: 10, tools: 2, output: 0 });
		saveStatsDeltas(
			statsPath,
			{ skills: 3, tools: 0, output: 7 },
			{ attempts: 2, accepted: 1, fallbackEvidence: 1, fallbackSavings: 0, fallbackError: 0 },
		);
		assert.deepEqual(loadStatsFile(statsPath), { skills: 13, tools: 2, output: 7 });
		assert.deepEqual(loadExtractionTelemetryFile(statsPath), { attempts: 2, accepted: 1, fallbackEvidence: 1, fallbackSavings: 0, fallbackError: 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("usage pruning reloads under lock and persists deletions", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "usage.json");
		saveUsageDelta(path, { old: { count: 1, lastUsed: 1 }, keep: { count: 2, lastUsed: 1 } });
		const pruned = pruneUsageFile(path, { now: 200 * 86_400_000, staleDays: 180, maxEntries: 10 });
		assert.deepEqual(pruned, { keep: { count: 2, lastUsed: 1 } });
		assert.deepEqual(loadUsageFile(path), pruned);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("temporary full output uses unique exclusive private files", () => {
	const first = saveTemporaryOutput("first full output");
	const second = saveTemporaryOutput("second full output");
	assert.ok(first);
	assert.ok(second);
	try {
		assert.notEqual(first, second);
		assert.equal(readFileSync(first, "utf8"), "first full output");
		assert.equal(readFileSync(second, "utf8"), "second full output");
		if (process.platform !== "win32") {
			assert.equal(statSync(first).mode & 0o777, 0o600);
			assert.equal(statSync(second).mode & 0o777, 0o600);
		}
	} finally {
		if (first) unlinkSync(first);
		if (second) unlinkSync(second);
	}
});

test("a corrupt persisted snapshot is preserved rather than overwritten", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "usage.json");
		writeFileSync(path, "{broken", "utf8");
		assert.throws(() => saveUsageDelta(path, { alpha: { count: 1, lastUsed: 100 } }));
		assert.equal(readFileSync(path, "utf8"), "{broken");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
