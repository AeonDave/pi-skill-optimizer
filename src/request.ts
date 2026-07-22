/** Provider-neutral conversation context used by ranking and usage tracking. */

export interface NormalizedMessage {
	role: string;
	text: string;
	sourceId?: string;
}

export interface NormalizedRequest {
	messages: NormalizedMessage[];
	usedToolNames: Set<string>;
}

interface RequestEnvelope {
	messages?: unknown;
	input?: unknown;
	contents?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function addToolName(used: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.length > 0) used.add(value);
}

function collectToolCalls(record: Record<string, unknown>, used: Set<string>): void {
	if (record.type === "tool_use" || record.type === "tool_call" || record.type === "function_call") {
		addToolName(used, record.name);
	}
	for (const key of ["function_call", "functionCall"] as const) {
		const call = asRecord(record[key]);
		if (call) addToolName(used, call.name);
	}
	if (!Array.isArray(record.tool_calls)) return;
	for (const value of record.tool_calls) {
		const call = asRecord(value);
		if (!call) continue;
		addToolName(used, call.name);
		const fn = asRecord(call.function);
		if (fn) addToolName(used, fn.name);
	}
}

function collectContent(value: unknown, text: string[], used: Set<string>): void {
	if (typeof value === "string") {
		text.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectContent(item, text, used);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	collectToolCalls(record, used);
	if (typeof record.text === "string") text.push(record.text);
	if (record.content !== undefined) collectContent(record.content, text, used);
	if (record.parts !== undefined) collectContent(record.parts, text, used);
}

function normalizeRole(value: unknown, fallback?: string): string | undefined {
	if (typeof value !== "string" || value.length === 0) return fallback;
	return value === "model" ? "assistant" : value;
}

function messageSourceId(record: Record<string, unknown>): string | undefined {
	for (const key of ["id", "messageId", "message_id"] as const) {
		const value = record[key];
		if ((typeof value === "string" || typeof value === "number") && String(value).length > 0) {
			return String(value);
		}
	}
	return undefined;
}

function collectItem(
	value: unknown,
	fallbackRole: string | undefined,
	messages: NormalizedMessage[],
	usedToolNames: Set<string>,
): void {
	if (typeof value === "string") {
		if (fallbackRole && value.trim()) messages.push({ role: fallbackRole, text: value });
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	const fragments: string[] = [];
	collectToolCalls(record, usedToolNames);
	if (record.content !== undefined) collectContent(record.content, fragments, usedToolNames);
	if (record.parts !== undefined) collectContent(record.parts, fragments, usedToolNames);
	if (record.content === undefined && record.parts === undefined && typeof record.text === "string") {
		fragments.push(record.text);
	}
	const text = fragments.join(" ");
	const role = normalizeRole(record.role, fallbackRole);
	if (role && text.trim()) {
		const sourceId = messageSourceId(record);
		messages.push(sourceId === undefined ? { role, text } : { role, text, sourceId });
	}
}

/** Normalize a direct message history or canonical Anthropic, OpenAI, and Gemini envelopes. */
export function normalizeRequest(payload: unknown): NormalizedRequest {
	const messages: NormalizedMessage[] = [];
	const usedToolNames = new Set<string>();
	if (Array.isArray(payload)) {
		for (const item of payload) collectItem(item, undefined, messages, usedToolNames);
		return { messages, usedToolNames };
	}
	const envelope = asRecord(payload) as RequestEnvelope | undefined;
	if (!envelope) return { messages, usedToolNames };

	if (Array.isArray(envelope.messages)) {
		for (const item of envelope.messages) collectItem(item, undefined, messages, usedToolNames);
	}
	if (typeof envelope.input === "string") {
		collectItem(envelope.input, "user", messages, usedToolNames);
	} else if (Array.isArray(envelope.input)) {
		for (const item of envelope.input) collectItem(item, "user", messages, usedToolNames);
	}
	if (Array.isArray(envelope.contents)) {
		for (const item of envelope.contents) collectItem(item, undefined, messages, usedToolNames);
	}
	return { messages, usedToolNames };
}

/** Build the stable first-user + latest-user ranking query from normalized history. */
export function extractRequestQuery(request: NormalizedRequest, maxChars = 2000): string {
	if (maxChars <= 0) return "";
	const userTexts = request.messages.filter((message) => message.role === "user").map((message) => message.text);
	if (userTexts.length === 0) return "";
	const first = userTexts[0];
	const last = userTexts[userTexts.length - 1];
	if (first === last) return first.slice(0, maxChars);
	if (last.length + 1 >= maxChars) return last.slice(-maxChars);
	return `${first.slice(0, maxChars - last.length - 1)}\n${last}`;
}
