/**
 * Synchronous persistence primitives for the extension runtime.
 *
 * Writes are atomic per file and serialized with an ownership-token lock.
 * Profile writes additionally use optimistic revisions so an init computed from
 * a stale snapshot cannot replace a newer profile. Usage and telemetry writes
 * merge process-local deltas into the latest snapshot while holding the lock.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	lstatSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EMPTY_PROFILE, mergeProfiles, normalizeProfile, type SkillOptimizerProfile } from "./profile.ts";
import { addExtractionTelemetry, addProviderCacheTelemetry, addSavings, EMPTY_EXTRACTION_TELEMETRY, EMPTY_PROVIDER_CACHE_TELEMETRY, EMPTY_SAVINGS, normalizeExtractionTelemetry, normalizeProviderCacheTelemetry, normalizeStatsFile, toStatsFile, type ExtractionTelemetry, type ProviderCacheTelemetry, type SavingsByArea } from "./stats.ts";
import { mergeUsageStats, normalizeUsageFile, pruneUsageStats, toUsageFile, type SkillUsageStats, type UsagePruneOptions } from "./usage.ts";

const LOCK_WAIT_MS = 250;
const LOCK_STALE_MS = 30_000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

const OUTPUT_ARCHIVE_ID_PREFIX = "sko:";
const OUTPUT_ARCHIVE_DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const OUTPUT_ARCHIVE_FILE_RE = /^([A-Za-z0-9_-]{43})\.txt$/;
const DEFAULT_OUTPUT_ARCHIVE_DIR = join(tmpdir(), "pi-skill-optimizer", "outputs");
export const DEFAULT_OUTPUT_ARCHIVE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface TemporaryOutputArchiveOptions {
	/** Internal storage root. IDs never contain this path. */
	directory?: string;
	/** Clock override for deterministic cleanup and tests. */
	now?: number;
	/** Archive lifetime. Defaults to 24 hours. */
	ttlMs?: number;
}

export interface StoredProfile {
	exists: boolean;
	profile: SkillOptimizerProfile;
	hashes: Record<string, string>;
	initVersion: number;
	revision: string | null;
}

export interface ProfileWrite {
	path: string;
	profile: SkillOptimizerProfile;
	skillCount: number;
	hashes: Record<string, string>;
	expectedRevision: string | null;
}

export class ConcurrentFileUpdateError extends Error {
	constructor(path: string) {
		super(`file changed while preparing update: ${path}`);
		this.name = "ConcurrentFileUpdateError";
	}
}

export function fileExists(path: string): boolean {
	return existsSync(path);
}

function revision(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readText(path: string): { text: string; revision: string } | undefined {
	try {
		const text = readFileSync(path, "utf8");
		return { text, revision: revision(text) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

function readJson(path: string): unknown | undefined {
	const stored = readText(path);
	return stored ? JSON.parse(stored.text) : undefined;
}

/** Replace a JSON file atomically. Callers coordinate conflicting writers. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = join(dirname(path), `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* best effort */ }
		}
		try { unlinkSync(temp); } catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") { /* best effort */ }
		}
	}
}

function acquireLock(path: string): { lockPath: string; token: string } {
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx", 0o600);
			writeFileSync(fd, token, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			return { lockPath, token };
		} catch (err) {
			if (fd !== undefined) {
				try { closeSync(fd); } catch { /* best effort */ }
				try { unlinkSync(lockPath); } catch { /* best effort */ }
			}
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
			} catch {
				// Another process may have released or replaced it.
			}
			if (Date.now() >= deadline) throw new Error(`timed out waiting for file lock: ${lockPath}`);
			Atomics.wait(LOCK_SLEEP, 0, 0, 10);
		}
	}
}

function releaseLock(lock: { lockPath: string; token: string }): void {
	try {
		if (readFileSync(lock.lockPath, "utf8") === lock.token) unlinkSync(lock.lockPath);
	} catch {
		// A stale-lock recovery may already have replaced or removed it.
	}
}

/** Acquire multiple locks in stable order to avoid cross-process deadlocks. */
export function withFileLocks<T>(paths: readonly string[], action: () => T): T {
	const locks: Array<{ lockPath: string; token: string }> = [];
	try {
		for (const path of [...new Set(paths)].sort()) locks.push(acquireLock(path));
		return action();
	} finally {
		for (let i = locks.length - 1; i >= 0; i--) releaseLock(locks[i]);
	}
}

function sanitizeHashes(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [name, hash] of Object.entries(value as Record<string, unknown>)) {
		if (typeof hash === "string" && hash) out[name] = hash;
	}
	return out;
}

