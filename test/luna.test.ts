import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildLunaArgs,
	parsePiJsonl,
	type LunaThinking,
} from "../scripts/lib/luna.ts";

function assistantEvent(text: string, usage: Record<string, number>): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage,
		},
	});
}

test("parsePiJsonl selects the last finalized assistant and reconstructs OpenAI usage", () => {
	const stdout = [
		JSON.stringify({ type: "session", id: "header" }),
		assistantEvent("old", { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }),
		"non-json diagnostic",
		JSON.stringify({ type: "message_end", message: { role: "user", content: "ignored" } }),
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "final one" },
					{ type: "text", text: "final two" },
				],
				usage: {
					input: 100,
					output: 9,
					cacheRead: 20,
					cacheWrite: 5,
					reasoning: 3,
					totalTokens: 134,
				},
			},
		}),
	].join("\n");

	assert.deepEqual(parsePiJsonl(stdout), {
		text: "final one\nfinal two",
		usage: {
			inputTokens: 125,
			outputTokens: 9,
			totalTokens: 134,
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			reasoningTokens: 3,
		},
	});
});

test("parsePiJsonl defaults optional usage buckets and derives a missing total", () => {
	assert.deepEqual(parsePiJsonl(assistantEvent("ok", { input: 7, output: 2 })), {
		text: "ok",
		usage: {
			inputTokens: 7,
			outputTokens: 2,
			totalTokens: 9,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		},
	});
});

test("parsePiJsonl reports missing assistant and invalid usage clearly", () => {
	assert.throws(
		() => parsePiJsonl('{"type":"agent_end"}\nnot-json'),
		/Pi JSONL did not contain a finalized assistant message \(1 non-JSON line\(s\) ignored\)/,
	);
	assert.throws(
		() => parsePiJsonl(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: "7", output: 2 } },
		})),
		/invalid input\/output usage data/,
	);
});

test("buildLunaArgs is isolated and keeps full prompts out of argv", () => {
	const systemFile = "C:\\Private Temp\\system.md";
	const userFile = "C:\\Private Temp\\user.md";
	const args = buildLunaArgs({ thinking: "high", systemFile, userFile });
	assert.deepEqual(args, [
		"proxy",
		"pi",
		"--offline",
		"--model",
		"openai-codex/gpt-5.6-luna:high",
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--system-prompt",
		"Follow the complete system instructions in the appended local file.",
		"--append-system-prompt",
		systemFile,
		`@${userFile}`,
		"Process the attached user request.",
	]);
	assert.equal(args.some((argument) => argument.includes("secret system content")), false);
	assert.equal(args.some((argument) => argument.includes("secret user content")), false);
});

test("buildLunaArgs rejects unsupported thinking levels", () => {
	assert.throws(
		() => buildLunaArgs({
			thinking: "turbo" as LunaThinking,
			systemFile: "system.md",
			userFile: "user.md",
		}),
		/Unsupported Luna thinking level: turbo/,
	);
});
