function abortError(): Error {
	const error = new Error("Request was aborted");
	return Object.assign(error, { name: "AbortError" });
}

/** Release a model caller on abort, even when its provider ignores cancellation. */
export async function awaitModelCall<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
	const assertActive = (): void => {
		if (signal.aborted) throw abortError();
	};
	assertActive();
	let onAbort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		// Convert synchronous provider throws to a rejection before installing the race.
		const execute = async (): Promise<T> => run();
		const result = await Promise.race([execute(), cancelled]);
		assertActive();
		return result;
	} catch (error) {
		assertActive();
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
