import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;

const PACKAGE_NAME = "@aeondave/pi-skill-optimizer";
const TOOL_SEARCH = "optimizer_tool_search";
const DEFERRED_TOOL = "mcp__issues__find";
const SKILL_NAME = "issue-triage";
const SKILL_CONTENT = "---\nname: issue-triage\ndescription: Use when triaging issue severity, reproducing defects, and checking safe fixes.\n---\n\n# Issue triage\n\nCheck severity, reproduce the defect, and record the smallest safe fix.\n";
const TIMEOUT_MS = 30_000;

function packageRootFromArgs(): string {
	const argument = process.argv[2] ?? process.env.PI_SKILL_OPTIMIZER_TEST_PACKAGE;
	if (!argument) {
		throw new Error("Usage: node --import tsx scripts/black-box-smoke.ts <absolute-unpacked-package-root> [expected-pi-version]");
	}
	if (!isAbsolute(argument)) throw new Error("Package root must be an absolute path.");
	const root = realpathSync(argument);
	const manifestPath = join(root, "package.json");
	assert.ok(existsSync(manifestPath), `No package.json in ${root}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Json;
	assert.equal(manifest.name, PACKAGE_NAME, "package root must be pi-skill-optimizer");
	assert.ok(existsSync(join(root, "src", "index.ts")), "packed extension entrypoint is missing");
	assert.equal(existsSync(join(root, "node_modules")), false, "packed artifact must not contain node_modules");
	return root;
}

function cleanupOwnedTemp(root: string): void {
	const resolvedRoot = resolve(root);
	const resolvedTemp = resolve(tmpdir());
	if (dirname(resolvedRoot) !== resolvedTemp || !resolvedRoot.split(sep).at(-1)?.startsWith("sko-blackbox-")) {
		throw new Error(`Refusing to remove unexpected temporary path: ${resolvedRoot}`);
	}
	rmSync(resolvedRoot, { recursive: true, force: true });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function respondOpenAiStream(res: ServerResponse, completion: Json): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const choice = completion.choices[0];
	const message = choice.message;
	const deltas: Json[] = [];
	if (message.tool_calls) {
		deltas.push({ role: "assistant", tool_calls: message.tool_calls.map((call: Json, index: number) => ({
			index,
			id: call.id,
			type: call.type,
			function: call.function,
		})) });
	} else {
		deltas.push({ role: "assistant", content: message.content ?? "" });
	}
	for (const delta of deltas) {
		res.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	}
	res.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\n`);
	res.end("data: [DONE]\n\n");
}

async function readBody(req: IncomingMessage): Promise<Json> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return JSON.parse(body) as Json;
}

function toolNames(request: Json): string[] {
	return (request.tools ?? []).map((tool: Json) => tool.function?.name).filter((name: unknown): name is string => typeof name === "string");
}

