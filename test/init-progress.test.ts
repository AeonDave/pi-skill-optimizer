import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { createInitProgress } from "../src/init-progress.ts";

const options = { total: 275, alreadyCurrent: 80, catalogTotal: 355, model: "test/provider-model" };
function fixture(context: TestContext, overrides: Partial<typeof options> = {}) {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	const updates: Array<{ key: string; lines: string[] | undefined; placement: string | undefined }> = [];
	const progress = createInitProgress({
		setWidget(key, lines, settings) {
			assert.ok(lines === undefined || Array.isArray(lines));
			updates.push({ key, lines: lines === undefined ? undefined : [...lines], placement: settings?.placement });
		},
	}, { ...options, ...overrides });
	const text = () => updates.at(-1)?.lines?.join("\n") ?? "";
	return { progress, updates, text };
}

test("init progress immediately shows a real task widget with initial coverage and cancellation", (context) => {
	const { progress, updates, text } = fixture(context);
	assert.equal(updates.length, 1);
	assert.equal(updates[0]?.key, "skill-optimizer-init");
	assert.equal(updates[0]?.placement, "aboveEditor");
	assert.match(text(), /0%/);
	assert.match(text(), /0\/275/);
	assert.match(text(), /80\/355/);
	assert.match(text(), /test\/provider-model/);
	assert.match(text(), /\/skill-optimizer cancel/);
	assert.doesNotMatch(text(), /subagent|persona-agents/);
	progress.dispose();
});

test("init heartbeat keeps a waiting provider visible without inventing percentage progress", (context) => {
	const { progress, updates, text } = fixture(context);
	progress.startAttempt("1/14.2", 2, 10);
	assert.match(text(), /1\/14\.2/);
	assert.match(text(), /attempt 2/);
	assert.match(text(), /10 skills/);
	assert.match(text(), /awaiting provider/i);
	progress.activity("connected");
	for (let second = 0; second < 5; second++) context.mock.timers.tick(1_000);
	assert.match(text(), /stream started/);
	assert.doesNotMatch(text(), /provider connected/);
	assert.match(text(), /0%/);
	assert.match(text(), /0\/275/);
	assert.match(text(), /5s elapsed/);
	assert.match(text(), /last provider event 5s ago/);
	assert.ok(updates.length >= 6, "a heartbeat must repaint elapsed/provider age while the request is silent");
	progress.dispose();
});

test("stream chunks mutate progress counters without causing a redraw per chunk", (context) => {
	const { progress, updates, text } = fixture(context);
	progress.startAttempt("1/14", 1, 20);
	const beforeChunks = updates.length;
	for (let chunk = 0; chunk < 2_000; chunk++) progress.activity("thinking", 3);
	assert.equal(updates.length, beforeChunks);
	context.mock.timers.tick(1_000);
	assert.equal(updates.length, beforeChunks + 1);
	assert.match(text(), /thinking/i);
	assert.match(text(), /6000 chars/);
	for (let chunk = 0; chunk < 2_000; chunk++) progress.activity("text", 5);
	assert.equal(updates.length, beforeChunks + 1);
	context.mock.timers.tick(1_000);
	assert.equal(updates.length, beforeChunks + 2);
	assert.match(text(), /generating/i);
	assert.match(text(), /10000 chars/);
	assert.match(text(), /0%/);
	progress.dispose();
});

test("only committed skills advance percentage and coverage, monotonically within the target", (context) => {
	const { progress, text } = fixture(context, { total: 4, alreadyCurrent: 6, catalogTotal: 10 });
	progress.startAttempt("1/1", 1, 4);
	progress.activity("text", 200_000);
	context.mock.timers.tick(1_000);
	assert.match(text(), /0%/);
	progress.saved(1);
	assert.match(text(), /25%/);
	assert.match(text(), /1\/4/);
	assert.match(text(), /7\/10/);
	progress.saved(0);
	assert.match(text(), /25%/);
	progress.saved(99);
	assert.match(text(), /100%/);
	assert.match(text(), /4\/4/);
	assert.match(text(), /10\/10/);
	progress.dispose();
});

