import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, getOutputConfig } from "../src/config.ts";
import { reduceToolOutput, type OutputExtraction } from "../src/output-pipeline.ts";
import { EMPTY_PROVIDER_CACHE_TELEMETRY } from "../src/stats.ts";

const config = { ...getOutputConfig({ ...DEFAULT_CONFIG }), mode: "extract" as const,
	model: "test/extract", extractMinBytes: 0, maxLines: 4, maxBytes: 256,
	minSavingsBytes: 1, minSavingsRatio: 0 };
const text = Array.from({ length: 200 }, (_, i) => `ordinary source row ${i}: retain the original record`).join("\n");
const handle = `sko:${"a".repeat(43)}`;

function ports(extract: () => Promise<OutputExtraction | undefined>) {
	const archived: string[] = [];
	return {
		command: "build", signal: new AbortController().signal, extract, archived,
		archive(original: string) { archived.push(original); return handle; },
	};
}

test("small and disabled results perform no extraction or archive work", async () => {
	const io = ports(async () => assert.fail("unexpected extraction"));
	assert.deepEqual(await reduceToolOutput("small", config, io), { text: "small", removedChars: 0 });
	assert.deepEqual(await reduceToolOutput(text, { ...config, mode: "off" }, io), { text, removedChars: 0 });
	assert.equal(io.archived.length, 0);
});

test("lossless columnar output takes precedence over model extraction", async () => {
	const original = JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ identifier: id, status: "pending", owner: "service" })));
	const io = ports(async () => assert.fail("columnar data needs no extraction"));
	const result = await reduceToolOutput(original, config, io);
	assert.match(result.text, /skill-optimizer:columnar/);
	assert.equal(result.extractionOutcome, undefined);
	assert.deepEqual(io.archived, [original]);
});

test("validated extraction preserves provider usage and archives the complete original", async () => {
	const telemetry = { ...EMPTY_PROVIDER_CACHE_TELEMETRY, requests: 1, input: 500 };
	const io = ports(async () => ({ text: text.split("\n")[0], telemetry }));
	const result = await reduceToolOutput(text, config, io);
	assert.equal(result.extractionOutcome, "accepted");
	assert.deepEqual(result.providerUsage, telemetry);
	assert.match(result.text, /skill-optimizer:extract/);
	assert.deepEqual(io.archived, [text]);
	assert.equal(result.removedChars, text.length - result.text.length);
});

test("unavailable or invalid extraction uses the same smart fallback", async () => {
	const unavailable = await reduceToolOutput(text, config, ports(async () => undefined));
	const invalid = await reduceToolOutput(text, config, ports(async () => ({
		text: "invented content outside the source", telemetry: { ...EMPTY_PROVIDER_CACHE_TELEMETRY },
	})));
	assert.equal(unavailable.extractionOutcome, "fallbackError");
	assert.equal(invalid.extractionOutcome, "fallbackEvidence");
	assert.equal(invalid.text, unavailable.text);
	assert.match(invalid.text, /skill-optimizer:smart/);
});

test("archive failure and insufficient complete savings keep the original", async () => {
	const io = ports(async () => undefined);
	const failed = await reduceToolOutput(text, config, { ...io, archive: () => undefined });
	assert.equal(failed.text, text);
	assert.equal(failed.removedChars, 0);
	const small = await reduceToolOutput(text, { ...config, minSavingsBytes: text.length }, io);
	assert.equal(small.text, text);
	assert.equal(io.archived.length, 0);
});

test("cancellation after extraction cannot archive or return a reduced result", async () => {
	const controller = new AbortController();
	const io = ports(async () => {
		controller.abort();
		return { text: text.split("\n")[0], telemetry: { ...EMPTY_PROVIDER_CACHE_TELEMETRY } };
	});
	await assert.rejects(reduceToolOutput(text, config, { ...io, signal: controller.signal }), { name: "AbortError" });
	assert.equal(io.archived.length, 0);
});
