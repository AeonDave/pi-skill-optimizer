import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LunaThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LunaUsage {
	/** OpenAI input_tokens, reconstructed from Pi's mutually exclusive input buckets. */
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
}

export interface LunaResult {
	text: string;
	usage: LunaUsage;
}

export interface LunaCliArgsOptions {
	thinking: LunaThinking;
	systemFile: string;
	userFile: string;
}

export interface RunLunaOptions {
	systemPrompt: string;
	userPrompt: string;
	thinking?: LunaThinking;
	timeoutMs?: number;
	cwd?: string;
}

const THINKING_LEVELS = new Set<LunaThinking>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const BRIEF_SYSTEM_PROMPT = "Follow the complete system instructions in the appended local file.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizePrompt(value: string, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	const sanitized = value.replace(/\0/g, "\uFFFD").replace(/\r\n?/g, "\n");
	if (label === "userPrompt" && sanitized.trim().length === 0) {
		throw new Error("userPrompt must not be empty");
	}
	return sanitized;
}

function assistantText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part): part is Record<string, unknown> => isRecord(part))
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("\n");
	}
	return typeof message.text === "string" ? message.text : "";
}

function normalizedUsage(message: Record<string, unknown>): LunaUsage {
	if (!isRecord(message.usage)) throw new Error("Final Luna message did not contain usage data");
	const input = nonNegativeNumber(message.usage.input);
	const output = nonNegativeNumber(message.usage.output);
	if (input === undefined || output === undefined) {
		throw new Error("Final Luna message contained invalid input/output usage data");
	}
	const cacheRead = nonNegativeNumber(message.usage.cacheRead) ?? 0;
	const cacheWrite = nonNegativeNumber(message.usage.cacheWrite) ?? 0;
	const reasoning = nonNegativeNumber(message.usage.reasoning) ?? 0;
	const inputTokens = input + cacheRead + cacheWrite;
	return {
		inputTokens,
		outputTokens: output,
		totalTokens: nonNegativeNumber(message.usage.totalTokens) ?? inputTokens + output,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
		reasoningTokens: reasoning,
	};
}

export function parsePiJsonl(stdout: string): LunaResult {
	let lastAssistant: Record<string, unknown> | undefined;
	let malformedLines = 0;
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			malformedLines += 1;
			continue;
		}
		if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) continue;
		if (event.message.role === "assistant") lastAssistant = event.message;
	}
	if (!lastAssistant) {
		const suffix = malformedLines ? ` (${malformedLines} non-JSON line(s) ignored)` : "";
		throw new Error(`Pi JSONL did not contain a finalized assistant message${suffix}`);
	}
	return {
		text: assistantText(lastAssistant),
		usage: normalizedUsage(lastAssistant),
	};
}

export function buildLunaArgs(options: LunaCliArgsOptions): string[] {
	if (!THINKING_LEVELS.has(options.thinking)) {
		throw new Error(`Unsupported Luna thinking level: ${String(options.thinking)}`);
	}
	if (!options.systemFile || !options.userFile) throw new Error("Luna prompt file paths are required");
	return [
		"proxy",
		"pi",
		"--offline",
		"--model",
		`openai-codex/gpt-5.6-luna:${options.thinking}`,
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--system-prompt",
		BRIEF_SYSTEM_PROMPT,
		"--append-system-prompt",
		options.systemFile,
		`@${options.userFile}`,
		"Process the attached user request.",
	];
}

function privateWrite(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
	if (process.platform !== "win32") chmodSync(path, 0o600);
}

function safeDiagnostic(stderr: string): string {
	const redacted = stderr
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/(bearer\s+)[^\s]+/gi, "$1[redacted]")
		.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s]+/gi, "$1[redacted]")
		.trim();
	return redacted.length > 1_200 ? `${redacted.slice(0, 1_200)}...` : redacted;
}

function executeLuna(args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"rtk",
			[...args],
			{
				cwd,
				encoding: "utf8",
				maxBuffer: MAX_OUTPUT_BYTES,
				timeout: timeoutMs,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve(stdout);
					return;
				}
				const details = error as Error & { code?: string | number; killed?: boolean };
				if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					reject(new Error(`Luna CLI output exceeded ${MAX_OUTPUT_BYTES} bytes`));
					return;
				}
				if (details.killed) {
					reject(new Error(`Luna CLI timed out after ${timeoutMs} ms`));
					return;
				}
				const diagnostic = safeDiagnostic(stderr);
				const code = details.code === undefined ? "unknown" : String(details.code);
				reject(new Error(`Luna CLI failed with exit code ${code}${diagnostic ? `: ${diagnostic}` : ""}`));
			},
		);
		child.stdin?.end();
	});
}

export async function runLuna(options: RunLunaOptions): Promise<LunaResult> {
	const thinking = options.thinking ?? "low";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("timeoutMs must be a positive safe integer");
	}

	const systemPrompt = sanitizePrompt(options.systemPrompt, "systemPrompt");
	const userPrompt = sanitizePrompt(options.userPrompt, "userPrompt");
	const cwd = options.cwd ?? process.cwd();
	const directory = mkdtempSync(join(cwd, ".pi-skill-optimizer.luna-"));
	try {
		if (process.platform !== "win32") chmodSync(directory, 0o700);
		const systemFile = join(directory, "system.md");
		const userFile = join(directory, "user.md");
		privateWrite(systemFile, systemPrompt);
		privateWrite(userFile, userPrompt);
		const stdout = await executeLuna(
			buildLunaArgs({ thinking, systemFile, userFile }),
			cwd,
			timeoutMs,
		);
		try {
			return parsePiJsonl(stdout);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Luna CLI returned unusable JSONL: ${message}`);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
