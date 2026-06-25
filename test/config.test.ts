import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, defaultConfigJson, getConfig, getConfigPaths, getOutputConfig, getProfilePaths, getUsageFilePath, isDisabled } from "../src/config.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("safe defaults: hybrid, topK 20, name-only tail", () => {
	assert.equal(DEFAULTS.topK, 20);
	assert.equal(DEFAULTS.mode, "hybrid");
	assert.equal(DEFAULTS.tail, "name");

	const saved = {
		PI_SKILL_OPTIMIZER_TOP_K: process.env.PI_SKILL_OPTIMIZER_TOP_K,
		PI_SKILL_OPTIMIZER_TAIL: process.env.PI_SKILL_OPTIMIZER_TAIL,
		PI_SKILL_OPTIMIZER_MODE: process.env.PI_SKILL_OPTIMIZER_MODE,
	};
	delete process.env.PI_SKILL_OPTIMIZER_TOP_K;
	delete process.env.PI_SKILL_OPTIMIZER_TAIL;
	delete process.env.PI_SKILL_OPTIMIZER_MODE;
	try {
		const config = getConfig("/nonexistent/cwd");
		assert.equal(config.topK, 20);
		assert.equal(config.mode, "hybrid");
		assert.equal(config.tail, "name");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
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
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES;
	delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS;
	const cwd = mkdtempSync(join(tmpdir(), "sko-cwd-"));
	try {
		const def = getOutputConfig(cwd);
		assert.equal(def.mode, "smart"); // default ON (deterministic, free)
		assert.deepEqual(def.tools, ["bash"]);
		assert.equal(def.maxLines, 400);
		assert.equal(def.model, ""); // empty -> selected model
		assert.ok(def.extractExclude.includes("cat")); // pure-dump default excluded from extract
		process.env.PI_SKILL_OPTIMIZER_OUTPUT = "off";
		assert.equal(getOutputConfig(cwd).mode, "off");
		process.env.PI_SKILL_OPTIMIZER_OUTPUT = "extract";
		process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS = '["bash","hypa_shell"]';
		const on = getOutputConfig(cwd);
		assert.equal(on.mode, "extract");
		assert.deepEqual(on.tools, ["bash", "hypa_shell"]);
	} finally {
		if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
		if (saved.m === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT; else process.env.PI_SKILL_OPTIMIZER_OUTPUT = saved.m;
		if (saved.l === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES; else process.env.PI_SKILL_OPTIMIZER_OUTPUT_MAX_LINES = saved.l;
		if (saved.t === undefined) delete process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS; else process.env.PI_SKILL_OPTIMIZER_OUTPUT_TOOLS = saved.t;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("defaultConfigJson is valid JSON carrying the safe defaults", () => {
	const parsed = JSON.parse(defaultConfigJson());
	assert.equal(parsed.mode, DEFAULTS.mode);
	assert.equal(parsed.topK, DEFAULTS.topK);
	assert.equal(parsed.tail, DEFAULTS.tail);
	assert.equal(parsed.disable, false);
	assert.deepEqual(parsed.alwaysFull, []);
	assert.deepEqual(parsed.never, []);
	assert.equal(parsed.outputMode, "smart");
	assert.deepEqual(parsed.outputTools, ["bash"]);
	assert.equal(parsed.outputModel, "");
	assert.ok(Array.isArray(parsed.outputExtractExclude));
});
