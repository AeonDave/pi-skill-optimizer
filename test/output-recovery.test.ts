import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceOutputLines } from "../src/output-recovery.ts";

test("output recovery preserves LF, CRLF, CR, mixed delimiters and Unicode exactly", () => {
	for (const text of ["a\nb\n", "a\r\nb\r\n", "a\rb\r", "a\r\nb\nc\rd", "雪\r\n🦋\n", "single line", ""]) {
		assert.equal(sliceOutputLines(text).text, text);
	}
});

test("adjacent recovery pages concatenate to the byte-identical original", () => {
	const text = "first\r\nsecond\nthird\rfourth\r\n";
	assert.equal(sliceOutputLines(text, 1, 1).text, "first\r\n");
	assert.equal(sliceOutputLines(text, 2, 2).text, "second\nthird\r");
	const pages = [sliceOutputLines(text, 1, 2), sliceOutputLines(text, 3, 2), sliceOutputLines(text, 5, 2)];
	assert.deepEqual(Buffer.from(pages.map((page) => page.text).join("")), Buffer.from(text));
	assert.equal(pages[0].totalLines, 5);
});

test("recovery beyond EOF is empty rather than silently repeating the last line", () => {
	assert.deepEqual(sliceOutputLines("first\nlast", 8, 4), {
		text: "", startLine: 8, lineCount: 0, totalLines: 2,
	});
});

test("line recovery validates its own bounds independently of the tool schema", () => {
	for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => sliceOutputLines("a", invalid, 1), RangeError);
		assert.throws(() => sliceOutputLines("a", 1, invalid), RangeError);
	}
	assert.throws(() => sliceOutputLines("a", 1, 1001), RangeError);
	assert.equal(sliceOutputLines("x\n".repeat(1500), 1, 1000).lineCount, 1000);
});
