import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRequestQuery, normalizeRequest } from "../src/request.ts";

test("normalizes Anthropic text and tool-use history", () => {
	const request = normalizeRequest({
		messages: [
			{ id: "msg-initial", role: "user", content: [{ type: "text", text: "initial task" }, { type: "image", source: {} }] },
			{ role: "assistant", content: [{ type: "tool_use", name: "anthropic_tool", input: {} }] },
			{ message_id: "msg-current", role: "user", content: "current step" },
		],
	});
	assert.deepEqual(request.messages, [
		{ role: "user", text: "initial task", sourceId: "msg-initial" },
		{ role: "user", text: "current step", sourceId: "msg-current" },
	]);
	assert.equal(extractRequestQuery(request), "initial task\ncurrent step");
	assert.deepEqual([...request.usedToolNames], ["anthropic_tool"]);
});

test("normalizes OpenAI Chat and Responses text and function calls", () => {
	const request = normalizeRequest({
		messages: [
			{ role: "assistant", function_call: { name: "legacy_chat_tool", arguments: "{}" } },
			{ role: "assistant", tool_calls: [{ type: "function", function: { name: "chat_tool", arguments: "{}" } }] },
		],
		input: [
			{ id: "response-input", role: "user", content: [{ type: "input_text", text: "responses task" }] },
			{ type: "function_call", name: "responses_tool", arguments: "{}" },
		],
	});
	assert.deepEqual(request.messages, [{ role: "user", text: "responses task", sourceId: "response-input" }]);
	assert.equal(extractRequestQuery(request), "responses task");
	assert.deepEqual([...request.usedToolNames].sort(), ["chat_tool", "legacy_chat_tool", "responses_tool"]);
});

test("normalizes Gemini text, model roles, and function calls", () => {
	const request = normalizeRequest({
		contents: [
			{ messageId: 42, role: "user", parts: [{ text: "inspect packet traffic" }] },
			{ role: "model", parts: [{ functionCall: { name: "gemini_tool", args: {} } }, { text: "working" }] },
		],
	});
	assert.deepEqual(request.messages, [
		{ role: "user", text: "inspect packet traffic", sourceId: "42" },
		{ role: "assistant", text: "working" },
	]);
	assert.equal(extractRequestQuery(request), "inspect packet traffic");
	assert.deepEqual([...request.usedToolNames], ["gemini_tool"]);
});

test("handles string input, empty arrays, multimodal input, and query limits", () => {
	assert.equal(extractRequestQuery(normalizeRequest({ input: "plain request" })), "plain request");
	const empty = normalizeRequest({ messages: [], input: [], contents: [], tools: [{ name: "not_a_call" }] });
	assert.deepEqual(empty.messages, []);
	assert.deepEqual([...empty.usedToolNames], []);
	assert.equal(extractRequestQuery(empty), "");
	assert.equal(extractRequestQuery(normalizeRequest({ input: [{ role: "user", content: [{ type: "input_image" }] }] })), "");
	assert.equal(extractRequestQuery(normalizeRequest({ input: "abcdefgh" }), 4), "abcd");
});
