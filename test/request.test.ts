import assert from "node:assert/strict";
import { test } from "node:test";
import { appendToLatestHumanInput, extractRequestQuery, normalizeRequest } from "../src/request.ts";

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
	assert.equal(extractRequestQuery(request), "current step");
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

test("excludes Anthropic tool results and injected context from the ranking query", () => {
	const request = normalizeRequest({
		messages: [
			{ role: "user", content: [{ type: "text", text: "initial human task" }] },
			{ role: "assistant", content: [{ type: "tool_use", name: "inspect", input: { content: "not human" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "large noisy tool output" }] },
			{ role: "user", content: "context-mode active. synthetic retrieved context" },
			{ role: "user", content: [{ type: "text", text: "actual human follow-up" }] },
		],
	});
	assert.deepEqual(request.messages, [
		{ role: "user", text: "initial human task" },
		{ role: "user", text: "actual human follow-up" },
	]);
	assert.equal(extractRequestQuery(request), "actual human follow-up");
	assert.deepEqual([...request.usedToolNames], ["inspect"]);
});

test("excludes OpenAI function outputs and Chat/Mistral tool-role content", () => {
	const request = normalizeRequest({
		messages: [
			{ role: "user", content: "chat task" },
			{ role: "tool", tool_call_id: "call-1", content: "chat tool output" },
			{ role: "assistant", tool_calls: [{ function: { name: "chat_lookup" } }] },
		],
		input: [
			{ type: "function_call", name: "responses_lookup", arguments: "{}" },
			{ type: "function_call_output", call_id: "call-2", output: "responses tool output" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "responses follow-up" }] },
		],
	});
	assert.deepEqual(request.messages, [
		{ role: "user", text: "chat task" },
		{ role: "user", text: "responses follow-up" },
	]);
	assert.equal(extractRequestQuery(request), "responses follow-up");
	assert.deepEqual([...request.usedToolNames].sort(), ["chat_lookup", "responses_lookup"]);
});

test("excludes Gemini function responses while preserving adjacent human text", () => {
	const request = normalizeRequest({
		contents: [
			{ role: "user", parts: [{ text: "gemini task" }] },
			{ role: "model", parts: [{ functionCall: { name: "gemini_lookup", args: {} } }] },
			{
				role: "user",
				parts: [
					{ functionResponse: { name: "gemini_lookup", response: { text: "function output" } } },
					{ text: "gemini human follow-up" },
				],
			},
		],
	});
	assert.deepEqual(request.messages, [
		{ role: "user", text: "gemini task" },
		{ role: "user", text: "gemini human follow-up" },
	]);
	assert.equal(extractRequestQuery(request), "gemini human follow-up");
	assert.deepEqual([...request.usedToolNames], ["gemini_lookup"]);
});

test("appendToLatestHumanInput minimally clones Anthropic/Chat history and skips tool results", () => {
	const human = { role: "user", content: [{ type: "text", text: "human task" }] };
	const tool = { role: "user", content: [{ type: "tool_result", content: "tool output" }] };
	const payload = { model: "x", messages: [human, tool] };
	const next = appendToLatestHumanInput(payload, "prefetched context", "<prefetch:v1>") as typeof payload;
	assert.notEqual(next, payload);
	assert.notEqual(next.messages, payload.messages);
	assert.notEqual(next.messages[0], human);
	assert.equal(next.messages[1], tool);
	assert.equal((next.messages[0].content[0] as { text: string }).text, "human task\n<prefetch:v1>\nprefetched context");
	assert.equal((human.content[0] as { text: string }).text, "human task");
	assert.equal(appendToLatestHumanInput(next, "prefetched context", "<prefetch:v1>"), next);
});

test("appendToLatestHumanInput supports Responses and string input without targeting function output", () => {
	const responsePayload = {
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "response task" }] },
			{ type: "function_call_output", output: "function output" },
		],
	};
	const responseNext = appendToLatestHumanInput(responsePayload, "overlay") as typeof responsePayload;
	assert.equal((responseNext.input[0].content as Array<{ text: string }>)[0].text, "response task\noverlay");
	assert.equal(responseNext.input[1], responsePayload.input[1]);
	const stringPayload = { input: "plain response task" };
	assert.deepEqual(appendToLatestHumanInput(stringPayload, "overlay"), { input: "plain response task\noverlay" });
});

test("appendToLatestHumanInput supports Gemini and ignores functionResponse/context-only turns", () => {
	const payload = {
		contents: [
			{ role: "user", parts: [{ text: "gemini task" }] },
			{ role: "user", parts: [{ functionResponse: { response: { text: "tool output" } } }] },
			{ role: "user", parts: [{ text: "context-mode active. injected" }] },
		],
	};
	const next = appendToLatestHumanInput(payload, "overlay") as typeof payload;
	assert.equal((next.contents[0].parts[0] as { text: string }).text, "gemini task\noverlay");
	assert.equal(next.contents[1], payload.contents[1]);
	assert.equal(next.contents[2], payload.contents[2]);
});

test("appendToLatestHumanInput returns identity without genuine human text", () => {
	const payload = { messages: [{ role: "tool", content: "output" }] };
	assert.equal(appendToLatestHumanInput(payload, "overlay"), payload);
	assert.equal(appendToLatestHumanInput(payload, ""), payload);
});

test("appendToLatestHumanInput returns identity when the marker already exists elsewhere in the payload", () => {
	const payload = {
		messages: [
			{ role: "user", content: "human task" },
			{ role: "assistant", content: "cached <!--skill-optimizer:auto:v2--> context" },
		],
	};
	assert.equal(appendToLatestHumanInput(payload, "overlay", "<!--skill-optimizer:auto:v2-->"), payload);
});
