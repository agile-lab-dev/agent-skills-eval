import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

export type LogFormat = "pretty" | "jsonl" | "silent";
export type WorkspaceLayout = "flat" | "iteration";
export type ProviderRunMode = "api" | "opencode" | "claude-code";

export interface OpencodeConfig {
  agent?: string;
  auto?: boolean;
  dir?: string;
  timeoutMs?: number;
  /** Timeout for judge/grader calls. Defaults to `timeoutMs`. Judge sessions read a full transcript plus output files and are often slower than the executor run they grade. */
  judgeTimeoutMs?: number;
  /** Talk to an already-running `opencode serve` instead of spawning one. Mainly for tests, but also useful to share one server across multiple invocations. */
  baseUrl?: string;
}

export interface ClaudeCodeConfig {
  agent?: string;
  auto?: boolean;
  dir?: string;
  timeoutMs?: number;
  /** Timeout for judge/grader calls. Defaults to `timeoutMs`. Judge sessions read a full transcript plus output files and are often slower than the executor run they grade. */
  judgeTimeoutMs?: number;
  /** Path to the `claude` executable. Default "claude" (resolved via PATH). */
  claudeBinary?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ApiConfig {
  timeoutMs?: number;
  /** Timeout for judge/grader calls. Defaults to `timeoutMs`. Judge sessions read a full transcript plus output files and are often slower than the executor run they grade. */
  judgeTimeoutMs?: number;
}

export interface CliOptions {
  config?: string;
  workspace?: string;
  baseline?: boolean;
  target?: string;
  judge?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  runMode?: ProviderRunMode;
  apiTimeout?: number;
  apiJudgeTimeout?: number;
  opencodeAgent?: string;
  opencodeAuto?: boolean;
  opencodeDir?: string;
  opencodeTimeout?: number;
  opencodeJudgeTimeout?: number;
  claudeCodeAgent?: string;
  claudeCodeAuto?: boolean;
  claudeCodeDir?: string;
  claudeCodeTimeout?: number;
  claudeCodeJudgeTimeout?: number;
  claudeCodeBinary?: string;
  claudeCodeAllowedTools?: string[];
  claudeCodeDisallowedTools?: string[];
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  report?: boolean;
  color?: boolean;
  verbose?: boolean;
  layout?: WorkspaceLayout;
  strict?: boolean;
  logFormat?: LogFormat;
  logFile?: string;
  reportTitle?: string;
  reportOutput?: string;
}

export interface AgentSkillsEvalConfig {
  root?: string;
  workspace?: string;
  baseline?: boolean;
  target?: string;
  judge?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  runMode?: ProviderRunMode;
  api?: ApiConfig;
  opencode?: OpencodeConfig;
  claudeCode?: ClaudeCodeConfig;
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  strict?: boolean;
  layout?: WorkspaceLayout;
  report?: boolean | {
    enabled?: boolean;
    title?: string;
    output?: string;
  };
  logging?: {
    format?: LogFormat;
    verbose?: boolean;
    color?: boolean | "auto";
    snippetLength?: number;
    file?: string;
  };
  targetParams?: Record<string, unknown>;
  judgeParams?: Record<string, unknown>;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${where} must be a string`);
  return value;
}

function asBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where} must be a boolean`);
  return value;
}

function asNumber(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${where} must be a finite number`);
  return value;
}

function asStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${where} must be an array of strings`);
  }
  return value;
}

function asParams(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function parseLayout(value: unknown): WorkspaceLayout | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "flat" || value === "iteration") return value;
  throw new Error('layout must be "flat" or "iteration"');
}

function parseLogFormat(value: unknown): LogFormat | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "pretty" || value === "jsonl" || value === "silent") return value;
  throw new Error('logging.format must be "pretty", "jsonl", or "silent"');
}

function parseRunMode(value: unknown): ProviderRunMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "api" || value === "opencode" || value === "claude-code") return value;
  throw new Error('runMode must be "api", "opencode", or "claude-code"');
}

function parseApi(value: unknown): ApiConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "api");
  return {
    timeoutMs: asNumber(record.timeoutMs, "api.timeoutMs"),
    judgeTimeoutMs: asNumber(record.judgeTimeoutMs, "api.judgeTimeoutMs"),
  };
}

function parseOpencode(value: unknown): OpencodeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "opencode");
  return {
    agent: asString(record.agent, "opencode.agent"),
    auto: asBoolean(record.auto, "opencode.auto"),
    dir: asString(record.dir, "opencode.dir"),
    timeoutMs: asNumber(record.timeoutMs, "opencode.timeoutMs"),
    judgeTimeoutMs: asNumber(record.judgeTimeoutMs, "opencode.judgeTimeoutMs"),
    baseUrl: asString(record.baseUrl, "opencode.baseUrl"),
  };
}

