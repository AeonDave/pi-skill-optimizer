import assert from "node:assert/strict";
import test from "node:test";
import { awaitModelCall } from "../src/model-call.ts";

test("model calls reject before starting when already cancelled", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(awaitModelCall(controller.signal, async () => {
		assert.fail("cancelled work started");
	}), { name: "AbortError" });
});

test("model calls release on abort and observe late provider rejection", async () => {
	const controller = new AbortController();
	let reject!: (reason: Error) => void;
	const result = awaitModelCall(controller.signal, () => new Promise((_, fail) => { reject = fail; }));
	controller.abort();
	await assert.rejects(result, { name: "AbortError" });
	reject(new Error("late transport failure"));
	await new Promise(setImmediate);
});

test("synchronous abort and provider throw do not leave an unhandled rejection", async () => {
	const controller = new AbortController();
	await assert.rejects(awaitModelCall(controller.signal, () => {
		controller.abort();
		throw new Error("transport failed during abort");
	}), { name: "AbortError" });
	await new Promise(setImmediate);
});

test("model calls preserve success and original provider failures", async () => {
	const signal = new AbortController().signal;
	assert.equal(await awaitModelCall(signal, async () => "final response"), "final response");
	const error = new Error("provider unavailable");
	await assert.rejects(awaitModelCall(signal, () => { throw error; }), (received) => received === error);
});
