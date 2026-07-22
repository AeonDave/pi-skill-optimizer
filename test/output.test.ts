import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildExtractPrompt,
	commandProgram,
	isExcludedCommand,
	isRtkSource,
	protectedEvidenceLines,
	reduceOutput,
	truncateUtf8Bytes,
	utf8ByteLength,
	validateExtractedOutput,
} from "../src/output.ts";

test("small output is returned unchanged", () => {
	const text = "line1\nline2\nline3";
	const result = reduceOutput(text, { maxLines: 200, maxBytes: 16_000 });
	assert.equal(result.reduced, false);
	assert.equal(result.text, text);
});

test("large output keeps head, tail, and counted middle omission", () => {
	const lines = Array.from({ length: 500 }, (_, i) => `ok line ${i}`);
	const result = reduceOutput(lines.join("\n"), { maxLines: 100, headLines: 10, tailLines: 10 });
	assert.equal(result.reduced, true);
	assert.ok(result.toLines < result.fromLines);
	assert.ok(result.text.includes("ok line 0"));
	assert.ok(result.text.includes("ok line 499"));
	assert.match(result.text, /\(\d+ lines omitted\)/);
});

test("protected evidence and bounded context survive in the middle", () => {
	const lines = Array.from({ length: 400 }, (_, i) => `step ${i} ok`);
	lines[199] = "setup for failure";
	lines[200] = "ERROR: boom in module X";
	lines[250] = "Warning: deprecated API Y";
	lines[300] = "  at fn (file.ts:10:5)";
	const result = reduceOutput(lines.join("\n"), { maxLines: 50, headLines: 5, tailLines: 5 });
	assert.equal(result.reduced, true);
	assert.ok(result.text.includes("setup for failure"));
	assert.ok(result.text.includes("ERROR: boom in module X"));
	assert.ok(result.text.includes("Warning: deprecated API Y"));
	assert.ok(result.text.includes("at fn (file.ts:10:5)"));
	assert.ok(!result.text.includes("step 150 ok"));
});

test("giant ordinary line is capped in UTF-8 bytes", () => {
	const giant = "🙂漢e\u0301".repeat(10_000);
	const result = reduceOutput(`head\n${giant}\nERROR: tail`, {
		maxLines: 1,
		maxBytes: 100,
		maxLineBytes: 100,
		headLines: 3,
		tailLines: 0,
	});
	assert.equal(result.reduced, true);
	const line = result.text.split("\n")[1];
	assert.ok(utf8ByteLength(line) <= 100);
	assert.match(line, /\+\d+ bytes/);
	assert.ok(result.text.includes("ERROR: tail"));
});

test("UTF-8 truncation does not split emoji, CJK, or combining code points", () => {
	const hasUnpairedSurrogate = (value: string): boolean => {
		for (let i = 0; i < value.length; i++) {
			const unit = value.charCodeAt(i);
			if (unit >= 0xd800 && unit <= 0xdbff) {
				const next = value.charCodeAt(i + 1);
				if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
				i++;
			} else if (unit >= 0xdc00 && unit <= 0xdfff) {
				return true;
			}
		}
		return false;
	};
	assert.equal(truncateUtf8Bytes("🙂🙂", 5), "🙂");
	assert.equal(truncateUtf8Bytes("漢漢漢", 7), "漢漢");
	assert.equal(truncateUtf8Bytes("e\u0301x", 3), "e\u0301");
	assert.equal(utf8ByteLength(truncateUtf8Bytes("🙂漢e\u0301", 8)), 8);
	const truncated = truncateUtf8Bytes("🙂🙂", 5);
	assert.equal(hasUnpairedSurrogate(truncated), false);
	assert.equal(Buffer.from(truncated, "utf8").toString("utf8"), truncated);
});

