#!/usr/bin/env node
import { Command } from "commander";
import { loadConfigFile, resolveConfig, type CliOptions } from "./config.js";
import { consoleReporter } from "./console-reporter.js";
import { evaluateSkills } from "./evaluate-skills.js";
import { jsonlReporter, type JsonlReporter } from "./jsonl-reporter.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { OpencodeProvider } from "./opencode-provider.js";
import { ClaudeCodeProvider } from "./claude-code-provider.js";
import type { Provider } from "./provider.js";
import { installSignalHandlers, registerShutdownHook } from "./shutdown.js";

function list(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseNumber(value: string): number {
  return Number.parseInt(value, 10);
}

function requireApiCredentials(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  apiKeyEnv: string
): { baseUrl: string; apiKey: string } {
  if (!baseUrl) throw new Error("provide --base-url or set OPENAI_BASE_URL");
  if (!apiKey) throw new Error(`environment variable ${apiKeyEnv} is not set`);
  return { baseUrl, apiKey };
}

async function main(): Promise<void> {
  installSignalHandlers();

  const program = new Command();
  program
    .name("agent-skills-eval")
    .description("Evaluate agentskills.io-style skills and write portable benchmark artifacts")
    .argument("[root]", "Directory to scan for SKILL.md files", ".")
    .option("--config <path>", "YAML or JSON config file")
    .option("--workspace <path>", "Workspace directory for artifacts")
    .option("--baseline", "Run both with_skill and without_skill modes")
    .option("--target <model>", "Target model name")
    .option("--judge <model>", "Judge model name; defaults to --target")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option("--api-key-env <name>", "Environment variable containing the API key")
    .option("--run-mode <mode>", "Execution mode: api (default), opencode, or claude-code")
    .option("--api-timeout <ms>", "API request timeout in milliseconds (run-mode api)", parseNumber)
    .option(
      "--api-judge-timeout <ms>",
      "API judge/grader request timeout in milliseconds; defaults to --api-timeout",
      parseNumber
    )
    .option("--opencode-agent <name>", "opencode --agent to use")
    .option("--opencode-auto", "Auto-approve opencode permissions (dangerous)")
    .option("--no-opencode-auto", "Disable opencode auto-approve, overriding config file")
    .option("--opencode-dir <path>", "Working directory for opencode runs")
    .option("--opencode-timeout <ms>", "opencode subprocess timeout in milliseconds", parseNumber)
    .option(
      "--opencode-judge-timeout <ms>",
      "opencode judge/grader subprocess timeout in milliseconds; defaults to --opencode-timeout",
      parseNumber
    )
    .option("--claude-code-agent <name>", "claude --agent to use")
    .option("--claude-code-auto", "Auto-approve claude-code permissions via --dangerously-skip-permissions (dangerous)")
    .option("--no-claude-code-auto", "Disable claude-code auto-approve, overriding config file")
    .option("--claude-code-dir <path>", "Working directory for claude-code runs")
    .option("--claude-code-timeout <ms>", "claude-code subprocess timeout in milliseconds", parseNumber)
    .option(
      "--claude-code-judge-timeout <ms>",
      "claude-code judge/grader subprocess timeout in milliseconds; defaults to --claude-code-timeout",
      parseNumber
    )
    .option("--claude-code-binary <path>", 'Path to the claude executable (default: "claude" resolved via PATH)')
    .option("--claude-code-allowed-tools <tool>", "Tool name to allow (repeatable), forwarded to claude --allowedTools", list, [])
    .option("--claude-code-disallowed-tools <tool>", "Tool name to deny (repeatable), forwarded to claude --disallowedTools", list, [])
    .option("--include <glob>", "Include skill relPath glob", list)
    .option("--exclude <glob>", "Exclude skill relPath glob", list)
    .option("--concurrency <number>", "Eval cases to run in parallel", parseNumber)
    .option("--report", "Generate the static HTML report")
    .option("--no-report", "Skip HTML report generation")
    .option("--color", "Force ANSI color")
    .option("--no-color", "Disable ANSI color")
    .option("--verbose", "Print full prompts, outputs, and judge prompts")
    .option("--layout <layout>", "Artifact layout: iteration or flat")
    .option("--strict", "Validate SKILL.md against agentskills.io before running")
    .option("--log-format <format>", "Logging format: pretty, jsonl, or silent")
    .option("--log-file <path>", "Write JSONL event logs to a file")
    .option("--report-title <title>", "HTML report title")
    .option("--report-output <path>", "HTML report output directory");

  program.parse(process.argv);
  const opts = program.opts<CliOptions>();
  const config = opts.config ? loadConfigFile(opts.config) : {};
  const resolved = resolveConfig(opts, config, program.processedArgs[0]);
  const { targetModel, judgeModel, runMode, concurrency, layout } = resolved;
  const { format: logFormat, file: logFile, verbose, color } = resolved.logging;
  const apiKey = process.env[resolved.apiKeyEnv];
  const baseUrl = resolved.baseUrl ?? process.env.OPENAI_BASE_URL;

  if (runMode !== "api" && runMode !== "opencode" && runMode !== "claude-code") {
    throw new Error('--run-mode must be "api", "opencode", or "claude-code"');
  }
  if (runMode === "api") {
    if (!baseUrl) {
      throw new Error("provide --base-url or set OPENAI_BASE_URL");
    }
    if (!apiKey) {
      throw new Error(`environment variable ${resolved.apiKeyEnv} is not set`);
    }
  }
  if (runMode === "opencode" && !opts.target && !config.target) {
    throw new Error(
      '--target is required when --run-mode is "opencode" (use "provider/model", e.g. "anthropic/claude-sonnet-5")'
    );
  }
  if (runMode === "claude-code" && !opts.target && !config.target) {
    throw new Error('--target is required when --run-mode is "claude-code" (e.g. "claude-sonnet-5")');
  }
  if (layout !== "iteration" && layout !== "flat") {
    throw new Error('--layout must be "iteration" or "flat"');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (logFormat !== "pretty" && logFormat !== "jsonl" && logFormat !== "silent") {
    throw new Error('--log-format must be "pretty", "jsonl", or "silent"');
  }
  if (runMode === "api" && (!Number.isInteger(resolved.api.timeoutMs) || resolved.api.timeoutMs < 1)) {
    throw new Error("--api-timeout must be a positive integer (milliseconds)");
  }
  if (runMode === "api" && (!Number.isInteger(resolved.api.judgeTimeoutMs) || resolved.api.judgeTimeoutMs < 1)) {
    throw new Error("--api-judge-timeout must be a positive integer (milliseconds)");
  }
  if (runMode === "opencode" && (!Number.isInteger(resolved.opencode.timeoutMs) || resolved.opencode.timeoutMs < 1)) {
    throw new Error("--opencode-timeout must be a positive integer (milliseconds)");
  }
  if (
    runMode === "opencode" &&
    (!Number.isInteger(resolved.opencode.judgeTimeoutMs) || resolved.opencode.judgeTimeoutMs < 1)
  ) {
    throw new Error("--opencode-judge-timeout must be a positive integer (milliseconds)");
  }
  if (
    runMode === "claude-code" &&
    (!Number.isInteger(resolved.claudeCode.timeoutMs) || resolved.claudeCode.timeoutMs < 1)
  ) {
    throw new Error("--claude-code-timeout must be a positive integer (milliseconds)");
  }
  if (
    runMode === "claude-code" &&
    (!Number.isInteger(resolved.claudeCode.judgeTimeoutMs) || resolved.claudeCode.judgeTimeoutMs < 1)
  ) {
    throw new Error("--claude-code-judge-timeout must be a positive integer (milliseconds)");
  }

  let target: Provider;
  let judge: Provider;
  if (runMode === "opencode") {
    target = new OpencodeProvider({
      providerName: "opencode",
      model: targetModel,
      agent: resolved.opencode.agent,
      dir: resolved.opencode.dir,
      auto: resolved.opencode.auto,
      timeoutMs: resolved.opencode.timeoutMs,
      baseUrl: resolved.opencode.baseUrl,
    });
    judge = new OpencodeProvider({
      providerName: "opencode",
      model: judgeModel,
      agent: resolved.opencode.agent,
      dir: resolved.opencode.dir,
      auto: resolved.opencode.auto,
      timeoutMs: resolved.opencode.judgeTimeoutMs,
      baseUrl: resolved.opencode.baseUrl,
    });
  } else if (runMode === "claude-code") {
    target = new ClaudeCodeProvider({
      providerName: "claude-code",
      model: targetModel,
      agent: resolved.claudeCode.agent,
      dir: resolved.claudeCode.dir,
      auto: resolved.claudeCode.auto,
      timeoutMs: resolved.claudeCode.timeoutMs,
      claudeBinary: resolved.claudeCode.binary,
      allowedTools: resolved.claudeCode.allowedTools,
      disallowedTools: resolved.claudeCode.disallowedTools,
    });
    judge = new ClaudeCodeProvider({
      providerName: "claude-code",
      model: judgeModel,
      agent: resolved.claudeCode.agent,
      dir: resolved.claudeCode.dir,
      auto: resolved.claudeCode.auto,
      timeoutMs: resolved.claudeCode.judgeTimeoutMs,
      claudeBinary: resolved.claudeCode.binary,
      allowedTools: resolved.claudeCode.allowedTools,
      disallowedTools: resolved.claudeCode.disallowedTools,
    });
  } else {
    const creds = requireApiCredentials(baseUrl, apiKey, resolved.apiKeyEnv);
    target = new OpenAICompatibleProvider({
      providerName: "openai-compatible",
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: targetModel,
      timeoutMs: resolved.api.timeoutMs,
    });
    judge = new OpenAICompatibleProvider({
      providerName: "openai-compatible",
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: judgeModel,
      timeoutMs: resolved.api.judgeTimeoutMs,
    });
  }

  let closeReporter: (() => Promise<void>) | undefined;
  let onEvent;
  if (logFormat === "pretty") {
    onEvent = consoleReporter({
      color,
      verbose,
      snippetLength: config.logging?.snippetLength,
    });
  } else if (logFormat === "jsonl") {
    const reporter: JsonlReporter = jsonlReporter({ file: logFile });
    onEvent = reporter.onEvent;
    closeReporter = reporter.close;
  }

  const unregisterReporter = closeReporter ? registerShutdownHook(closeReporter) : undefined;
  try {
    const result = await evaluateSkills({
      root: resolved.root,
      workspace: resolved.workspace,
      baseline: resolved.baseline,
      target: { model: targetModel, provider: target },
      judge: { model: judgeModel, provider: judge },
      include: resolved.include,
      exclude: resolved.exclude,
      concurrency,
      report: resolved.report.enabled,
      reportTitle: resolved.report.title,
      reportOutput: resolved.report.output,
      workspaceLayout: layout,
      strict: resolved.strict,
      targetParams: config.targetParams,
      judgeParams: config.judgeParams,
      onEvent,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.failed > 0 ? 1 : 0;
  } finally {
    unregisterReporter?.();
    await closeReporter?.();
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
