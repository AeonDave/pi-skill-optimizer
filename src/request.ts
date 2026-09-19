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
	context?: unknown;
}

const TEXT_MESSAGE_ROLES = new Set(["user", "assistant"]);
const TEXT_BLOCK_TYPES = new Set(["text", "input_text", "output_text", "message"]);
const NON_HUMAN_BLOCK_TYPES = new Set([
	"tool_result",
	"tool_output",
	"function_call",
	"function_call_output",
	"function_response",
	"computer_call_output",
	"item_reference",
	"context",
	"context_reference",
]);

const INJECTED_CONTEXT_PREFIXES = [
	"context-mode active.",
	"[pi-persona] identity data",
	"[pi-persona] first action:",
	"[pi-persona] session clock",
	"current clock:",
] as const;

/** Synthetic extension messages are transport context, not user intent. */
function isInjectedContextText(value: string): boolean {
	const normalized = value.trimStart().toLowerCase();
	return INJECTED_CONTEXT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
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

function appendText(value: string, text: string[], allowText: boolean): void {
	if (allowText && value.trim() && !isInjectedContextText(value)) text.push(value);
}

function isNonHumanContentRecord(record: Record<string, unknown>, type?: string): boolean {
	const isToolPayload = type !== undefined && (
		NON_HUMAN_BLOCK_TYPES.has(type)
		|| type.endsWith("_call_output")
		|| type.endsWith("_tool_result")
		|| type.endsWith("_tool_output")
	);
	return isToolPayload
		|| record.functionResponse !== undefined
		|| record.function_response !== undefined
		|| record.toolResult !== undefined
		|| record.tool_result !== undefined;
}

function collectContent(value: unknown, text: string[], used: Set<string>, allowText: boolean): void {
	if (typeof value === "string") {
		appendText(value, text, allowText);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectContent(item, text, used, allowText);
		return;
	}
	const record = asRecord(value);
	if (!record) return;
	collectToolCalls(record, used);

	const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
	if (isNonHumanContentRecord(record, type)) return;

	// Typed provider blocks are allowlisted. An untyped `{ text }` is the
	// canonical Gemini text part; message wrappers may contain content/parts.
	if ((type === undefined || TEXT_BLOCK_TYPES.has(type)) && typeof record.text === "string") {
		appendText(record.text, text, allowText);
	}
	if (type === undefined || type === "message") {
		if (record.content !== undefined) collectContent(record.content, text, used, allowText);
		if (record.parts !== undefined) collectContent(record.parts, text, used, allowText);
	}
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
	const role = normalizeRole(record.role, fallbackRole);
	const allowText = role !== undefined && TEXT_MESSAGE_ROLES.has(role);
	if (record.content !== undefined) collectContent(record.content, fragments, usedToolNames, allowText);
	if (record.parts !== undefined) collectContent(record.parts, fragments, usedToolNames, allowText);
	if (record.content === undefined && record.parts === undefined && typeof record.text === "string") {
		appendText(record.text, fragments, allowText);
	}
	const text = fragments.join(" ");
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
	if (envelope.context !== undefined) {
		const nested = normalizeRequest(envelope.context);
		messages.push(...nested.messages);
		for (const name of nested.usedToolNames) usedToolNames.add(name);
	}
	return { messages, usedToolNames };
}

/** Build the routing query from the latest genuine human turn only. */
export function extractRequestQuery(request: NormalizedRequest, maxChars = 2000): string {
	if (maxChars <= 0) return "";
	for (let index = request.messages.length - 1; index >= 0; index--) {
		const message = request.messages[index];
		if (message.role === "user" && !isInjectedContextText(message.text)) return message.text.slice(0, maxChars);
	}
	return "";
}

function containsMarker(value: unknown, marker: string, seen = new WeakSet<object>()): boolean {
	if (typeof value === "string") return value.includes(marker);
	if (!value || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => containsMarker(item, marker, seen));
	return Object.values(value as Record<string, unknown>).some((item) => containsMarker(item, marker, seen));
}

function appendedText(value: string, appendix: string, marker?: string): string | undefined {
	if (!value.trim() || isInjectedContextText(value) || (marker && value.includes(marker))) return undefined;
	const addition = marker && !appendix.includes(marker) ? `${marker}\n${appendix}` : appendix;
	return `${value}${value.endsWith("\n") ? "" : "\n"}${addition}`;
}

function appendToContent(value: unknown, appendix: string, marker?: string): unknown | undefined {
	if (typeof value === "string") return appendedText(value, appendix, marker);
	if (Array.isArray(value)) {
		for (let i = value.length - 1; i >= 0; i--) {
			const updated = appendToContent(value[i], appendix, marker);
			if (updated === undefined) continue;
			const next = value.slice();
			next[i] = updated;
			return next;
		}
		return undefined;
	}
	const record = asRecord(value);
	if (!record) return undefined;
	const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
	if (isNonHumanContentRecord(record, type)) return undefined;
	if (type !== undefined && type !== "text" && type !== "input_text") return undefined;
	if (typeof record.text !== "string") return undefined;
	const text = appendedText(record.text, appendix, marker);
	return text === undefined ? undefined : { ...record, text };
}

function appendToMessage(value: unknown, fallbackRole: string | undefined, appendix: string, marker?: string): unknown | undefined {
	if (typeof value === "string") {
		return fallbackRole === "user" ? appendedText(value, appendix, marker) : undefined;
	}
	const record = asRecord(value);
	if (!record) return undefined;
	const role = normalizeRole(record.role, fallbackRole);
	if (role !== "user") return undefined;
	const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
	if (isNonHumanContentRecord(record, type)) return undefined;
	for (const key of ["parts", "content"] as const) {
		if (record[key] === undefined) continue;
		const updated = appendToContent(record[key], appendix, marker);
		if (updated !== undefined) return { ...record, [key]: updated };
	}
	if (typeof record.text === "string") {
		const text = appendedText(record.text, appendix, marker);
		if (text !== undefined) return { ...record, text };
	}
	return undefined;
}

function appendToItems(items: readonly unknown[], fallbackRole: string | undefined, appendix: string, marker?: string): unknown[] | undefined {
	for (let i = items.length - 1; i >= 0; i--) {
		const updated = appendToMessage(items[i], fallbackRole, appendix, marker);
		if (updated === undefined) continue;
		const next = items.slice();
		next[i] = updated;
		return next;
	}
	return undefined;
}

/**
 * Append a cache-stable overlay to the latest genuine human text across canonical
 * Anthropic, OpenAI Chat/Responses, Gemini, and Mistral request shapes. Only the
 * path to the target text is cloned. Tool outputs and injected context are never
 * targets. Returns the original reference when no target exists or marker is present.
 */
export function appendToLatestHumanInput(payload: unknown, appendix: string, marker?: string): unknown {
	if (!appendix || (marker && containsMarker(payload, marker))) return payload;
	if (Array.isArray(payload)) return appendToItems(payload, undefined, appendix, marker) ?? payload;
	const envelope = asRecord(payload);
	if (!envelope) return payload;

	if (Array.isArray(envelope.contents)) {
		const contents = appendToItems(envelope.contents, undefined, appendix, marker);
		if (contents) return { ...envelope, contents };
	}
	if (Array.isArray(envelope.input)) {
		const input = appendToItems(envelope.input, "user", appendix, marker);
		if (input) return { ...envelope, input };
	} else if (typeof envelope.input === "string") {
		const input = appendedText(envelope.input, appendix, marker);
		if (input !== undefined) return { ...envelope, input };
	}
	if (Array.isArray(envelope.messages)) {
		const messages = appendToItems(envelope.messages, undefined, appendix, marker);
		if (messages) return { ...envelope, messages };
	}
	if (envelope.context !== undefined) {
		const context = appendToLatestHumanInput(envelope.context, appendix, marker);
		if (context !== envelope.context) return { ...envelope, context };
	}
	return payload;
}