test("thresholds and result metrics use UTF-8 bytes", () => {
	const text = "🙂".repeat(100);
	const result = reduceOutput(text, {
		maxLines: 100,
		maxBytes: 399,
		maxLineBytes: 32,
		minSavingsBytes: 0,
		minSavingsRatio: 0,
	});
	assert.equal(result.reduced, true);
	assert.equal(result.fromBytes, 400);
	assert.equal(result.toBytes, utf8ByteLength(result.text));
	assert.ok(result.toBytes <= 32);
});

test("CRLF input is handled cross-platform", () => {
	const lines = Array.from({ length: 300 }, (_, i) => `row ${i}`);
	const result = reduceOutput(lines.join("\r\n"), { maxLines: 50, headLines: 5, tailLines: 5 });
	assert.equal(result.reduced, true);
	assert.ok(result.text.includes("row 0"));
	assert.ok(result.text.includes("row 299"));
});

test("reduction is a no-op when protected evidence prevents material savings", () => {
	const text = "ERROR a\nERROR b\nERROR c";
	const result = reduceOutput(text, { maxLines: 1, maxBytes: 1, headLines: 0, tailLines: 0 });
	assert.equal(result.reduced, false);
	assert.equal(result.text, text);
});

test("minimum benefit is configurable and deterministic", () => {
	const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
	const options = { maxLines: 1, headLines: 19, tailLines: 19, minSavingsBytes: 100, minSavingsRatio: 0 };
	const first = reduceOutput(text, options);
	const second = reduceOutput(text, options);
	assert.equal(first.reduced, false);
	assert.deepEqual(first, second);
});

test("isRtkSource detects RTK extension metadata without substring false positives", () => {
	assert.equal(isRtkSource("rtk", "C:/Users/x/.pi/agent/extensions/pi-rtk-optimizer/index.ts", ""), true);
	assert.equal(isRtkSource("", "", "npm:pi-rtk-optimizer"), true);
	assert.equal(isRtkSource("rtk", "", ""), true);
	assert.equal(isRtkSource("skill-optimizer", "/x/pi-skill-optimizer/index.ts", ""), false);
	assert.equal(isRtkSource("network", "", ""), false);
});

test("commandProgram resolves env assignments, wrappers, paths, and exe suffixes", () => {
	assert.equal(commandProgram("cat big.txt"), "cat");
	assert.equal(commandProgram("  FOO=1 BAR=2 ls -la /tmp"), "ls");
	assert.equal(commandProgram("sudo find / -name x"), "find");
	assert.equal(commandProgram("/usr/bin/head -n 5 f"), "head");
	assert.equal(commandProgram("C:\\\\Windows\\\\System32\\\\tree.exe"), "tree");
	assert.equal(commandProgram("npm test"), "npm");
});

test("isExcludedCommand matches configured dump programs", () => {
	const exclude = ["cat", "ls", "head", "tail", "tree", "find"];
	assert.equal(isExcludedCommand("cat config.txt", exclude), true);
	assert.equal(isExcludedCommand("FOO=1 ls -la", exclude), true);
	assert.equal(isExcludedCommand("grep -rn token src/", exclude), false);
	assert.equal(isExcludedCommand("npm test", exclude), false);
	assert.equal(isExcludedCommand("cat x", []), false);
});

test("protected evidence covers diagnostics and constraints without ordinary lines", () => {
	const text = [
		"ordinary result",
		"ERROR: boom",
		"Expected: 4",
		"src/check.ts:12:7 type mismatch",
		"Requirement: keep identifiers stable",
		"another normal row",
	].join("\n");
	const evidence = protectedEvidenceLines(text);
	assert.deepEqual(evidence, [
		"ERROR: boom",
		"Expected: 4",
		"src/check.ts:12:7 type mismatch",
		"Requirement: keep identifiers stable",
	]);
});

