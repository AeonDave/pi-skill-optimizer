import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelResponse } from "./generate.ts";

function abortError(): Error {
	const error = new Error("Request was aborted");
	error.name = "AbortError";
	return error;
}

/** Observe an isolated init request without changing its prompt or final response. */
export async function runInitBatch(
	registry: Pick<ExtensionContext["modelRegistry"], "stream">,
	model: NonNullable<ExtensionContext["model"]>,
	context: Context,
	options: { signal: AbortSignal; onActivity: (kind: "connected" | "thinking" | "text", chars?: number) => void },
): Promise<ModelResponse> {
	const { signal, onActivity } = options;
	const assertActive = (): void => { if (signal.aborted) throw abortError(); };
	assertActive();
	let onAbort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => { reject(abortError()); };
		signal.addEventListener("abort", onAbort, { once: true });
	});
	const consume = async (): Promise<ModelResponse> => {
		assertActive();
		const stream = registry.stream(model, context, { signal });
		assertActive();
		const iterator = stream[Symbol.asyncIterator]();
		while (true) {
			assertActive();
			const event = await iterator.next();
			assertActive();
			if (event.done) break;
			try {
				if (event.value.type === "start") onActivity("connected");
				else if (event.value.type === "thinking_delta") onActivity("thinking", event.value.delta.length);
				else if (event.value.type === "text_delta") onActivity("text", event.value.delta.length);
			} catch { /* Cosmetic activity reporting cannot reject a valid provider response. */ }
		}
		assertActive();
		const response = await stream.result();
		assertActive();
		return response;
	};
	try {
		// Some providers can remain silent even after abort. Race the whole operation,
		// including a pending next()/result(); late events check the signal before UI work.
		return await Promise.race([consume(), cancelled]);
	} catch (error) {
		// An SDK may throw its transport error synchronously while handling cancellation.
		assertActive();
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
