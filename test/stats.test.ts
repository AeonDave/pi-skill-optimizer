import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addExtractionTelemetry,
	addSavings,
	EMPTY_EXTRACTION_TELEMETRY,
	EMPTY_SAVINGS,
	normalizeExtractionTelemetry,
	normalizeStatsFile,
	subtractExtractionTelemetry,
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

test("v2 stats file round-trips savings and extraction telemetry", () => {
	const lifetime = { skills: 12_345, tools: 678, output: 90 };
	const extraction = { attempts: 8, accepted: 3, fallbackEvidence: 2, fallbackSavings: 1, fallbackError: 2 };
	const file = toStatsFile(lifetime, 1_700_000_000_000, extraction);
	assert.equal(file.version, 2);
	assert.deepEqual(normalizeStatsFile(file), lifetime);
	assert.deepEqual(normalizeExtractionTelemetry(file), extraction);
});
