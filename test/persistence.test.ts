import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	ConcurrentFileUpdateError,
	cleanupTemporaryOutputs,
	DEFAULT_OUTPUT_ARCHIVE_TTL_MS,
	loadStatsFile,
	loadStatsSnapshot,
	loadExtractionTelemetryFile,
	loadProviderCacheTelemetryFile,
	loadUsageFile,
	pruneUsageFile,
	readStoredProfile,
	resolveTemporaryOutput,
	saveStatsDelta,
	saveStatsDeltas,
	saveProviderCacheTelemetryDelta,
	saveTemporaryOutput,
	saveUsageDelta,
	writeProfileFiles,
	withFileLocks,
} from "../src/persistence.ts";
import { EMPTY_PROFILE } from "../src/profile.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skill-optimizer-test-"));
}

function waitUntil(condition: () => boolean, timeoutMs = 10_000): void {
	const deadline = Date.now() + timeoutMs;
	const wait = new Int32Array(new SharedArrayBuffer(4));
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for child-process barrier");
		Atomics.wait(wait, 0, 0, 10);
	}
}

test("a stale timestamp cannot steal a lock from a live owner", () => {
	const directory = tempDir();
	try {
		const path = join(directory, "slow-write.json");
		withFileLocks([path], () => {
			const old = new Date(Date.now() - 60_000);
			utimesSync(`${path}.lock`, old, old);
			assert.throws(() => withFileLocks([path], () => assert.fail("stole a live owner's lock")), /timed out waiting for file lock/);
			assert.ok(existsSync(`${path}.lock`));
		});
		assert.equal(existsSync(`${path}.lock`), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an old lock is preserved and reports safe manual recovery guidance", () => {
	const directory = tempDir();
	try {
		const owner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
		assert.equal(owner.status, 0);
		const path = join(directory, "abandoned.json");
		const record = `${owner.stdout.trim()}:1:abc123`;
		writeFileSync(`${path}.lock`, record, "utf8");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${path}.lock`, old, old);
		assert.throws(
			() => withFileLocks([path], () => assert.fail("must not steal an abandoned lock")),
			/confirm no optimizer process is using it.*remove the lock file/i,
		);
		assert.equal(readFileSync(`${path}.lock`, "utf8"), record);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a stale malformed lock is preserved with actionable recovery guidance", () => {
	const directory = tempDir();
	try {
		const path = join(directory, "corrupt.json");
		writeFileSync(`${path}.lock`, "", "utf8");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${path}.lock`, old, old);
		assert.throws(
			() => withFileLocks([path], () => assert.fail("must fail closed on malformed lock")),
			/confirm no optimizer process is using it.*remove the lock file/i,
		);
		assert.equal(readFileSync(`${path}.lock`, "utf8"), "");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a published lock always contains a complete owner record", () => {
	const directory = tempDir();
	try {
		const path = join(directory, "complete.json");
		withFileLocks([path], () => {
			assert.match(readFileSync(`${path}.lock`, "utf8"), new RegExp(`^${process.pid}:\\d+:[a-f0-9]{24}$`));
		});
		assert.equal(existsSync(`${path}.lock`), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a process crash before writing the owner record never publishes an empty lock", () => {
	const directory = tempDir();
	try {
		const path = join(directory, "crash-before-owner.json");
		const persistenceUrl = pathToFileURL(join(process.cwd(), "src", "persistence.ts")).href;
		const childScript = [
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			`const persistence = await import(${JSON.stringify(persistenceUrl)});`,
			'fs.writeFileSync = () => process.exit(73);',
			"syncBuiltinESMExports();",
			`persistence.withFileLocks([${JSON.stringify(path)}], () => {});`,
		].join("\n");
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
			cwd: process.cwd(),
			encoding: "utf8",
			windowsHide: true,
		});
		assert.equal(child.status, 73, child.stderr);
		assert.equal(existsSync(`${path}.lock`), false, "the incomplete owner record must never be published");
		saveUsageDelta(path, { afterCrash: { count: 1, lastUsed: 1 } });
		assert.deepEqual(loadUsageFile(path), { afterCrash: { count: 1, lastUsed: 1 } });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("cross-process writers preserve every additive usage delta behind a start barrier", async () => {
	const directory = tempDir();
	const path = join(directory, "concurrent-usage.json");
	const gatePath = join(directory, "go");
	const persistenceUrl = pathToFileURL(join(process.cwd(), "src", "persistence.ts")).href;
	const workerCount = 3;
	const iterations = 10;
	const deadlineAt = Date.now() + 10_000;
	const children: ReturnType<typeof spawn>[] = [];
	const exits: Array<Promise<{ code: number | null; stderr: string }>> = [];
	try {
		for (let worker = 0; worker < workerCount; worker++) {
			const readyPath = join(directory, `ready-${worker}`);
			const script = [
				'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
				`const persistence = await import(${JSON.stringify(persistenceUrl)});`,
				`const path = ${JSON.stringify(path)};`,
				`const gatePath = ${JSON.stringify(gatePath)};`,
				`const workerId = ${worker};`,
				`writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
				"const wait = new Int32Array(new SharedArrayBuffer(4));",
				`const readyDeadlineAt = ${deadlineAt};`,
				"while (!existsSync(gatePath)) {",
				"if (Date.now() >= readyDeadlineAt) throw new Error(\"writer start barrier exceeded shared deadline\");",
				"Atomics.wait(wait, 0, 0, 10);",
				"}",
				"const deadlineAt = Number(readFileSync(gatePath, \"utf8\"));",
				"if (!Number.isSafeInteger(deadlineAt)) throw new Error(\"invalid shared deadline in writer barrier\");",
				`for (let i = 0; i < ${iterations}; i++) {`,
				"let retries = 0;",
				"while (true) {",
				"if (Date.now() >= deadlineAt) throw new Error(\"worker \" + workerId + \" exceeded shared deadline before update \" + i + \" (lock retries: \" + retries + \")\");",
				"try { persistence.saveUsageDelta(path, { shared: { count: 1, lastUsed: i + 1 } }); break; }",
				"catch (error) {",
				"if (!(error instanceof Error) || !error.message.startsWith(\"timed out waiting for file lock:\")) throw error;",
				"retries++;",
				"if (Date.now() >= deadlineAt) throw new Error(\"worker \" + workerId + \" exhausted shared deadline after lock retries: \" + error.message);",
				"Atomics.wait(wait, 0, 0, 5 + workerId * 5);",
				"}",
				"}",
				"}",
			].join("\n");
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: process.cwd(),
				windowsHide: true,
				stdio: ["ignore", "ignore", "pipe"],
			});
			children.push(child);
			exits.push(new Promise((resolve, reject) => {
				let stderr = "";
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
				child.once("error", reject);
				child.once("close", (code) => resolve({ code, stderr }));
			}));
		}
		waitUntil(
			() => Array.from({ length: workerCount }, (_, worker) => existsSync(join(directory, `ready-${worker}`))).every(Boolean),
			Math.max(1, deadlineAt - Date.now()),
		);
		writeFileSync(gatePath, String(deadlineAt));
		const outcomes = await Promise.all(exits);
		for (const [worker, outcome] of outcomes.entries()) {
			assert.equal(outcome.code, 0, `worker ${worker} exited ${outcome.code}; stderr:\n${outcome.stderr}`);
		}
		assert.deepEqual(loadUsageFile(path), { shared: { count: workerCount * iterations, lastUsed: iterations } });
	} finally {
		if (!existsSync(gatePath)) writeFileSync(gatePath, String(deadlineAt));
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill();
		}
		await Promise.allSettled(exits);
		rmSync(directory, { recursive: true, force: true });
	}
});

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

test("stored skill hashes preserve an own __proto__ key without mutating the prototype", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "profile.json");
		writeFileSync(path, '{"skillHashes":{"__proto__":"preserved","constructor":"ordinary"}}', "utf8");
		const hashes = readStoredProfile(path).hashes;
		assert.equal(Object.hasOwn(hashes, "__proto__"), true);
		assert.equal(hashes.__proto__, "preserved");
		assert.equal(hashes.constructor, "ordinary");
		assert.equal(Object.getPrototypeOf(hashes), Object.prototype);
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

test("provider cache deltas atomically migrate v2 stats to v3", () => {
	const dir = tempDir();
	try {
		const path = join(dir, "stats.json");
		writeFileSync(path, JSON.stringify({
			version: 2,
			updatedAt: "2024-01-01T00:00:00.000Z",
			lifetime: { skills: 10, tools: 2, output: 3 },
			extraction: { attempts: 2, accepted: 1, fallbackEvidence: 1, fallbackSavings: 0, fallbackError: 0 },
		}), "utf8");
		assert.deepEqual(loadProviderCacheTelemetryFile(path), { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalCost: 0 });
		saveProviderCacheTelemetryDelta(path, { requests: 1, input: 100, output: 20, cacheRead: 70, cacheWrite: 10, totalCost: 0.01 });
		saveProviderCacheTelemetryDelta(path, { requests: 1, input: 50, output: 5, cacheRead: 40, cacheWrite: 0, totalCost: 0.0025 });
		assert.deepEqual(loadStatsSnapshot(path), {
			savings: { skills: 10, tools: 2, output: 3 },
			extraction: { attempts: 2, accepted: 1, fallbackEvidence: 1, fallbackSavings: 0, fallbackError: 0 },
			cache: { requests: 2, input: 150, output: 25, cacheRead: 110, cacheWrite: 10, totalCost: 0.0125 },
		});
		assert.equal((JSON.parse(readFileSync(path, "utf8")) as { version: number }).version, 3);
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

test("temporary full output uses opaque SHA-256 content handles", () => {
	const dir = tempDir();
	try {
		const text = "first full output";
		const expected = `sko:${createHash("sha256").update(text).digest("base64url")}`;
		const first = saveTemporaryOutput(text, { directory: dir, now: 1_000 });
		const duplicate = saveTemporaryOutput(text, { directory: dir, now: 2_000 });
		const second = saveTemporaryOutput("second full output", { directory: dir, now: 2_000 });
		assert.equal(first, expected);
		assert.equal(duplicate, first);
		assert.ok(second);
		assert.notEqual(first, second);
		assert.match(first, /^sko:[A-Za-z0-9_-]{43}$/);
		assert.equal(first.includes(dir), false);
		assert.equal(resolveTemporaryOutput(first, { directory: dir, now: 2_500 }), text);
		assert.equal(resolveTemporaryOutput(second, { directory: dir, now: 2_500 }), "second full output");
		const files = readdirSync(dir).filter((name) => name.endsWith(".txt"));
		assert.equal(files.length, 2);
		if (process.platform !== "win32") {
			for (const file of files) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("temporary output resolution validates handles and cleanup honors TTL", () => {
	const dir = tempDir();
	try {
		const stale = saveTemporaryOutput("stale", { directory: dir, now: 1_000, ttlMs: 5_000 });
		const fresh = saveTemporaryOutput("fresh", { directory: dir, now: 9_000, ttlMs: 5_000 });
		assert.ok(stale);
		assert.ok(fresh);
		const unrelated = join(dir, "keep.me");
		writeFileSync(unrelated, "unrelated", "utf8");
		assert.equal(resolveTemporaryOutput("sko:../../secret", { directory: dir }), undefined);
		assert.equal(cleanupTemporaryOutputs({ directory: dir, now: 10_000, ttlMs: 5_000 }), 1);
		assert.equal(resolveTemporaryOutput(stale, { directory: dir, now: 10_000, ttlMs: 5_000 }), undefined);
		assert.equal(resolveTemporaryOutput(fresh, { directory: dir, now: 10_000, ttlMs: 5_000 }), "fresh");
		assert.equal(existsSync(unrelated), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("default archive lease is seven days and does not depend on the reader TTL", () => {
	const dir = tempDir();
	try {
		const savedAt = 1_000;
		const sevenDays = 7 * 24 * 60 * 60 * 1_000;
		assert.equal(DEFAULT_OUTPUT_ARCHIVE_TTL_MS, sevenDays);
		const id = saveTemporaryOutput("default lifetime", { directory: dir, now: savedAt });
		assert.ok(id);
		assert.equal(resolveTemporaryOutput(id, { directory: dir, now: savedAt + 6 * 24 * 60 * 60 * 1_000, ttlMs: 1 }), "default lifetime");
		assert.equal(resolveTemporaryOutput(id, { directory: dir, now: savedAt + 8 * 24 * 60 * 60 * 1_000, ttlMs: 30 * 24 * 60 * 60 * 1_000 }), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archive cleanup uses each archive lease instead of the current project's TTL", () => {
	const dir = tempDir();
	try {
		const longTtl = 7 * 24 * 60 * 60 * 1_000;
		const id = saveTemporaryOutput("long-lived output", { directory: dir, now: 1_000, ttlMs: longTtl });
		assert.ok(id);
		assert.equal(cleanupTemporaryOutputs({ directory: dir, now: 2 * 60 * 60 * 1_000, ttlMs: 60 * 60 * 1_000 }), 0);
		assert.equal(resolveTemporaryOutput(id, { directory: dir, now: 2 * 60 * 60 * 1_000, ttlMs: 60 * 60 * 1_000 }), "long-lived output");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("re-saving the same archive extends but never shortens its expiry", () => {
	const dir = tempDir();
	try {
		const first = saveTemporaryOutput("shared output", { directory: dir, now: 1_000, ttlMs: 10_000 });
		assert.ok(first);
		const shorter = saveTemporaryOutput("shared output", { directory: dir, now: 2_000, ttlMs: 1_000 });
		assert.equal(shorter, first);
		assert.equal(resolveTemporaryOutput(first, { directory: dir, now: 5_000, ttlMs: 1_000 }), "shared output");

		const extended = saveTemporaryOutput("shared output", { directory: dir, now: 6_000, ttlMs: 20_000 });
		assert.equal(extended, first);
		assert.equal(resolveTemporaryOutput(first, { directory: dir, now: 25_000, ttlMs: 1_000 }), "shared output");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archives fail open for lone UTF-16 surrogates while preserving valid emoji", () => {
	const dir = tempDir();
	try {
		for (const malformed of ["\uD800", "\uDC00", "before\uD800after", "before\uDC00after"]) {
			assert.equal(saveTemporaryOutput(malformed, { directory: dir }), undefined);
		}
		const valid = "before🙂after";
		const id = saveTemporaryOutput(valid, { directory: dir });
		assert.ok(id);
		assert.equal(resolveTemporaryOutput(id, { directory: dir }), valid);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy archives use a fixed seven-day fallback independent of the reader TTL", () => {
	const dir = tempDir();
	try {
		const savedAt = 1_000;
		const id = saveTemporaryOutput("legacy output", { directory: dir, now: savedAt });
		assert.ok(id);
		const digest = id.slice("sko:".length);
		unlinkSync(join(dir, `${digest}.meta.json`));

		assert.equal(resolveTemporaryOutput(id, { directory: dir, now: savedAt + 6 * 24 * 60 * 60 * 1_000, ttlMs: 1 }), "legacy output");
		assert.equal(resolveTemporaryOutput(id, { directory: dir, now: savedAt + 8 * 24 * 60 * 60 * 1_000, ttlMs: 30 * 24 * 60 * 60 * 1_000 }), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("corrupt archive expiry metadata fails closed without deleting the archive", () => {
	const dir = tempDir();
	try {
		const id = saveTemporaryOutput("archive with bad metadata", { directory: dir, now: 1_000 });
		assert.ok(id);
		const digest = id.slice("sko:".length);
		const metadata = join(dir, `${digest}.meta.json`);
		writeFileSync(metadata, "{broken", "utf8");

		assert.equal(resolveTemporaryOutput(id, { directory: dir, now: 2_000 }), undefined);
		assert.equal(cleanupTemporaryOutputs({ directory: dir, now: 10_000_000_000 }), 0);
		assert.equal(existsSync(join(dir, `${digest}.txt`)), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
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
