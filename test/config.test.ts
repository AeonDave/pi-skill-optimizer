import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, defaultConfigJson, getConfig, getConfigPaths, getOutputConfig, getProfilePaths, getUsageConfig, getUsageFilePath, isDisabled } from "../src/config.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("safe defaults: hybrid, topK 20, name-only tail", () => {
	assert.equal(DEFAULTS.topK, 20);
	assert.equal(DEFAULTS.mode, "hybrid");
	assert.equal(DEFAULTS.tail, "name");
	assert.equal(DEFAULTS.fullRenderBudgetChars, 12_000);

	const saved = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_SKILL_OPTIMIZER_TOP_K: process.env.PI_SKILL_OPTIMIZER_TOP_K,
		PI_SKILL_OPTIMIZER_TAIL: process.env.PI_SKILL_OPTIMIZER_TAIL,
		PI_SKILL_OPTIMIZER_MODE: process.env.PI_SKILL_OPTIMIZER_MODE,
		PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS: process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS,
	};
	const agentDir = mkdtempSync(join(tmpdir(), "sko-default-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SKILL_OPTIMIZER_TOP_K;
	delete process.env.PI_SKILL_OPTIMIZER_TAIL;
	delete process.env.PI_SKILL_OPTIMIZER_MODE;
	delete process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS;
	try {
		const config = getConfig("/nonexistent/cwd");
		assert.equal(config.topK, 20);
		assert.equal(config.mode, "hybrid");
		assert.equal(config.tail, "name");
		assert.equal(config.fullRenderBudgetChars, 12_000);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("disable env parses explicit false values and overrides file config", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "sko-disable-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "sko-disable-cwd-"));
	const projectDir = join(cwd, CONFIG_DIR_NAME, "skill-optimizer");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(getConfigPaths(cwd).project, JSON.stringify({ disable: true }), "utf8");
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	const savedDisable = process.env.PI_SKILL_OPTIMIZER_DISABLE;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		for (const value of ["false", "0", "off", "no"]) {
			process.env.PI_SKILL_OPTIMIZER_DISABLE = value;
			assert.equal(isDisabled(cwd), false);
		}
		process.env.PI_SKILL_OPTIMIZER_DISABLE = "true";
		assert.equal(isDisabled(cwd), true);
	} finally {
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
		if (savedDisable === undefined) delete process.env.PI_SKILL_OPTIMIZER_DISABLE; else process.env.PI_SKILL_OPTIMIZER_DISABLE = savedDisable;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("profile/usage paths split into global agent dir and project .pi dir", () => {
	const savedProfile = process.env.PI_SKILL_OPTIMIZER_PROFILE;
	const savedUsage = process.env.PI_SKILL_OPTIMIZER_USAGE;
	delete process.env.PI_SKILL_OPTIMIZER_PROFILE;
	delete process.env.PI_SKILL_OPTIMIZER_USAGE;
	try {
		const cwd = join("D:", "Projects", "demo");
		const globalDir = join(getAgentDir(), "skill-optimizer");
		const projectDir = join(cwd, CONFIG_DIR_NAME, "skill-optimizer");

		const profile = getProfilePaths(cwd);
		assert.equal(profile.global, join(globalDir, "profile.json"));
		assert.equal(profile.project, join(projectDir, "profile.json"));

		// usage is global-only (project skills don't get a separate usage file)
		assert.equal(getUsageFilePath(cwd), join(globalDir, "usage.json"));
	} finally {
		if (savedProfile === undefined) delete process.env.PI_SKILL_OPTIMIZER_PROFILE;
		else process.env.PI_SKILL_OPTIMIZER_PROFILE = savedProfile;
		if (savedUsage === undefined) delete process.env.PI_SKILL_OPTIMIZER_USAGE;
		else process.env.PI_SKILL_OPTIMIZER_USAGE = savedUsage;
	}
});

test("explicit PI_SKILL_OPTIMIZER_PROFILE collapses both paths onto one file", () => {
	const saved = process.env.PI_SKILL_OPTIMIZER_PROFILE;
	process.env.PI_SKILL_OPTIMIZER_PROFILE = join("D:", "custom", "p.json");
	try {
		const paths = getProfilePaths(join("D:", "any"));
		assert.equal(paths.global, join("D:", "custom", "p.json"));
		assert.equal(paths.project, paths.global);
	} finally {
		if (saved === undefined) delete process.env.PI_SKILL_OPTIMIZER_PROFILE;
		else process.env.PI_SKILL_OPTIMIZER_PROFILE = saved;
	}
});

test("config.json: project overrides global, env overrides both", () => {
	const cwd = mkdtempSync(join(tmpdir(), "sko-cfg-"));
	const projectDir = join(cwd, CONFIG_DIR_NAME, "skill-optimizer");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(getConfigPaths(cwd).project, JSON.stringify({ mode: "compact", tail: "intent", disable: true }), "utf8");

	const savedMode = process.env.PI_SKILL_OPTIMIZER_MODE;
	delete process.env.PI_SKILL_OPTIMIZER_MODE;
	try {
		// project config.json beats global/defaults
		let cfg = getConfig(cwd);
		assert.equal(cfg.mode, "compact");
		assert.equal(cfg.tail, "intent");
		assert.equal(isDisabled(cwd), true);

		// env beats config.json
		process.env.PI_SKILL_OPTIMIZER_MODE = "hybrid";
		cfg = getConfig(cwd);
		assert.equal(cfg.mode, "hybrid");
	} finally {
		if (savedMode === undefined) delete process.env.PI_SKILL_OPTIMIZER_MODE;
		else process.env.PI_SKILL_OPTIMIZER_MODE = savedMode;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("output reduction defaults to smart-on, overridable via config/env", () => {
	// Isolate the agent dir so the developer's real global config.json is not read.
	const agentDir = mkdtempSync(join(tmpdir(), "sko-agent-"));
	const saved = {
		dir: process.env.PI_CODING_AGENT_DIR,
		m: process.env.PI_SKILL_OPTIMIZER_OUTPUT,
		l: process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES,
		t: process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS,
		e: process.env.PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE,
		r: process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK;
	const cwd = mkdtempSync(join(tmpdir(), "sko-cwd-"));
	try {
		const def = getOutputConfig(cwd);
		assert.equal(def.mode, "smart"); // default ON (deterministic, free)
		assert.deepEqual(def.tools, ["bash"]);
		assert.equal(def.maxLines, 400);
		assert.equal(def.model, ""); // empty -> selected model
		assert.ok(def.extractExclude.includes("cat")); // pure-dump default excluded from extract
		assert.equal(def.disableWithRtk, true); // auto-coexist with rtk by default
		process.env.PI_SKILL_OPTIMIZER_OUTPUT = "off";
		assert.equal(getOutputConfig(cwd).mode, "off");
		process.env.PI_SKILL_OPTIMIZER_OUTPUT = "extract";
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS = '["bash","hypa_shell"]';
		const on = getOutputConfig(cwd);
		assert.equal(on.mode, "extract");
		assert.deepEqual(on.tools, ["bash", "hypa_shell"]);
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS = "[]";
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE = "[]";
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK = "invalid";
		const explicitEmpty = getOutputConfig(cwd);
		assert.deepEqual(explicitEmpty.tools, []);
		assert.deepEqual(explicitEmpty.extractExclude, []);
		assert.equal(explicitEmpty.disableWithRtk, true); // invalid env falls back to the safe default
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK = "false";
		assert.equal(getOutputConfig(cwd).disableWithRtk, false);
	} finally {
		if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
		if (saved.m === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT; else process.env.PI_SKILL_OPTIMIZER_OUTPUT = saved.m;
		if (saved.l === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES; else process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES = saved.l;
		if (saved.t === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS; else process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS = saved.t;
		if (saved.e === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE; else process.env.PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE = saved.e;
		if (saved.r === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK; else process.env.PI_SKILL_OPTIMIZER_OUTPUT_DISABLE_WITH_RTK = saved.r;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("defaultConfigJson is valid JSON carrying the safe defaults", () => {
	const parsed = JSON.parse(defaultConfigJson());
	assert.equal(parsed.mode, DEFAULTS.mode);
	assert.equal(parsed.topK, DEFAULTS.topK);
	assert.equal(parsed.tail, DEFAULTS.tail);
	assert.equal(parsed.fullRenderBudgetChars, DEFAULTS.fullRenderBudgetChars);
	assert.equal(parsed.disable, false);
	assert.deepEqual(parsed.alwaysFull, []);
	assert.deepEqual(parsed.never, []);
	assert.equal(parsed.outputMode, "smart");
	assert.deepEqual(parsed.outputTools, ["bash"]);
	assert.equal(parsed.outputModel, "");
	assert.ok(Array.isArray(parsed.outputExtractExclude));
	assert.equal(parsed.outputMinSavingsBytes, DEFAULTS.outputMinSavingsBytes);
	assert.equal(parsed.outputMinSavingsRatio, DEFAULTS.outputMinSavingsRatio);
	assert.equal(parsed.usageMaxEntries, DEFAULTS.usageMaxEntries);
	assert.equal(parsed.usageStaleDays, DEFAULTS.usageStaleDays);
});

test("output benefit and usage retention settings parse env safely", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "sko-policy-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "sko-policy-cwd-"));
	const names = [
		"PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_BYTES",
		"PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO",
		"PI_SKILL_OPTIMIZER_USAGE_MAX_ENTRIES",
		"PI_SKILL_OPTIMIZER_USAGE_STALE_DAYS",
	] as const;
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of names) delete process.env[name];
	try {
		assert.equal(getOutputConfig(cwd).minSavingsBytes, 512);
		assert.equal(getOutputConfig(cwd).minSavingsRatio, 0.1);
		assert.deepEqual(getUsageConfig(cwd), { maxEntries: 2_048, staleDays: 180 });
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_BYTES = "900";
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO = "0.25";
		process.env.PI_SKILL_OPTIMIZER_USAGE_MAX_ENTRIES = "64";
		process.env.PI_SKILL_OPTIMIZER_USAGE_STALE_DAYS = "30";
		assert.equal(getOutputConfig(cwd).minSavingsBytes, 900);
		assert.equal(getOutputConfig(cwd).minSavingsRatio, 0.25);
		assert.deepEqual(getUsageConfig(cwd), { maxEntries: 64, staleDays: 30 });
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO = "1.5";
		process.env.PI_SKILL_OPTIMIZER_USAGE_MAX_ENTRIES = "-1";
		assert.equal(getOutputConfig(cwd).minSavingsRatio, DEFAULTS.outputMinSavingsRatio);
		assert.equal(getUsageConfig(cwd).maxEntries, DEFAULTS.usageMaxEntries);
	} finally {
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
		for (const name of names) {
			const value = saved[name];
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("full-render budget resolves file and env values, supports zero, and rejects invalid values", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "sko-budget-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "sko-budget-cwd-"));
	const invalidCwd = mkdtempSync(join(tmpdir(), "sko-budget-invalid-cwd-"));
	const savedDir = process.env.PI_CODING_AGENT_DIR;
	const savedBudget = process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS;
	for (const [dir, value] of [[cwd, 321], [invalidCwd, -1]] as const) {
		const stateDir = join(dir, CONFIG_DIR_NAME, "skill-optimizer");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(getConfigPaths(dir).project, JSON.stringify({ fullRenderBudgetChars: value }), "utf8");
	}
	try {
		assert.equal(getConfig(cwd).fullRenderBudgetChars, 321);
		process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS = "777";
		assert.equal(getConfig(cwd).fullRenderBudgetChars, 777);
		process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS = "0";
		assert.equal(getConfig(cwd).fullRenderBudgetChars, 0);
		process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS = "invalid";
		assert.equal(getConfig(invalidCwd).fullRenderBudgetChars, DEFAULTS.fullRenderBudgetChars);
	} finally {
		if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedDir;
		if (savedBudget === undefined) delete process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS;
		else process.env.PI_SKILL_OPTIMIZER_FULL_RENDER_BUDGET_CHARS = savedBudget;
		for (const dir of [agentDir, cwd, invalidCwd]) rmSync(dir, { recursive: true, force: true });
	}
});