export function readStoredProfile(path: string): StoredProfile {
	const stored = readText(path);
	if (!stored) return { exists: false, profile: EMPTY_PROFILE, hashes: {}, initVersion: 0, revision: null };
	const parsed = JSON.parse(stored.text) as unknown;
	const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? parsed as { skillHashes?: unknown; initVersion?: unknown }
		: {};
	return {
		exists: true,
		profile: normalizeProfile(parsed),
		hashes: sanitizeHashes(raw.skillHashes),
		initVersion: typeof raw.initVersion === "number" ? raw.initVersion : 0,
		revision: stored.revision,
	};
}

export function loadMergedProfile(paths: { global: string; project: string }): SkillOptimizerProfile {
	const globalProfile = readStoredProfile(paths.global).profile;
	if (paths.project === paths.global) return globalProfile;
	return mergeProfiles(globalProfile, readStoredProfile(paths.project).profile);
}

/** Commit one or more profile files after verifying every source revision. */
export function writeProfileFiles(writes: readonly ProfileWrite[], initVersion: number, now = Date.now()): void {
	if (writes.length === 0) return;
	const paths = writes.map((write) => write.path);
	if (new Set(paths).size !== paths.length) throw new Error("duplicate path in profile write set");
	withFileLocks(paths, () => {
		for (const write of writes) {
			const currentRevision = readText(write.path)?.revision ?? null;
			if (currentRevision !== write.expectedRevision) throw new ConcurrentFileUpdateError(write.path);
		}
		const generatedAt = new Date(now).toISOString();
		for (const write of writes) {
			writeJsonAtomic(write.path, {
				version: 2,
				initVersion,
				generatedAt,
				skillCount: write.skillCount,
				...write.profile,
				skillHashes: write.hashes,
			});
		}
	});
}

export function loadUsageFile(path: string): SkillUsageStats {
	const parsed = readJson(path);
	return parsed === undefined ? {} : normalizeUsageFile(parsed);
}

export function saveUsageDelta(path: string, delta: SkillUsageStats, pruneOptions?: UsagePruneOptions): SkillUsageStats {
	return withFileLocks([path], () => {
		const merged = mergeUsageStats(loadUsageFile(path), delta);
		const next = pruneOptions ? pruneUsageStats(merged, pruneOptions) : merged;
		writeJsonAtomic(path, toUsageFile(next));
		return next;
	});
}

export function pruneUsageFile(path: string, options: UsagePruneOptions): SkillUsageStats {
	return withFileLocks([path], () => {
		const current = loadUsageFile(path);
		const pruned = pruneUsageStats(current, options);
		if (pruned !== current) writeJsonAtomic(path, toUsageFile(pruned));
		return pruned;
	});
}

export function loadStatsFile(path: string): SavingsByArea {
	const parsed = readJson(path);
	return parsed === undefined ? { ...EMPTY_SAVINGS } : normalizeStatsFile(parsed);
}

export function loadExtractionTelemetryFile(path: string): ExtractionTelemetry {
	const parsed = readJson(path);
	return parsed === undefined ? { ...EMPTY_EXTRACTION_TELEMETRY } : normalizeExtractionTelemetry(parsed);
}

export function loadProviderCacheTelemetryFile(path: string): ProviderCacheTelemetry {
	const parsed = readJson(path);
	return parsed === undefined ? { ...EMPTY_PROVIDER_CACHE_TELEMETRY } : normalizeProviderCacheTelemetry(parsed);
}

export interface SavedStats {
	savings: SavingsByArea;
	extraction: ExtractionTelemetry;
	cache: ProviderCacheTelemetry;
}

/** Load all v1-v3 statistics with a single read, suitable for runtime snapshots. */
export function loadStatsSnapshot(path: string): SavedStats {
	const parsed = readJson(path);
	if (parsed === undefined) {
		return {
			savings: { ...EMPTY_SAVINGS },
			extraction: { ...EMPTY_EXTRACTION_TELEMETRY },
			cache: { ...EMPTY_PROVIDER_CACHE_TELEMETRY },
		};
	}
	return {
		savings: normalizeStatsFile(parsed),
		extraction: normalizeExtractionTelemetry(parsed),
		cache: normalizeProviderCacheTelemetry(parsed),
	};
}

export function saveStatsDeltas(
	path: string,
	savingsDelta: SavingsByArea,
	extractionDelta: ExtractionTelemetry,
	cacheDelta: ProviderCacheTelemetry = EMPTY_PROVIDER_CACHE_TELEMETRY,
): SavedStats {
	return withFileLocks([path], () => {
		const parsed = readJson(path);
		const savings = addSavings(parsed === undefined ? { ...EMPTY_SAVINGS } : normalizeStatsFile(parsed), savingsDelta);
		const extraction = addExtractionTelemetry(
			parsed === undefined ? { ...EMPTY_EXTRACTION_TELEMETRY } : normalizeExtractionTelemetry(parsed),
			extractionDelta,
		);
		const cache = addProviderCacheTelemetry(
			parsed === undefined ? { ...EMPTY_PROVIDER_CACHE_TELEMETRY } : normalizeProviderCacheTelemetry(parsed),
			cacheDelta,
		);
		writeJsonAtomic(path, toStatsFile(savings, Date.now(), extraction, cache));
		return { savings, extraction, cache };
	});
}

