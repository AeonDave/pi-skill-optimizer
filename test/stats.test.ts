import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addExtractionTelemetry,
	addProviderCacheTelemetry,
	addSavings,
	EMPTY_EXTRACTION_TELEMETRY,
	EMPTY_PROVIDER_CACHE_TELEMETRY,
	EMPTY_SAVINGS,
	normalizeExtractionTelemetry,
	normalizeProviderCacheTelemetry,
	normalizeStatsFile,
	subtractExtractionTelemetry,
	subtractProviderCacheTelemetry,
	subtractSavings,
	toStatsFile,
	totalSavings,
} from "../src/stats.ts";

test("normalizeStatsFile migrates v1 and bare savings objects", () => {
	assert.deepEqual(normalizeStatsFile({ lifetime: { skills: 100, tools: 50, output: 25 } }), { skills: 100, tools: 50, output: 25 });
	assert.deepEqual(normalizeStatsFile({ skills: 5, tools: 0, output: 3 }), { skills: 5, tools: 0, output: 3 });
	assert.deepEqual(normalizeStatsFile({ lifetime: { skills: -1, tools: "x", output: 2.9 } }), { skills: 0, tools: 0, output: 2 });
	assert.deepEqual(normalizeStatsFile(undefined), EMPTY_SAVINGS);
	assert.deepEqual(normalizeExtractionTelemetry({ lifetime: { skills: 1 } }), EMPTY_EXTRACTION_TELEMETRY);
});

test("savings arithmetic remains character-only", () => {
	const first = { skills: 10, tools: 4, output: 6 };
	const second = { skills: 1, tools: 2, output: 3 };
	assert.deepEqual(addSavings(first, second), { skills: 11, tools: 6, output: 9 });
	assert.equal(totalSavings(first), 20);
	assert.deepEqual(subtractSavings({ skills: 12, tools: 3, output: 1 }, { skills: 10, tools: 8, output: 1 }), { skills: 2, tools: 0, output: 0 });
});

test("extraction telemetry accumulates and subtracts independently", () => {
	const first = { attempts: 3, accepted: 1, fallbackEvidence: 1, fallbackSavings: 0, fallbackError: 1 };
	const second = { attempts: 2, accepted: 1, fallbackEvidence: 0, fallbackSavings: 1, fallbackError: 0 };
	const sum = addExtractionTelemetry(first, second);
	assert.deepEqual(sum, { attempts: 5, accepted: 2, fallbackEvidence: 1, fallbackSavings: 1, fallbackError: 1 });
	assert.deepEqual(subtractExtractionTelemetry(sum, second), first);
});

test("v3 stats file round-trips savings, extraction, and authoritative cache telemetry", () => {
	const lifetime = { skills: 12_345, tools: 678, output: 90 };
	const extraction = { attempts: 8, accepted: 3, fallbackEvidence: 2, fallbackSavings: 1, fallbackError: 2 };
	const cache = { requests: 4, input: 1_000, output: 80, cacheRead: 700, cacheWrite: 200, totalCost: 0.0123 };
	const file = toStatsFile(lifetime, 1_700_000_000_000, extraction, cache);
	assert.equal(file.version, 3);
	assert.deepEqual(normalizeStatsFile(file), lifetime);
	assert.deepEqual(normalizeExtractionTelemetry(file), extraction);
	assert.deepEqual(normalizeProviderCacheTelemetry(file), cache);
});

test("provider cache telemetry migrates v2 as empty and merges additively", () => {
	const v2 = {
		version: 2,
		lifetime: { skills: 1, tools: 2, output: 3 },
		extraction: { attempts: 1, accepted: 1, fallbackEvidence: 0, fallbackSavings: 0, fallbackError: 0 },
	};
	assert.deepEqual(normalizeProviderCacheTelemetry(v2), EMPTY_PROVIDER_CACHE_TELEMETRY);
	const first = { requests: 2, input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalCost: 0.01 };
	const second = { requests: 1, input: 50, output: 5, cacheRead: 40, cacheWrite: 0, totalCost: 0.0025 };
	const sum = addProviderCacheTelemetry(first, second);
	assert.deepEqual(sum, { requests: 3, input: 150, output: 25, cacheRead: 100, cacheWrite: 10, totalCost: 0.0125 });
	assert.deepEqual(subtractProviderCacheTelemetry(sum, second), first);
	assert.deepEqual(normalizeProviderCacheTelemetry({ cache: { requests: 2.9, input: -1, output: 4.8, cacheRead: "x", cacheWrite: 3, totalCost: 0.0042 } }), {
		requests: 2,
		input: 0,
		output: 4,
		cacheRead: 0,
		cacheWrite: 3,
		totalCost: 0.0042,
	});
});