test("a successful scope-only repair completes its zero-work progress", (context) => {
	const { progress, text } = fixture(context, { total: 0, alreadyCurrent: 355, catalogTotal: 355 });
	assert.match(text(), /0%/);
	progress.finish("done");
	assert.match(text(), /100%/);
	assert.match(text(), /355\/355/);
	progress.dispose();
});

test("attempt transitions reset provider counters and report updates render immediately", (context) => {
	const { progress, updates, text } = fixture(context);
	progress.startAttempt("1/14", 1, 20);
	progress.activity("text", 1_234);
	context.mock.timers.tick(1_000);
	assert.match(text(), /1234 chars/);
	const count = updates.length;
	progress.report("Validation failed; retrying a smaller batch.");
	assert.equal(updates.length, count + 1);
	assert.match(text(), /Validation failed; retrying a smaller batch\./);
	progress.startAttempt("1/14.1", 2, 10);
	assert.match(text(), /awaiting provider/i);
	assert.doesNotMatch(text(), /1234 chars|Validation failed/);
	assert.match(text(), /provider events: none/);
	progress.dispose();
});

test("finish freezes the final summary and actual percentage, while dispose clears all UI", (context) => {
	const { progress, updates, text } = fixture(context, { total: 4, alreadyCurrent: 6, catalogTotal: 10 });
	progress.startAttempt("1/1", 1, 4);
	progress.saved(1);
	context.mock.timers.tick(1_000);
	progress.finish("cancelled");
	assert.match(text(), /cancelled/i);
	assert.match(text(), /25%/);
	assert.doesNotMatch(text(), /\/skill-optimizer cancel/);
	const count = updates.length;
	context.mock.timers.tick(60_000);
	progress.activity("text", 100);
	progress.startAttempt("late", 2, 4);
	progress.saved(4);
	progress.report("late result");
	progress.finish("done");
	assert.equal(updates.length, count);
	progress.dispose();
	assert.equal(updates.at(-1)?.lines, undefined);
	const disposedCount = updates.length;
	progress.dispose();
	progress.report("late after dispose");
	context.mock.timers.tick(60_000);
	assert.equal(updates.length, disposedCount);
});

test("dispose during a request clears its heartbeat and ignores every late update", (context) => {
	const { progress, updates } = fixture(context);
	assert.equal(updates.length, 1);
	progress.startAttempt("1/14", 1, 20);
	progress.dispose();
	const count = updates.length;
	assert.equal(updates.at(-1)?.lines, undefined);
	progress.activity("thinking", 1_000);
	progress.startAttempt("late", 2, 20);
	progress.saved(20);
	progress.report("late");
	progress.finish("failed");
	context.mock.timers.tick(60_000);
	assert.equal(updates.length, count);
});

test("init widgets bound and sanitize model, labels and reports before rendering", (context) => {
	const unsafe = `bad\n\u001b[31m\u202e\ud800${"x".repeat(2_000)}`;
	const { progress, text } = fixture(context, { model: unsafe });
	progress.startAttempt(unsafe, 1, 20);
	progress.report(unsafe);
	const rendered = text();
	assert.match(rendered, /model bad/);
	assert.match(rendered, /bad/);
	assert.ok(rendered.length < 800);
	assert.doesNotMatch(rendered.replaceAll("\n", ""), /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
	assert.doesNotMatch(rendered, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
	progress.dispose();
});

test("an unavailable cosmetic UI can recover on heartbeat without interrupting init", (context) => {
	context.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
	let calls = 0;
	let rendered: string[] | undefined;
	const progress = createInitProgress({
		setWidget(_key, lines) {
			calls++;
			if (calls === 1) throw new Error("UI temporarily unavailable");
			assert.ok(lines === undefined || Array.isArray(lines));
			rendered = lines;
		},
	}, options);
	assert.equal(calls, 1);
	context.mock.timers.tick(1_000);
	assert.equal(calls, 2);
	assert.match(rendered?.join("\n") ?? "", /0%/);
	progress.finish("failed");
	const count = calls;
	context.mock.timers.tick(60_000);
	assert.equal(calls, count);
	progress.dispose();
	assert.equal(rendered, undefined);
});
