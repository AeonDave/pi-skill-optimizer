/**
 * Measure baseline versus auto stable-base and eager-prefetch request surfaces.
 *
 *   node --import tsx scripts/measure.ts <path-to-captured-request.json>
 */

import { readFileSync } from "node:fs";
import { extractRequestQuery, normalizeRequest } from "../src/request.ts";
import { optimizeSkillCatalog, renderSkillPrefetch } from "../src/skills.ts";

type JsonObject = Record<string, unknown>;

interface SurfacePair {
	base: unknown;
	eager: unknown;
}

interface Measurement {
	label: string;
	serialized: string;
	chars: number;
	bytes: number;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestBody(value: unknown): JsonObject {
	let candidate = isObject(value) && "body" in value ? value.body : value;
	if (typeof candidate === "string") candidate = JSON.parse(candidate) as unknown;
	if (!isObject(candidate)) throw new Error("capture must contain a provider request object or { body: ... }");
	return candidate;
}

function joinBaseAndOverlay(base: string, overlay: string): string {
	return overlay.trim() ? `${base}\n\n${overlay}` : base;
}

const capturePath = process.argv[2];
if (!capturePath) {
	console.error("usage: node --import tsx scripts/measure.ts <path-to-captured-request.json>");
	process.exit(2);
}

const body = requestBody(JSON.parse(readFileSync(capturePath, "utf8")) as unknown);
const query = extractRequestQuery(normalizeRequest(body));
const selectedNames = new Set<string>();
const baseFingerprints = new Set<string>();
let catalogCount = 0;

function transform(value: unknown): SurfacePair {
	if (typeof value === "string") {
		if (!value.includes("<available_skills>")) return { base: value, eager: value };
		const result = optimizeSkillCatalog(value, query);
		const overlay = renderSkillPrefetch(result.plan);
		catalogCount += 1;
		baseFingerprints.add(result.fingerprint);
		for (const name of result.plan.selectedNames) selectedNames.add(name);
		return { base: result.text, eager: joinBaseAndOverlay(result.text, overlay) };
	}
	if (Array.isArray(value)) {
		const entries = value.map(transform);
		return {
			base: entries.map((entry) => entry.base),
			eager: entries.map((entry) => entry.eager),
		};
	}
	if (!isObject(value)) return { base: value, eager: value };
	const base: JsonObject = {};
	const eager: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		const pair = transform(child);
		base[key] = pair.base;
		eager[key] = pair.eager;
	}
	return { base, eager };
}

function measure(label: string, value: unknown): Measurement {
	const serialized = JSON.stringify(value);
	return {
		label,
		serialized,
		chars: serialized.length,
		bytes: new TextEncoder().encode(serialized).byteLength,
	};
}

const surfaces = transform(body);
const measurements = [
	measure("baseline/request", body),
	measure("auto/base-cache", surfaces.base),
	measure("auto/eager-prefetch", surfaces.eager),
];
const baseline = measurements[0];
const estimateTokens = (bytes: number): number => Math.round(bytes / 4);
const percentSaved = (bytes: number): string => baseline.bytes > 0
	? `${Math.round((100 * (baseline.bytes - bytes)) / baseline.bytes)}%`
	: "0%";

console.log(`\ncaptured provider request: ${baseline.bytes} UTF-8 bytes (~${estimateTokens(baseline.bytes)} estimated tokens)`);
console.log(`catalog surfaces: ${catalogCount}; stable fingerprints: ${baseFingerprints.size}; eager prefetches: ${selectedNames.size}\n`);
console.log("arm/surface          | UTF-8 bytes | est tokens | bytes saved | saved");
console.log("---------------------|-------------|------------|-------------|------");
for (const entry of measurements) {
	console.log(
		`${entry.label.padEnd(20)} | ${String(entry.bytes).padStart(11)} | ${String(estimateTokens(entry.bytes)).padStart(10)} | ${String(baseline.bytes - entry.bytes).padStart(11)} | ${percentSaved(entry.bytes).padStart(5)}`,
	);
}

if (catalogCount === 0) console.log("\nNo <available_skills> catalog was found; all surfaces are identical.");
if (selectedNames.size > 0) console.log(`\nEager prefetch: ${[...selectedNames].join(", ")}`);
console.log("\nTool definitions are unchanged; dynamic tool discovery is measured separately.");