function parseClaudeCode(value: unknown): ClaudeCodeConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "claudeCode");
  return {
    agent: asString(record.agent, "claudeCode.agent"),
    auto: asBoolean(record.auto, "claudeCode.auto"),
    dir: asString(record.dir, "claudeCode.dir"),
    timeoutMs: asNumber(record.timeoutMs, "claudeCode.timeoutMs"),
    judgeTimeoutMs: asNumber(record.judgeTimeoutMs, "claudeCode.judgeTimeoutMs"),
    claudeBinary: asString(record.claudeBinary, "claudeCode.claudeBinary"),
    allowedTools: asStringArray(record.allowedTools, "claudeCode.allowedTools"),
    disallowedTools: asStringArray(record.disallowedTools, "claudeCode.disallowedTools"),
  };
}

function parseReport(value: unknown): AgentSkillsEvalConfig["report"] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const record = asRecord(value, "report");
  return {
    enabled: asBoolean(record.enabled, "report.enabled"),
    title: asString(record.title, "report.title"),
    output: asString(record.output, "report.output"),
  };
}

function parseLogging(value: unknown): AgentSkillsEvalConfig["logging"] {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value, "logging");
  const color = record.color;
  if (color !== undefined && color !== "auto" && typeof color !== "boolean") {
    throw new Error('logging.color must be true, false, or "auto"');
  }
  return {
    format: parseLogFormat(record.format),
    verbose: asBoolean(record.verbose, "logging.verbose"),
    color: color as boolean | "auto" | undefined,
    snippetLength: asNumber(record.snippetLength, "logging.snippetLength"),
    file: asString(record.file, "logging.file"),
  };
}

export function normalizeConfig(raw: unknown): AgentSkillsEvalConfig {
  const record = asRecord(raw ?? {}, "config");
  return {
    root: asString(record.root, "root"),
    workspace: asString(record.workspace, "workspace"),
    baseline: asBoolean(record.baseline, "baseline"),
    target: asString(record.target, "target"),
    judge: asString(record.judge, "judge"),
    baseUrl: asString(record.baseUrl, "baseUrl"),
    apiKeyEnv: asString(record.apiKeyEnv, "apiKeyEnv"),
    runMode: parseRunMode(record.runMode),
    api: parseApi(record.api),
    opencode: parseOpencode(record.opencode),
    claudeCode: parseClaudeCode(record.claudeCode),
    include: asStringArray(record.include, "include"),
    exclude: asStringArray(record.exclude, "exclude"),
    concurrency: asNumber(record.concurrency, "concurrency"),
    strict: asBoolean(record.strict, "strict"),
    layout: parseLayout(record.layout),
    report: parseReport(record.report),
    logging: parseLogging(record.logging),
    targetParams: asParams(record.targetParams, "targetParams"),
    judgeParams: asParams(record.judgeParams, "judgeParams"),
  };
}

export function loadConfigFile(filePath: string): AgentSkillsEvalConfig {
  const absolutePath = path.resolve(filePath);
  if (!existsSync(absolutePath)) throw new Error(`config file not found: ${absolutePath}`);
  const text = readFileSync(absolutePath, "utf-8");
  const ext = path.extname(absolutePath).toLowerCase();
  const raw = ext === ".json" ? JSON.parse(text) : load(text);
  return normalizeConfig(raw);
}

// ─── CLI flag / config-file / default precedence ──────────────────────────
// Pure merge helpers: CLI flag wins, then the config file, then a static
// fallback (or `undefined` for fields with no fallback). Kept free of
// `process.env` reads and `Number.parseInt` so they're trivially unit
// testable with plain objects (see test/config.test.mjs).

export function resolveOpt<T>(cliVal: T | undefined, configVal: T | undefined, fallback: T): T {
  return cliVal ?? configVal ?? fallback;
}

export function resolveOptional<T>(cliVal: T | undefined, configVal: T | undefined): T | undefined {
  return cliVal ?? configVal;
}

/** Narrows the `report` union (`boolean | { enabled?, title?, output? }`) to a plain object. */
function normalizeReportConfig(report: AgentSkillsEvalConfig["report"]): {
  enabled?: boolean;
  title?: string;
  output?: string;
} {
  if (report === undefined) return {};
  if (typeof report === "boolean") return { enabled: report };
  return report;
}

export interface ResolvedConfig {
  root: string;
  workspace: string;
  baseline: boolean;
  targetModel: string;
  judgeModel: string;
  apiKeyEnv: string;
  baseUrl: string | undefined;
  runMode: ProviderRunMode;
  include: string[] | undefined;
  exclude: string[] | undefined;
  concurrency: number;
  layout: WorkspaceLayout;
  strict: boolean;
  report: { enabled: boolean; title: string | undefined; output: string | undefined };
  logging: { format: LogFormat; file: string | undefined; verbose: boolean; color: boolean | "auto" };
  api: { timeoutMs: number; judgeTimeoutMs: number };
  opencode: {
    agent: string | undefined;
    baseUrl: string | undefined;
    auto: boolean;
    dir: string;
    timeoutMs: number;
    judgeTimeoutMs: number;
  };
  claudeCode: {
    agent: string | undefined;
    auto: boolean;
    dir: string;
    binary: string | undefined;
    allowedTools: string[] | undefined;
    disallowedTools: string[] | undefined;
    timeoutMs: number;
    judgeTimeoutMs: number;
  };
}

