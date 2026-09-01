import assert from "node:assert/strict";
import { test } from "node:test";
import { deduplicateToolResultHistory, type HistoryToolResult } from "../src/history.ts";

const large = (value: string): string => value.repeat(5_000);

test("keeps the first exact result and replaces only later duplicates with recoverable opaque references", () => {
	const text = large("alpha ");
	const input: HistoryToolResult[] = [
		{ content: text, toolName: "shell" },
		{ content: text, toolName: "shell" },
		{ content: large("different "), toolName: "shell" },
	];
	const result = deduplicateToolResultHistory(input);
	assert.notEqual(result.next, input);
	assert.equal(result.next[0], input[0]);
	assert.equal(result.next[0].content, text);
	assert.match(String(result.next[1].content), /^\[duplicate tool result; same-as=htr:[A-Za-z0-9_-]{43}\]$/);
	assert.equal(result.next[2], input[2]);
	assert.equal(result.duplicates, 1);
	assert.equal(result.artifacts.length, 1);
	assert.equal(result.resolve(result.artifacts[0].id), result.artifacts[0]);
	assert.equal(result.artifacts[0].content, text);
	assert.equal(result.resolve("htr:invalid"), undefined);
	assert.equal(input[1].content, text);
});

test("deduplication is monotonic and remains able to compact newly appended duplicates", () => {
	const text = large("stable ");
	const first = deduplicateToolResultHistory([{ content: text }, { content: text }]);
	const second = deduplicateToolResultHistory(first.next);
	assert.equal(second.next, first.next);
	assert.equal(second.duplicates, 0);
	const appended = [...first.next, { content: text }];
	const third = deduplicateToolResultHistory(appended);
	assert.equal(third.duplicates, 1);
	assert.equal(third.next[0].content, text);
	assert.match(String(third.next[2].content), /same-as=htr:/);
	assert.equal(third.resolve(third.artifacts[0].id)?.text, text);
});

test("never changes errors, protected evidence, images, mixed content, or small results", () => {
	const error = large("fatal failure ");
	const explicitError = large("plain but marked ");
	const imageContent = [{ type: "text", text: large("visual ") }, { type: "image", data: "abc" }];
	const mixedContent = [{ type: "text", text: large("mixed ") }, { type: "json", value: {} }];
	const input: HistoryToolResult[] = [
		{ content: "small" }, { content: "small" },
		{ content: error }, { content: error },
		{ content: explicitError, isError: true }, { content: explicitError, isError: true },
		{ content: imageContent }, { content: imageContent },
		{ content: mixedContent }, { content: mixedContent },
	];
	const result = deduplicateToolResultHistory(input);
	assert.equal(result.next, input);
	assert.equal(result.duplicates, 0);
	assert.deepEqual(result.artifacts, []);
});

test("supports exact multi-text-block duplicates without touching their first view", () => {
	const blocks = [{ type: "text", text: large("one ") }, { type: "text", text: large("two ") }];
	const input = [{ content: blocks }, { content: blocks.map((block) => ({ ...block })) }];
	const result = deduplicateToolResultHistory(input);
	assert.equal(result.duplicates, 1);
	assert.equal(result.next[0].content, blocks);
	assert.ok(Array.isArray(result.next[1].content));
	assert.equal((result.next[1].content as Array<{ type: string }>).length, 1);
	assert.equal(result.artifacts[0].content, blocks);
});