test("buildExtractPrompt is byte-safe, keeps head and tail, and forbids prose", () => {
	const output = `HEAD-${"🙂".repeat(10_000)}-TAIL`;
	const { system, user } = buildExtractPrompt("find the failing test", "npm test", output, 1_000);
	assert.match(system, /select/i);
	assert.match(system, /no prose/i);
	assert.ok(user.includes("find the failing test"));
	assert.ok(user.includes("npm test"));
	const clipped = user.split("COMMAND OUTPUT:\n")[1];
	assert.ok(utf8ByteLength(clipped) <= 1_000);
	assert.ok(clipped.startsWith("HEAD-"));
	assert.ok(clipped.endsWith("-TAIL"));
	assert.ok(clipped.includes("middle truncated for extraction"));
});

function extractionFixture(): string {
	const lines = Array.from({ length: 300 }, (_, i) => `row ${i}`);
	lines[150] = "ERROR: exact failure";
	lines[151] = "src/run.ts:44:9";
	return lines.join("\n");
}

test("valid model extraction is accepted only as verbatim lines with all evidence", () => {
	const original = extractionFixture();
	const extracted = "row 0\nERROR: exact failure\nsrc/run.ts:44:9\nrow 299";
	const result = validateExtractedOutput(original, extracted, { minSavingsBytes: 1, minSavingsRatio: 0 });
	assert.equal(result.strategy, "extract");
	assert.equal(result.text, extracted);
	assert.equal(result.fromBytes, utf8ByteLength(original));
	assert.equal(result.toBytes, utf8ByteLength(extracted));
});

test("verbatim lines reordered by the model are rejected", () => {
	const original = extractionFixture();
	const extracted = "row 299\nERROR: exact failure\nsrc/run.ts:44:9\nrow 0";
	const result = validateExtractedOutput(original, extracted, {
		minSavingsBytes: 1,
		minSavingsRatio: 0,
		smartOptions: { maxLines: 20, headLines: 3, tailLines: 3 },
	});
	assert.equal(result.strategy, "smart");
	assert.equal(result.rejectionReason, "out-of-order-line");
	assert.ok(result.text.includes("ERROR: exact failure"));
});

test("hallucinated extraction is rejected and cannot leak into smart fallback", () => {
	const original = extractionFixture();
	const result = validateExtractedOutput(original, "row 0\nINVENTED VALUE", {
		minSavingsBytes: 1,
		minSavingsRatio: 0,
		smartOptions: { maxLines: 20, headLines: 3, tailLines: 3 },
	});
	assert.equal(result.strategy, "smart");
	assert.equal(result.rejectionReason, "non-verbatim-line");
	assert.ok(!result.text.includes("INVENTED VALUE"));
	assert.ok(result.text.includes("ERROR: exact failure"));
});

test("extraction missing errors or diagnostics falls back to evidence-safe smart", () => {
	const original = extractionFixture();
	const result = validateExtractedOutput(original, "row 0\nrow 299", {
		minSavingsBytes: 1,
		minSavingsRatio: 0,
		smartOptions: { maxLines: 20, headLines: 3, tailLines: 3 },
	});
	assert.equal(result.strategy, "smart");
	assert.equal(result.rejectionReason, "missing-protected-evidence");
	assert.ok(result.text.includes("ERROR: exact failure"));
	assert.ok(result.text.includes("src/run.ts:44:9"));
});

test("extraction below minimum benefit falls back to the unchanged original", () => {
	const original = "alpha\nbeta\ngamma";
	const result = validateExtractedOutput(original, "alpha\nbeta", {
		minSavingsBytes: 100,
		minSavingsRatio: 0,
		smartOptions: { maxLines: 100, maxBytes: 10_000 },
	});
	assert.equal(result.strategy, "original");
	assert.equal(result.rejectionReason, "insufficient-benefit");
	assert.equal(result.text, original);
});

test("smart and extraction validation are deterministic", () => {
	const original = extractionFixture();
	const options = {
		minSavingsBytes: 1,
		minSavingsRatio: 0,
		smartOptions: { maxLines: 20, headLines: 3, tailLines: 3 },
	};
	assert.deepEqual(
		validateExtractedOutput(original, "row 0\nnot in source", options),
		validateExtractedOutput(original, "row 0\nnot in source", options),
	);
});
