import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelResponse } from "./generate.ts";
import { awaitModelCall } from "./model-call.ts";

/** Observe an isolated init request without changing its prompt or final response. */
export async function runInitBatch(
	registry: Pick<ExtensionContext["modelRegistry"], "stream">,
	model: NonNullable<ExtensionContext["model"]>,
	context: Context,
	options: { signal: AbortSignal; onActivity: (kind: "connected" | "thinking" | "text", chars?: number) => void },
): Promise<ModelResponse> {
	const { signal, onActivity } = options;
	return awaitModelCall(signal, async () => {
		const stream = registry.stream(model, context, { signal });
		signal.throwIfAborted();
		const iterator = stream[Symbol.asyncIterator]();
		while (true) {
			signal.throwIfAborted();
			const event = await iterator.next();
			signal.throwIfAborted();
			if (event.done) break;
			try {
				if (event.value.type === "start") onActivity("connected");
				else if (event.value.type === "thinking_delta") onActivity("thinking", event.value.delta.length);
				else if (event.value.type === "text_delta") onActivity("text", event.value.delta.length);
			} catch { /* Cosmetic activity reporting cannot reject a valid provider response. */ }
		}
		signal.throwIfAborted();
		const response = await stream.result();
		signal.throwIfAborted();
		return response;
	});
}
