import assert from "node:assert/strict";
import { test } from "node:test";
import { addSavings, EMPTY_SAVINGS, normalizeStatsFile, toStatsFile, totalSavings } from "../src/stats.ts";

test("normalizeStatsFile reads lifetime, tolerates a bare object, drops junk", () => {
	assert.deepEqual(normalizeStatsFile({ lifetime: { skills: 100, tools: 50, output: 25 } }), { skills: 100, tools: 50, output: 25 });
	assert.deepEqual(normalizeStatsFile({ skills: 5, tools: 0, output: 3 }), { skills: 5, tools: 0, output: 3 });
	assert.deepEqual(normalizeStatsFile({ lifetime: { skills: -1, tools: "x", output: 2.9 } }), { skills: 0, tools: 0, output: 2 });
	assert.deepEqual(normalizeStatsFile(undefined), EMPTY_SAVINGS);
});

test("addSavings and totalSavings accumulate per area", () => {
	const a = { skills: 10, tools: 4, output: 6 };
	const b = { skills: 1, tools: 2, output: 3 };
	assert.deepEqual(addSavings(a, b), { skills: 11, tools: 6, output: 9 });
	assert.equal(totalSavings(a), 20);
});

test("toStatsFile round-trips through normalizeStatsFile", () => {
	const lifetime = { skills: 12345, tools: 678, output: 90 };
	const file = toStatsFile(lifetime, 1_700_000_000_000);
	assert.equal(file.version, 1);
	assert.deepEqual(normalizeStatsFile(file), lifetime);
});
