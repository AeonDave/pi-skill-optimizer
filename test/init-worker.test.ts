import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelResponse } from "../src/generate.ts";
import { runInitBatch } from "../src/init-worker.ts";

type Registry = Pick<ExtensionContext["modelRegistry"], "stream">;
type Activity = ["connected" | "thinking" | "text", number?];
interface StreamEvent { type: string; delta?: string }
interface FakeStream extends AsyncIterable<StreamEvent> { result(): Promise<ModelResponse> }
const model = { provider: "fixture", id: "fixture" } as NonNullable<ExtensionContext["model"]>;
const context: Context = { systemPrompt: "Unchanged init instructions", messages: [] };
const completed: ModelResponse = { stopReason: "stop", content: [{ type: "text", text: "authoritative complete JSON" }] };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function registry(stream: FakeStream, onCall?: (...args: unknown[]) => void): Registry {
	return { stream: (...args: unknown[]) => { onCall?.(...args); return stream; } } as unknown as Registry;
}

function events(values: StreamEvent[], result = completed): FakeStream {
	return {
		async *[Symbol.asyncIterator]() { yield* values; },
		async result() { return result; },
	};
}

test("init worker forwards the original request and returns only the authoritative result", async () => {
	const controller = new AbortController();
	const activity: Activity[] = [];
	let calls = 0;
	const result = await runInitBatch(registry(events([
		{ type: "start" }, { type: "thinking_delta", delta: "private reasoning" },
		{ type: "text_start" }, { type: "text_delta", delta: "partial invalid JSON 日本語" },
		{ type: "toolcall_delta", delta: "ignored" }, { type: "done" },
	]), (...args) => {
		calls++;
		assert.equal(args[0], model);
		assert.equal(args[1], context);
		assert.deepEqual(args[2], { signal: controller.signal });
	}), model, context, { signal: controller.signal, onActivity: (...args) => { activity.push(args); } });
	assert.equal(calls, 1);
	assert.equal(result, completed);
	assert.deepEqual(activity, [["connected"], ["thinking", 17], ["text", 24]]);
});

test("init worker preserves an authoritative provider error result", async () => {
	const failure = { stopReason: "error", errorMessage: "provider denied", content: [] };
	assert.equal(await runInitBatch(registry(events([{ type: "error" }], failure)), model, context, {
		signal: new AbortController().signal, onActivity() {},
	}), failure);
});

test("init worker UI activity failures are cosmetic", async () => {
	assert.equal(await runInitBatch(registry(events([{ type: "start" }, { type: "text_delta", delta: "x" }])), model, context, {
		signal: new AbortController().signal, onActivity() { throw new Error("UI unavailable"); },
	}), completed);
});

test("init worker aborts before creating a provider stream", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	await assert.rejects(runInitBatch(registry(events([]), () => { calls++; }), model, context, {
		signal: controller.signal, onActivity() { assert.fail("no activity after abort"); },
	}), { name: "AbortError" });
	assert.equal(calls, 0);
});

test("init worker aborts promptly while the stream is silent and suppresses late activity", { timeout: 2_000 }, async (t) => {
	const controller = new AbortController();
	const remove = t.mock.method(controller.signal, "removeEventListener");
	const pending = deferred<IteratorResult<StreamEvent>>();
	const started = deferred<void>();
	const activity: Activity[] = [];
	let resultCalls = 0;
	const stream: FakeStream = {
		[Symbol.asyncIterator]() { return { next() { started.resolve(); return pending.promise; } }; },
		async result() { resultCalls++; return completed; },
	};
	const job = runInitBatch(registry(stream), model, context, {
		signal: controller.signal, onActivity: (...args) => { activity.push(args); },
	});
	await started.promise;
	controller.abort();
	await assert.rejects(job, { name: "AbortError" });
	assert.equal(remove.mock.callCount(), 1);
	pending.resolve({ done: false, value: { type: "text_delta", delta: "late private output" } });
	await nextTick();
	assert.deepEqual(activity, []);
	assert.equal(resultCalls, 0);
});

test("init worker aborts while awaiting the authoritative result", { timeout: 2_000 }, async (t) => {
	const controller = new AbortController();
	const remove = t.mock.method(controller.signal, "removeEventListener");
	const pending = deferred<ModelResponse>();
	const started = deferred<void>();
	const stream = events([]);
	stream.result = () => { started.resolve(); return pending.promise; };
	const job = runInitBatch(registry(stream), model, context, { signal: controller.signal, onActivity() {} });
	await started.promise;
	controller.abort();
	await assert.rejects(job, { name: "AbortError" });
	assert.equal(remove.mock.callCount(), 1);
	pending.resolve(completed);
	await nextTick();
});

test("init worker propagates provider failures and always removes its abort listener", async (t) => {
	const failure = new Error("provider failure");
	for (const stage of ["success", "stream", "iterator", "result"] as const) {
		const controller = new AbortController();
		const add = t.mock.method(controller.signal, "addEventListener");
		const remove = t.mock.method(controller.signal, "removeEventListener");
		const stream = events([]);
		if (stage === "iterator") stream[Symbol.asyncIterator] = () => ({ next: () => Promise.reject(failure) });
		if (stage === "result") stream.result = () => Promise.reject(failure);
		const job = runInitBatch(registry(stream, () => { if (stage === "stream") throw failure; }), model, context, {
			signal: controller.signal, onActivity() {},
		});
		if (stage === "success") assert.equal(await job, completed);
		else await assert.rejects(job, (error) => error === failure);
		assert.equal(add.mock.callCount(), 1, stage);
		assert.equal(remove.mock.callCount(), 1, stage);
		assert.equal(remove.mock.calls[0]!.arguments[0], "abort");
		assert.equal(remove.mock.calls[0]!.arguments[1], add.mock.calls[0]!.arguments[1]);
	}
});

test("init worker stops when an activity callback cancels the job", async () => {
	const controller = new AbortController();
	const activity: Activity[] = [];
	await assert.rejects(runInitBatch(registry(events([{ type: "start" }, { type: "text_delta", delta: "late" }])), model, context, {
		signal: controller.signal, onActivity: (...args) => { activity.push(args); controller.abort(); },
	}), { name: "AbortError" });
	assert.deepEqual(activity, [["connected"]]);
});

test("init worker treats cancellation during stream creation as terminal even if the provider throws", async () => {
	const controller = new AbortController();
	await assert.rejects(runInitBatch(registry(events([]), () => {
		controller.abort();
		throw new Error("transport closed after cancellation");
	}), model, context, { signal: controller.signal, onActivity() { assert.fail("cancelled stream has no activity"); } }), {
		name: "AbortError",
	});
});