export function saveStatsDelta(path: string, delta: SavingsByArea): SavingsByArea {
	return saveStatsDeltas(path, delta, EMPTY_EXTRACTION_TELEMETRY).savings;
}

/** Atomically merge one authoritative `message_end` usage delta into stats v3. */
export function saveProviderCacheTelemetryDelta(path: string, delta: ProviderCacheTelemetry): ProviderCacheTelemetry {
	return saveStatsDeltas(path, EMPTY_SAVINGS, EMPTY_EXTRACTION_TELEMETRY, delta).cache;
}

function archiveDirectory(options: TemporaryOutputArchiveOptions): string {
	return options.directory ?? DEFAULT_OUTPUT_ARCHIVE_DIR;
}

function archiveNow(options: TemporaryOutputArchiveOptions): number {
	return typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
}

function archiveTtl(options: TemporaryOutputArchiveOptions): number {
	return typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs >= 0
		? options.ttlMs
		: DEFAULT_OUTPUT_ARCHIVE_TTL_MS;
}

function outputDigest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("base64url");
}

function digestFromArchiveId(id: string): string | undefined {
	if (!id.startsWith(OUTPUT_ARCHIVE_ID_PREFIX)) return undefined;
	const digest = id.slice(OUTPUT_ARCHIVE_ID_PREFIX.length);
	return OUTPUT_ARCHIVE_DIGEST_RE.test(digest) ? digest : undefined;
}

function outputArchivePath(directory: string, digest: string): string {
	return join(directory, `${digest}.txt`);
}

/**
 * Archive a full tool output and return a provider-safe content-addressed handle.
 * The handle contains only a SHA-256 digest, never a local path. Saving identical
 * content returns the same handle and refreshes its TTL.
 */
export function saveTemporaryOutput(text: string, options: TemporaryOutputArchiveOptions = {}): string | undefined {
	const directory = archiveDirectory(options);
	const now = archiveNow(options);
	const digest = outputDigest(text);
	const id = `${OUTPUT_ARCHIVE_ID_PREFIX}${digest}`;
	const path = outputArchivePath(directory, digest);
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		try {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink()) return undefined;
			const stored = readFileSync(path);
			if (outputDigest(stored) === digest) {
				const timestamp = new Date(now);
				utimesSync(path, timestamp, timestamp);
				return id;
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}

		const temp = join(directory, `.${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
		let fd: number | undefined;
		try {
			fd = openSync(temp, "wx", 0o600);
			writeFileSync(fd, text, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(temp, path);
			const timestamp = new Date(now);
			utimesSync(path, timestamp, timestamp);
			return id;
		} finally {
			if (fd !== undefined) {
				try { closeSync(fd); } catch { /* best effort */ }
			}
			try { unlinkSync(temp); } catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") { /* best effort */ }
			}
		}
	} catch {
		return undefined;
	}
}

/** Resolve an opaque archive handle to verified text, or undefined if invalid/expired. */
export function resolveTemporaryOutput(id: string, options: TemporaryOutputArchiveOptions = {}): string | undefined {
	const digest = digestFromArchiveId(id);
	if (!digest) return undefined;
	const path = outputArchivePath(archiveDirectory(options), digest);
	try {
		const info = lstatSync(path);
		if (!info.isFile() || info.isSymbolicLink()) return undefined;
		if (archiveNow(options) - info.mtimeMs > archiveTtl(options)) {
			try { unlinkSync(path); } catch { /* best effort */ }
			return undefined;
		}
		const stored = readFileSync(path);
		if (outputDigest(stored) !== digest) return undefined;
		return stored.toString("utf8");
	} catch {
		return undefined;
	}
}

/** Remove only recognized content archives older than the configured TTL. */
export function cleanupTemporaryOutputs(options: TemporaryOutputArchiveOptions = {}): number {
	const directory = archiveDirectory(options);
	const now = archiveNow(options);
	const ttl = archiveTtl(options);
	let removed = 0;
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (typeof entry === "string" || !entry.isFile() || !OUTPUT_ARCHIVE_FILE_RE.test(entry.name)) continue;
		const path = join(directory, entry.name);
		try {
			if (now - statSync(path).mtimeMs <= ttl) continue;
			unlinkSync(path);
			removed += 1;
		} catch {
			// Concurrent resolution or cleanup is harmless.
		}
	}
	return removed;
}
