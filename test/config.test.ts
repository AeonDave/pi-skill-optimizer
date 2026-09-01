import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_CONFIG,
  defaultConfigJson,
  ensureGlobalConfigTemplate,
  getConfig,
  getOutputConfig,
  getUsageConfig,
  isOptimizerDisabled,
  isProviderEnabled,
  parseBoolean,
} from "../src/config.js";

test("AUTO defaults expose one strategy and conservative budgets", () => {
  assert.equal(DEFAULT_CONFIG.catalogBudgetChars, 8_000);
  assert.equal(DEFAULT_CONFIG.prefetchTarget, 5);
  assert.equal(DEFAULT_CONFIG.prefetchMin, 3);
  assert.equal(DEFAULT_CONFIG.prefetchMax, 8);
  assert.equal(DEFAULT_CONFIG.outputMode, "smart");
  assert.deepEqual(DEFAULT_CONFIG.outputTools, ["*"]);

  const serialized = defaultConfigJson();
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  for (const legacy of [
    "skillsMode",
    "skillMode",
    "tail",
    "toolsMode",
    "toolsTopK",
    "pinned",
    "compact",
    "hybrid",
  ]) {
    assert.equal(Object.hasOwn(parsed, legacy), false, legacy);
  }
});

test("configuration clamps AUTO bounds and ignores removed legacy keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "sko-config-"));
  const path = join(directory, "config.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        prefetchMin: 4,
        prefetchTarget: 999,
        prefetchMax: 7,
        catalogBudgetChars: 3_500,
        providers: ["Anthropic", "OPENAI", "anthropic"],
        alwaysSkills: ["alpha", "alpha", " beta "],
        toolsMode: "drop",
        skillMode: "hybrid",
      }),
    );
    const config = getConfig({}, path);
    assert.equal(config.catalogBudgetChars, 3_500);
    assert.equal(config.prefetchTarget, 7);
    assert.equal(config.prefetchMin, 4);
    assert.equal(config.prefetchMax, 7);
    assert.deepEqual(config.providers, ["anthropic", "openai"]);
    assert.deepEqual(config.alwaysSkills, ["alpha", "beta"]);
    assert.equal("toolsMode" in config, false);
    assert.equal("skillMode" in config, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("environment overrides use stable public names", () => {
  const config = getConfig(
    {
      PI_SKILL_OPTIMIZER_PREFETCH_MIN: "2",
      PI_SKILL_OPTIMIZER_PREFETCH_TARGET: "4",
      PI_SKILL_OPTIMIZER_PREFETCH_MAX: "6",
      PI_SKILL_OPTIMIZER_ALWAYS_SKILLS: "alpha,beta,alpha",
      PI_SKILL_OPTIMIZER_ALWAYS_TOOLS: "read, web ",
      PI_SKILL_OPTIMIZER_OUTPUT_MODE: "extract",
      PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO: "0.25",
      PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE: "image,audio",
      PI_SKILL_OPTIMIZER_OUTPUT_ARCHIVE_TTL_HOURS: "24",
      PI_SKILL_OPTIMIZER_USAGE_HALF_LIFE_DAYS: "45",
    },
    join(tmpdir(), "missing-sko-config.json"),
  );
  assert.equal(config.prefetchTarget, 4);
  assert.deepEqual(config.alwaysSkills, ["alpha", "beta"]);
  assert.deepEqual(config.alwaysTools, ["read", "web"]);
  assert.equal(config.outputMode, "extract");
  assert.equal(config.outputMinSavingsRatio, 0.25);
  assert.deepEqual(config.outputExtractExclude, ["image", "audio"]);
  assert.equal(getOutputConfig(config).archiveTtlMs, 24 * 60 * 60 * 1_000);
  assert.equal(getUsageConfig(config).halfLifeDays, 45);
});

test("disable flag has boolean rather than non-empty-string semantics", () => {
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("false"), false);
  assert.equal(parseBoolean("0"), false);
  assert.equal(parseBoolean("off"), false);
  assert.equal(parseBoolean("unexpected"), undefined);
  assert.equal(isOptimizerDisabled({ PI_SKILL_OPTIMIZER_DISABLE: "false" }), false);
  assert.equal(isOptimizerDisabled({ PI_SKILL_OPTIMIZER_DISABLE: "yes" }), true);
});

test("empty provider scope enables all providers", () => {
  assert.equal(isProviderEnabled({ providers: [] }, "anthropic"), true);
  assert.equal(isProviderEnabled({ providers: ["openai"] }, "openai"), true);
  assert.equal(isProviderEnabled({ providers: ["openai"] }, "anthropic"), false);
  assert.equal(isProviderEnabled({ providers: ["openai"] }, undefined), false);
});

test("global config template reports only an actual creation", () => {
  const directory = mkdtempSync(join(tmpdir(), "sko-agent-"));
  const environment = { PI_CODING_AGENT_DIR: directory };
  try {
    const created = ensureGlobalConfigTemplate(environment);
    assert.equal(typeof created, "string");
    assert.equal(ensureGlobalConfigTemplate(environment), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
