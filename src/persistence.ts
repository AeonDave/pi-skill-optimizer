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
const LEGACY_OUTPUT_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const OUTPUT_ARCHIVE_METADATA_VERSION = 1;
export const DEFAULT_OUTPUT_ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface TemporaryOutputArchiveOptions {
	/** Internal storage root. IDs never contain this path. */
	directory?: string;
	/** Clock override for deterministic cleanup and tests. */
	now?: number;
	/** Requested lifetime when saving; each archive stores its own expiry. Defaults to seven days. */
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

function recoverAbandonedLock(lockPath: string): void {
	const info = lstatSync(lockPath);
	if (!info.isFile() || info.isSymbolicLink() || Date.now() - info.mtimeMs <= LOCK_STALE_MS) return;
	const token = readFileSync(lockPath, "utf8");
	const pidText = /^(\d+):\d+:[a-z0-9]+$/.exec(token)?.[1];
	const ownerPid = Number(pidText);
	if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return;
	try {
		// Signal 0 probes liveness; it does not terminate the owner. EPERM is not death.
		process.kill(ownerPid, 0);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
	}
	// Another process may already have recovered and replaced the lock.
	if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath);
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
				recoverAbandonedLock(lockPath);
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

function hasWellFormedUtf16(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function digestFromArchiveId(id: string): string | undefined {
	if (!id.startsWith(OUTPUT_ARCHIVE_ID_PREFIX)) return undefined;
	const digest = id.slice(OUTPUT_ARCHIVE_ID_PREFIX.length);
	return OUTPUT_ARCHIVE_DIGEST_RE.test(digest) ? digest : undefined;
}

function outputArchivePath(directory: string, digest: string): string {
	return join(directory, `${digest}.txt`);
}

function outputArchiveMetadataPath(directory: string, digest: string): string {
	return join(directory, `${digest}.meta.json`);
}

interface ArchiveExpiry {
	valid: boolean;
	expiresAt: number;
}

/** A missing sidecar is a legacy archive and receives a fixed seven-day lease. */
function readArchiveExpiry(metadataPath: string, legacyMtimeMs?: number): ArchiveExpiry {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(metadataPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				valid: true,
				expiresAt: legacyMtimeMs === undefined ? Number.NEGATIVE_INFINITY : legacyMtimeMs + LEGACY_OUTPUT_ARCHIVE_TTL_MS,
			};
		}
		return { valid: false, expiresAt: 0 };
	}
	if (!info.isFile() || info.isSymbolicLink()) return { valid: false, expiresAt: 0 };
	let parsed: unknown;
	try { parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown; }
	catch { return { valid: false, expiresAt: 0 }; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { valid: false, expiresAt: 0 };
	const metadata = parsed as { version?: unknown; expiresAt?: unknown };
	if (metadata.version !== OUTPUT_ARCHIVE_METADATA_VERSION
		|| typeof metadata.expiresAt !== "number"
		|| !Number.isFinite(metadata.expiresAt)) return { valid: false, expiresAt: 0 };
	return { valid: true, expiresAt: metadata.expiresAt };
}

function writeOutputArchive(path: string, directory: string, text: string, digest: string, now: number): boolean {
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
		const info = lstatSync(path);
		return info.isFile() && !info.isSymbolicLink() && outputDigest(readFileSync(path)) === digest;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* best effort */ }
		}
		try { unlinkSync(temp); } catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") { /* best effort */ }
		}
	}
}

/**
 * Archive a full tool output and return a provider-safe content-addressed handle.
 * The handle contains only a SHA-256 digest, never a local path. Saving identical
 * content returns the same handle and refreshes its TTL.
 */
export function saveTemporaryOutput(text: string, options: TemporaryOutputArchiveOptions = {}): string | undefined {
	if (!hasWellFormedUtf16(text)) return undefined;
	const directory = archiveDirectory(options);
	const now = archiveNow(options);
	const digest = outputDigest(text);
	const id = `${OUTPUT_ARCHIVE_ID_PREFIX}${digest}`;
	const path = outputArchivePath(directory, digest);
	const metadataPath = outputArchiveMetadataPath(directory, digest);
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		return withFileLocks([metadataPath], () => {
			let info: ReturnType<typeof lstatSync>;
			let existing = true;
			try {
				info = lstatSync(path);
				if (!info.isFile() || info.isSymbolicLink() || outputDigest(readFileSync(path)) !== digest) return undefined;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
				existing = false;
				if (!writeOutputArchive(path, directory, text, digest, now)) return undefined;
				info = lstatSync(path);
			}

			const previous = readArchiveExpiry(metadataPath, existing ? info.mtimeMs : undefined);
			if (!previous.valid) return undefined;
			const expiresAt = Math.max(previous.expiresAt, now + archiveTtl(options));
			writeJsonAtomic(metadataPath, { version: OUTPUT_ARCHIVE_METADATA_VERSION, expiresAt });
			return id;
		});
	} catch {
		return undefined;
	}
}

/** Resolve an opaque archive handle using its stored expiry and verified content digest. */
export function resolveTemporaryOutput(id: string, options: TemporaryOutputArchiveOptions = {}): string | undefined {
	const digest = digestFromArchiveId(id);
	if (!digest) return undefined;
	const directory = archiveDirectory(options);
	const path = outputArchivePath(directory, digest);
	const metadataPath = outputArchiveMetadataPath(directory, digest);
	try {
		return withFileLocks([metadataPath], () => {
			const info = lstatSync(path);
			if (!info.isFile() || info.isSymbolicLink()) return undefined;
			const expiry = readArchiveExpiry(metadataPath, info.mtimeMs);
			if (!expiry.valid) return undefined;
			if (archiveNow(options) > expiry.expiresAt) {
				try { unlinkSync(path); } catch { /* best effort */ }
				try { unlinkSync(metadataPath); } catch { /* best effort */ }
				return undefined;
			}
			const stored = readFileSync(path);
			if (outputDigest(stored) !== digest) return undefined;
			return stored.toString("utf8");
		});
	} catch {
		return undefined;
	}
}

/** Remove only recognized content archives whose stored or legacy expiry passed. */
export function cleanupTemporaryOutputs(options: TemporaryOutputArchiveOptions = {}): number {
	const directory = archiveDirectory(options);
	const now = archiveNow(options);
	let removed = 0;
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (typeof entry === "string" || !entry.isFile()) continue;
		const match = OUTPUT_ARCHIVE_FILE_RE.exec(entry.name);
		if (!match) continue;
		const digest = match[1];
		const path = join(directory, entry.name);
		const metadataPath = outputArchiveMetadataPath(directory, digest);
		try {
			const deleted = withFileLocks([metadataPath], () => {
				const info = lstatSync(path);
				if (!info.isFile() || info.isSymbolicLink()) return false;
				const expiry = readArchiveExpiry(metadataPath, info.mtimeMs);
				if (!expiry.valid || now <= expiry.expiresAt) return false;
				unlinkSync(path);
				try { unlinkSync(metadataPath); } catch { /* best effort */ }
				return true;
			});
			if (deleted) removed += 1;
		} catch {
			// Concurrent resolution or cleanup is harmless.
		}
	}
	return removed;
}