/**
 * Merges commander's parsed CLI options with the (already `normalizeConfig`'d)
 * config file into one flat, fully-resolved settings object: CLI flag beats
 * config file beats default.
 *
 * `positionalRoot` is commander's parsed `[root]` positional argument. It has
 * a static default of `"."`, so it's indistinguishable from the user typing
 * `.` explicitly — a known commander limitation, not solved here.
 *
 * Deliberately does not read `process.env` or parse strings to numbers: both
 * stay the caller's responsibility so this function stays pure and testable
 * with plain objects.
 */
export function resolveConfig(
  cli: CliOptions,
  config: AgentSkillsEvalConfig,
  positionalRoot: string
): ResolvedConfig {
  const targetModel = resolveOpt(cli.target, config.target, "gpt-4o-mini");
  const judgeModel = resolveOpt(cli.judge, config.judge, targetModel);

  const apiTimeoutMs = resolveOpt(cli.apiTimeout, config.api?.timeoutMs, 120_000);
  const opencodeTimeoutMs = resolveOpt(cli.opencodeTimeout, config.opencode?.timeoutMs, 5 * 60 * 1000);
  const claudeCodeTimeoutMs = resolveOpt(cli.claudeCodeTimeout, config.claudeCode?.timeoutMs, 5 * 60 * 1000);

  const reportConfig = normalizeReportConfig(config.report);

  return {
    root: positionalRoot !== "." ? positionalRoot : config.root ?? ".",
    workspace: resolveOpt(cli.workspace, config.workspace, "./agent-skills-workspace"),
    baseline: resolveOpt(cli.baseline, config.baseline, false),
    targetModel,
    judgeModel,
    apiKeyEnv: resolveOpt(cli.apiKeyEnv, config.apiKeyEnv, "OPENAI_API_KEY"),
    baseUrl: resolveOptional(cli.baseUrl, config.baseUrl),
    runMode: resolveOpt(cli.runMode, config.runMode, "api"),
    include: resolveOptional(cli.include, config.include),
    exclude: resolveOptional(cli.exclude, config.exclude),
    concurrency: resolveOpt(cli.concurrency, config.concurrency, 4),
    layout: resolveOpt(cli.layout, config.layout, "iteration"),
    strict: resolveOpt(cli.strict, config.strict, false),
    report: {
      enabled: resolveOpt(cli.report, reportConfig.enabled, true),
      title: resolveOptional(cli.reportTitle, reportConfig.title),
      output: resolveOptional(cli.reportOutput, reportConfig.output),
    },
    logging: {
      format: resolveOpt(cli.logFormat, config.logging?.format, "pretty"),
      file: resolveOptional(cli.logFile, config.logging?.file),
      verbose: resolveOpt(cli.verbose, config.logging?.verbose, false),
      color: resolveOpt(cli.color, config.logging?.color, "auto"),
    },
    api: {
      timeoutMs: apiTimeoutMs,
      judgeTimeoutMs: resolveOpt(cli.apiJudgeTimeout, config.api?.judgeTimeoutMs, apiTimeoutMs),
    },
    opencode: {
      agent: resolveOptional(cli.opencodeAgent, config.opencode?.agent),
      baseUrl: config.opencode?.baseUrl,
      auto: resolveOpt(cli.opencodeAuto, config.opencode?.auto, false),
      dir: resolveOpt(cli.opencodeDir, config.opencode?.dir, process.cwd()),
      timeoutMs: opencodeTimeoutMs,
      judgeTimeoutMs: resolveOpt(cli.opencodeJudgeTimeout, config.opencode?.judgeTimeoutMs, opencodeTimeoutMs),
    },
    claudeCode: {
      agent: resolveOptional(cli.claudeCodeAgent, config.claudeCode?.agent),
      auto: resolveOpt(cli.claudeCodeAuto, config.claudeCode?.auto, false),
      dir: resolveOpt(cli.claudeCodeDir, config.claudeCode?.dir, process.cwd()),
      binary: resolveOptional(cli.claudeCodeBinary, config.claudeCode?.claudeBinary),
      allowedTools:
        cli.claudeCodeAllowedTools && cli.claudeCodeAllowedTools.length > 0
          ? cli.claudeCodeAllowedTools
          : config.claudeCode?.allowedTools,
      disallowedTools:
        cli.claudeCodeDisallowedTools && cli.claudeCodeDisallowedTools.length > 0
          ? cli.claudeCodeDisallowedTools
          : config.claudeCode?.disallowedTools,
      timeoutMs: claudeCodeTimeoutMs,
      judgeTimeoutMs: resolveOpt(cli.claudeCodeJudgeTimeout, config.claudeCode?.judgeTimeoutMs, claudeCodeTimeoutMs),
    },
  };
}
