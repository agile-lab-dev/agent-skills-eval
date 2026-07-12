import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../dist/index.js";

function cli(overrides = {}) {
  return { ...overrides };
}

function config(overrides = {}) {
  return { ...overrides };
}

function resolve(cliOpts = {}, configOpts = {}, positionalRoot = ".") {
  return resolveConfig(cli(cliOpts), config(configOpts), positionalRoot);
}

test("resolveConfig: CLI flag wins over config file (representative field per group)", () => {
  const resolved = resolve(
    {
      workspace: "./from-cli",
      reportTitle: "CLI Title",
      logFormat: "jsonl",
      opencodeAgent: "cli-agent",
      claudeCodeAgent: "cli-claude-agent",
    },
    {
      workspace: "./from-config",
      report: { title: "Config Title" },
      logging: { format: "pretty" },
      opencode: { agent: "config-agent" },
      claudeCode: { agent: "config-claude-agent" },
    },
  );

  assert.equal(resolved.workspace, "./from-cli");
  assert.equal(resolved.report.title, "CLI Title");
  assert.equal(resolved.logging.format, "jsonl");
  assert.equal(resolved.opencode.agent, "cli-agent");
  assert.equal(resolved.claudeCode.agent, "cli-claude-agent");
});

test("resolveConfig: config file wins when CLI flag is absent", () => {
  const resolved = resolve(
    {},
    {
      workspace: "./from-config",
      report: { title: "Config Title" },
      logging: { format: "jsonl" },
      opencode: { agent: "config-agent" },
      claudeCode: { agent: "config-claude-agent" },
    },
  );

  assert.equal(resolved.workspace, "./from-config");
  assert.equal(resolved.report.title, "Config Title");
  assert.equal(resolved.logging.format, "jsonl");
  assert.equal(resolved.opencode.agent, "config-agent");
  assert.equal(resolved.claudeCode.agent, "config-claude-agent");
});

test("resolveConfig: documented defaults apply when both CLI and config are absent", () => {
  const resolved = resolve({}, {});

  assert.equal(resolved.workspace, "./agent-skills-workspace");
  assert.equal(resolved.targetModel, "gpt-4o-mini");
  assert.equal(resolved.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(resolved.runMode, "api");
  assert.equal(resolved.concurrency, 4);
  assert.equal(resolved.layout, "iteration");
  assert.equal(resolved.strict, false);
  assert.equal(resolved.report.enabled, true);
  assert.equal(resolved.logging.format, "pretty");
  assert.equal(resolved.logging.verbose, false);
  assert.equal(resolved.logging.color, "auto");
  assert.equal(resolved.opencode.auto, false);
  assert.equal(resolved.opencode.timeoutMs, 5 * 60 * 1000);
  assert.equal(resolved.claudeCode.auto, false);
  assert.equal(resolved.claudeCode.timeoutMs, 5 * 60 * 1000);
});

test("resolveConfig: judgeModel falls back to the resolved targetModel, not a static default", () => {
  const withCliTarget = resolve({ target: "cli-model" }, {});
  assert.equal(withCliTarget.judgeModel, "cli-model");

  const withConfigTarget = resolve({}, { target: "config-model" });
  assert.equal(withConfigTarget.judgeModel, "config-model");
});

test("resolveConfig: opencode/claude-code judge timeouts fall back to the resolved (not raw) timeoutMs", () => {
  const fromCliTimeout = resolve({ opencodeTimeout: 12345, claudeCodeTimeout: 54321 }, {});
  assert.equal(fromCliTimeout.opencode.judgeTimeoutMs, 12345);
  assert.equal(fromCliTimeout.claudeCode.judgeTimeoutMs, 54321);

  const fromConfigTimeout = resolve(
    {},
    { opencode: { timeoutMs: 11111 }, claudeCode: { timeoutMs: 22222 } },
  );
  assert.equal(fromConfigTimeout.opencode.judgeTimeoutMs, 11111);
  assert.equal(fromConfigTimeout.claudeCode.judgeTimeoutMs, 22222);
});

test("resolveConfig: report union — boolean shorthand and object form both resolve", () => {
  const boolShorthand = resolve({}, { report: true });
  assert.equal(boolShorthand.report.enabled, true);
  assert.equal(boolShorthand.report.title, undefined);

  const objectForm = resolve({}, { report: { enabled: true, title: "x" } });
  assert.equal(objectForm.report.enabled, true);
  assert.equal(objectForm.report.title, "x");

  const disabledBoolShorthand = resolve({}, { report: false });
  assert.equal(disabledBoolShorthand.report.enabled, false);
});

test("resolveConfig: color bug regression — config.logging.color is not shadowed by an unset --color/--no-color flag", () => {
  const resolved = resolve({ color: undefined }, { logging: { color: false } });
  assert.equal(resolved.logging.color, false);

  const autoDefault = resolve({ color: undefined }, {});
  assert.equal(autoDefault.logging.color, "auto");

  const cliForcesColor = resolve({ color: true }, { logging: { color: false } });
  assert.equal(cliForcesColor.logging.color, true);

  const cliDisablesColor = resolve({ color: false }, { logging: { color: true } });
  assert.equal(cliDisablesColor.logging.color, false);
});

test("resolveConfig: include/exclude unset via CLI still pick up config.include/config.exclude", () => {
  const resolved = resolve(
    { include: undefined, exclude: undefined },
    { include: ["skills/**"], exclude: ["**/draft-*"] },
  );

  assert.deepEqual(resolved.include, ["skills/**"]);
  assert.deepEqual(resolved.exclude, ["**/draft-*"]);
});

test("resolveConfig: include/exclude from CLI win over config", () => {
  const resolved = resolve(
    { include: ["cli/**"], exclude: ["cli-exclude/**"] },
    { include: ["skills/**"], exclude: ["**/draft-*"] },
  );

  assert.deepEqual(resolved.include, ["cli/**"]);
  assert.deepEqual(resolved.exclude, ["cli-exclude/**"]);
});

test("resolveConfig: root special-case — non-'.' positional argument wins, otherwise config.root, otherwise '.'", () => {
  assert.equal(resolve({}, {}, "./explicit-root").root, "./explicit-root");
  assert.equal(resolve({}, { root: "./config-root" }, ".").root, "./config-root");
  assert.equal(resolve({}, {}, ".").root, ".");
});