function callResponse(name: string, args: Json, id: string): Json {
	return {
		id: `blackbox-${id}`,
		object: "chat.completion",
		created: 1,
		model: "fixture",
		choices: [{
			index: 0,
			finish_reason: "tool_calls",
			message: {
				role: "assistant",
				content: null,
				tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
			},
		}],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function textResponse(text: string, id: string): Json {
	return {
		id: `blackbox-${id}`,
		object: "chat.completion",
		created: 1,
		model: "fixture",
		choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function getToolResult(request: Json, toolName: string): string | undefined {
	const messages: Json[] = request.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
		const matchingCall = messages.slice(0, index).some((previous) => previous.role === "assistant"
			&& (previous.tool_calls ?? []).some((call: Json) => call.id === message.tool_call_id
				&& call.function?.name === toolName));
		if (matchingCall && typeof message.content === "string") return message.content;
	}
	return undefined;
}

function resolvePiCommand(): { command: string; prefixArgs: string[] } {
	const configured = process.env.PI_CLI;
	if (configured) {
		if (configured.toLowerCase().endsWith(".js")) return { command: process.execPath, prefixArgs: [configured] };
		if (process.platform === "win32" && configured.toLowerCase().endsWith(".cmd")) {
			throw new Error("On Windows, PI_CLI must point to Pi's cli.js entrypoint.");
		}
		return { command: configured, prefixArgs: [] };
	}
	const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const cliPath = join(dirname(packageEntry), "bundle", "cli.js");
	assert.ok(existsSync(cliPath), `Pi CLI entrypoint missing: ${cliPath}`);
	return { command: process.execPath, prefixArgs: [cliPath] };
}

async function main(): Promise<void> {
	const packageRoot = packageRootFromArgs();
	const piCommand = resolvePiCommand();
	const piVersion = execFileSync(piCommand.command, [...piCommand.prefixArgs, "--version"], { encoding: "utf8" }).trim();
	const developmentManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Json;
	const expectedPiVersion = process.argv[3]
		?? developmentManifest.devDependencies["@earendil-works/pi-coding-agent"].replace(/^\^/, "");
	assert.match(expectedPiVersion, /^\d+\.\d+\.\d+$/, "expected Pi version must be an exact release");
	assert.equal(piVersion, expectedPiVersion, `black-box smoke requires Pi ${expectedPiVersion}, found ${piVersion}`);
	const tempRoot = mkdtempSync(join(tmpdir(), "sko-blackbox-"));
	const agentDir = join(tempRoot, "agent");
	const workDir = join(tempRoot, "work");
	const skillDir = join(tempRoot, "skills", SKILL_NAME);
	const fixtureExtension = join(tempRoot, "deferred-fixture.ts");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(workDir, { recursive: true });
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), SKILL_CONTENT, "utf8");
	writeFileSync(fixtureExtension, `export default function (pi) {
	pi.registerTool({
		name: ${JSON.stringify(DEFERRED_TOOL)},
		label: "Find issue tracker tickets",
		description: "Find issue tracker tickets by status and severity",
		exposure: "deferred",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() { return { content: [{ type: "text", text: "fixture issue ticket found" }], details: {} }; },
	});
}`, "utf8");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: [packageRoot],
		extensions: [fixtureExtension],
		skills: [skillDir],
		defaultTools: ["read", "tool_search"],
		quietStartup: false,
	}, null, 2), "utf8");
	const serverState: { requests: Json[]; stage: number } = { requests: [], stage: 0 };
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
				respond(res, 404, { error: `unexpected endpoint ${req.method} ${req.url}` });
				return;
			}
			const request = await readBody(req);
			serverState.requests.push(request);
			const names = toolNames(request);
			const stage = serverState.stage++;
			let response: Json;
			switch (stage) {
				case 0:
					assert.ok(names.includes(TOOL_SEARCH), `${TOOL_SEARCH} absent from initial model tools`);
					assert.ok(names.includes("tool_search"), "Pi built-in tool_search absent; collision test is inconclusive");
					assert.ok(!names.includes(DEFERRED_TOOL), "deferred fixture tool was active before optimizer search");
					response = callResponse(TOOL_SEARCH, { query: "find issue tracker tickets" }, "optimizer-search-1");
					break;
				case 1:
					assert.ok(names.includes(DEFERRED_TOOL), `search did not activate deferred fixture tool; tools=${names.join(",")}; toolResults=${JSON.stringify(request.messages.filter((message: Json) => message.role === "tool" || message.role === "function"))}`);
					assert.ok(names.includes("tool_search"), "optimizer replanning removed Pi's built-in tool_search");
					assert.ok(JSON.parse(getToolResult(request, TOOL_SEARCH) ?? "{}")?.activated?.includes(DEFERRED_TOOL), "optimizer search result did not report fixture activation");
					response = callResponse(DEFERRED_TOOL, {}, "fixture-tool-1");
					break;
				case 2:
					assert.equal(getToolResult(request, DEFERRED_TOOL), "fixture issue ticket found", "fixture tool result missing from provider history");
					response = textResponse("deferred tool executed", "deferred-finished");
					break;
				case 3:
					assert.ok(names.includes("skill_search"), "skill_search absent from model tools");
					response = callResponse("skill_search", { action: "search", query: "triage issue severity reproduce defect" }, "skill-search-1");
					break;
				case 4:
					assert.ok((getToolResult(request, "skill_search") ?? "").includes(SKILL_NAME), "skill search result missing from provider history");
					response = callResponse("skill_search", { action: "load", name: SKILL_NAME }, "skill-load-1");
					break;
				case 5:
					assert.equal(getToolResult(request, "skill_search"), SKILL_CONTENT, "skill_search load did not return exact skill content");
					response = textResponse("skill loaded verbatim", "skill-finished");
					break;
				default:
					throw new Error(`Unexpected provider request ${stage}; refusing unplanned model work.`);
			}
			respondOpenAiStream(res, response);
		} catch (error) {
			console.error("Fake provider assertion failed:", error);
			respond(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		blackbox: {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			api: "openai-completions",
			apiKey: "local-test-only",
			models: [{
				id: "fixture",
				name: "Offline black-box fixture",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 16_000,
				maxTokens: 512,
			}],
		},
	} }, null, 2), "utf8");

	const piArgs = [
		"--mode", "rpc", "--no-session", "--no-context-files", "--no-prompt-templates", "--no-themes",
		"--provider", "blackbox", "--model", "fixture", "--skill", skillDir,
	];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		USERPROFILE: tempRoot,
		HOME: tempRoot,
		HOMEDRIVE: tempRoot.slice(0, 2),
		HOMEPATH: tempRoot.slice(2),
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SKILL_OPTIMIZER_")) delete env[key];
	}
	const child = spawn(piCommand.command, [...piCommand.prefixArgs, ...piArgs], {
		cwd: workDir,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	let stdoutBuffer = "";
	let stderr = "";
	const protocolRecords: Json[] = [];
	const eventRecords: Json[] = [];
	const pending = new Map<string, { resolve(value: Json): void; reject(error: Error): void }>();
	let nextId = 0;
	let childError: Error | undefined;
	child.once("error", (error) => { childError = error; });
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		for (;;) {
			const newline = stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			try {
				const record = JSON.parse(line) as Json;
				protocolRecords.push(record);
				if (record.type === "response" && typeof record.id === "string") {
					const waiter = pending.get(record.id);
					if (waiter) {
						pending.delete(record.id);
						record.success ? waiter.resolve(record) : waiter.reject(new Error(record.error ?? `RPC ${record.command} failed`));
					}
				} else {
					eventRecords.push(record);
				}
			} catch (error) {
				childError = new Error(`Pi emitted non-JSON RPC stdout: ${line.slice(0, 400)} (${String(error)})`);
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	child.on("exit", (code, signal) => {
		for (const [id, waiter] of pending) {
			pending.delete(id);
			waiter.reject(new Error(`Pi exited before RPC response (${signal ?? code})`));
		}
	});

	function commandRpc(type: string, fields: Json = {}): Promise<Json> {
		if (childError) return Promise.reject(childError);
		const id = `sko-${++nextId}`;
		return new Promise((resolveResponse, rejectResponse) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				rejectResponse(new Error(`Timed out waiting for RPC ${type}; stderr:\n${stderr}`));
			}, TIMEOUT_MS);
			pending.set(id, {
				resolve(value) { clearTimeout(timer); resolveResponse(value); },
				reject(error) { clearTimeout(timer); rejectResponse(error); },
			});
			child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
				if (error) {
					clearTimeout(timer);
					pending.delete(id);
					rejectResponse(error);
				}
			});
		});
	}

	async function waitForSettled(after: number): Promise<void> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < TIMEOUT_MS) {
			if (eventRecords.slice(after).some((event) => event.type === "agent_settled")) return;
			if (childError) throw childError;
			await delay(20);
		}
		throw new Error(`Timed out waiting for agent_settled; stderr:\n${stderr}`);
	}

	try {
		const state = await commandRpc("get_state");
		assert.equal(state.success, true);
		assert.equal(state.data.model?.provider, "blackbox");
		assert.equal(state.data.model?.id, "fixture");
		const startupWarnings = stderr + "\n" + JSON.stringify(protocolRecords);
		assert.ok(!startupWarnings.includes("built-in extension `tool-search` was not loaded"), "Pi replaced builtin tool-search during startup");

		let eventOffset = eventRecords.length;
		await commandRpc("prompt", { message: "Find issue tracker tickets and report the result." });
		await waitForSettled(eventOffset);
		let entries = await commandRpc("get_entries");
		const firstTurn = JSON.stringify(entries.data.entries);
		assert.ok(firstTurn.includes(DEFERRED_TOOL), "deferred fixture tool execution is absent from the session");
		assert.ok(firstTurn.includes("deferred tool executed"), "final model response after deferred tool is absent");

		eventOffset = eventRecords.length;
		await commandRpc("prompt", { message: "Search the issue triage skill, then load it exactly." });
		await waitForSettled(eventOffset);
		entries = await commandRpc("get_entries");
		const allEntries = JSON.stringify(entries.data.entries);
		assert.ok(allEntries.includes(SKILL_NAME), "skill search did not find the temporary skill");
		assert.ok(allEntries.includes("# Issue triage") && allEntries.includes("Check severity, reproduce the defect, and record the smallest safe fix."), "skill_search load content missing from the session");
		assert.ok(allEntries.includes("skill loaded verbatim"), "final response after skill load is absent");
		assert.equal(serverState.requests.length, 6, `expected exactly six local provider calls, got ${serverState.requests.length}`);
		assert.ok(eventRecords.some((event) => event.type === "tool_execution_start" && event.toolName === TOOL_SEARCH));
		assert.ok(eventRecords.some((event) => event.type === "tool_execution_start" && event.toolName === DEFERRED_TOOL));
		assert.ok(eventRecords.filter((event) => event.type === "agent_settled").length >= 2);
		console.log(JSON.stringify({
			result: "PASS",
			pi: piVersion,
			packageRoot,
			isolatedAgentDir: agentDir,
			localProviderRequests: serverState.requests.length,
			assertions: [
				"Pi CLI RPC loaded the unpacked package without package-local node_modules",
				"optimizer_tool_search and Pi builtin tool_search coexisted without replacement warning",
				"optimizer_tool_search activated and executed an initially deferred tool",
				"skill_search found a skill and loaded its exact verbatim content",
				"all model traffic terminated at the local fake provider",
			],
		}, null, 2));
	} catch (error) {
		console.error("Black-box smoke failed.");
		console.error(error);
		console.error("Pi stderr:", stderr);
		console.error("Pi protocol event types:", eventRecords.map((event) => event.type).join(","));
		console.error("Pi extension errors:", JSON.stringify(eventRecords.filter((event) => String(event.type).includes("extension") || String(event.type).includes("error"))));
		console.error("Provider requests:", serverState.requests.length);
		console.error("Provider call summaries:", JSON.stringify(serverState.requests.map((request) => ({ tools: toolNames(request), messages: (request.messages ?? []).slice(-4).map((message: Json) => ({ role: message.role, name: message.name, tool_call_id: message.tool_call_id, content: typeof message.content === "string" ? message.content.slice(0, 400) : undefined, tool_calls: message.tool_calls })) }))));
		throw error;
	} finally {
		const waitForExit = () => new Promise<void>((resolveExit) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
			child.once("exit", () => resolveExit());
		});
		if (child.exitCode === null && child.signalCode === null) {
			child.stdin.end();
			await Promise.race([waitForExit(), delay(5_000)]);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill();
				await Promise.race([waitForExit(), delay(5_000)]);
			}
		}
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		cleanupOwnedTemp(tempRoot);
	}
}

await main();
