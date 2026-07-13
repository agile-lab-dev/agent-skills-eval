# CLAUDE.md

## What this is

`agent-skills-eval` is a TypeScript SDK + CLI that evaluates [Agent Skills](https://agentskills.io) (`SKILL.md` + `evals/evals.json`) by running each eval prompt twice — `with_skill` (skill loaded into context) and `without_skill` (baseline) — through a target model, grading both with an LLM judge, and emitting portable JSON/JSONL artifacts plus a static HTML report.

This is `agilelab-dev`'s fork of `darkrishabh/agent-skills-eval`; the npm package is scoped `@agilelab/agent-skills-eval`.

## Documentation

Every change must be reflected in docs: update `docs/`, `README.md`, and `CHANGELOG.md` alongside the code that motivates them, in the same commit/PR.

## Commands

```sh
npm ci                    # install
npm run build              # tsc -> dist/
npm run typecheck          # tsc --noEmit
npm test                   # build, then node --test test/*.test.mjs
npm pack --dry-run         # verify publishable package contents
```

Run a single test file directly (after `npm run build`, since tests import from `dist/`):

```sh
node --test test/config.test.mjs
node --test test/config.test.mjs --test-name-pattern="resolves baseUrl"
```

Re-render the HTML report from artifacts already on disk, without re-running evals (useful after editing `src/report.ts`):

```sh
npm run build
node scripts/render-report.mjs <workspace-dir> [--output <dir>] [--title <title>] [--target <model>] [--judge <model>] [--provider <name>]
```

CI (`.github/workflows/ci.yml`) runs `typecheck` + `test` + `pack --dry-run` on Node 18/20/22.

## Architecture

### Pipeline (src/evaluate-skills.ts is the orchestrator)

`discoverSkills` (src/discover.ts) walks `root` for `SKILL.md` files (skipping `node_modules`/`.git`/`dist`/`.next`), filtered by `include`/`exclude` globs, keeping only dirs with `evals/evals.json`. For each discovered skill: `loadSkill` (src/skill.ts) parses `SKILL.md` frontmatter + body, `references/`, `scripts/`, and `evals/evals.json` (optionally `strict`-validating against the agentskills.io naming/frontmatter rules) into a `Skill`.

Skills are prepped sequentially (phase 1, so the start-of-run banner is stable regardless of pool size), then every `(skill, evalCase)` pair is flattened into a task list and run through a small bounded-concurrency worker pool (`runPool`, default concurrency 4) — phase 2. Each task calls `runEval` (src/run-eval.ts), which for each mode (`with_skill`, `without_skill`):

1. Builds the system message (skill XML-wrapped: description/instructions/references/scripts) for `with_skill` only, and inlines any `evals[].files` into the user prompt as XML.
2. Calls the **target** provider (`completeChat` if available, else falls back to `complete` with a flattened prompt).
3. Grades the output via `gradeOutputs` (src/grade.ts): free-form `assertions`/`expected_output` go to the **judge** provider as a rubric prompt; `tool_assertions` are graded deterministically against the target's reported `ProviderResult.toolCalls` (no LLM call).
4. Writes per-run artifacts (`writeRunArtifacts` in src/artifacts.ts): `timing.json`, `grading.json`, `prompts.json`, `tool_calls.json`, `outputs/response.txt`.

Phase 3 aggregates pass/fail into `benchmark.json` per skill, optionally snapshots to `.history/iteration-N/` (`loop: true`), and renders the HTML report (`generateReport`, src/report.ts) unless `report: false`.

Artifact path conventions are centralized in **src/artifact-layout.ts** — the single source of truth every writer and the report reader import from, so on-disk paths can't drift between the two sides.

### Providers (src/provider.ts is the interface)

A `Provider` implements `complete(prompt)` and optionally `completeChat(args)` (structured system/user/tools), plus optional `prepareSkill`/`cleanupSkill` hooks for CLI-driven providers that discover skills natively on disk rather than via prompt injection. `capabilities` (`acceptsToolSchema`, `reportsToolCalls`, `sharedInstallDir`, `params`) let the orchestrator adapt behavior (e.g. warn when `tool_assertions` can't be graded, or serialize concurrent skill installs) — see `evaluate-skills.ts`'s capability-gated warnings.

Three providers, selected by `--run-mode`:
- **src/openai-compatible-provider.ts** (`api`, default) — plain HTTP calls to any OpenAI-compatible chat-completions endpoint.
- **src/opencode-provider.ts** (`opencode`) — spawns a private `opencode serve` subprocess per call via `@opencode-ai/sdk`; polls for async subagent delegation to settle; symlinks skill dirs into `.opencode/skills/<name>/` for native discovery.
- **src/claude-code-provider.ts** (`claude-code`) — spawns `claude -p --output-format stream-json` per call, parses the NDJSON transcript; symlinks skills into `.claude/skills/<name>/`.

The opencode/claude-code providers don't accept per-call `targetParams`/`judgeParams` (no channel for it in a CLI subprocess) and fold their own system-prompt overhead into token counts — both surfaced as one-time warnings in `evaluate-skills.ts`, detailed in the README's run-mode caveat sections.

### Config resolution (src/config.ts)

Precedence for every setting: CLI flag > YAML/JSON config file (`--config`) > built-in default. `resolveConfig` merges `CliOptions` + parsed config into a `ResolvedConfig` consumed by `cli.ts`. Same precedence pattern applies one level down for eval-case-level values: a case's own `params`/`tools` override the skill's `defaults` block, which overrides the caller-level `targetParams`/`judgeParams` passed into `evaluateSkills`.

### Key modules

| File | Responsibility |
|---|---|
| `src/cli.ts` | Commander-based CLI entrypoint; wires config → providers → `evaluateSkills`. |
| `src/config.ts` | YAML/JSON config loading + CLI/config/default resolution. |
| `src/discover.ts` | Filesystem walk to find skills (glob include/exclude, frontmatter name sniffing). |
| `src/skill.ts` | Parses `SKILL.md` + `evals/evals.json` into a `Skill`; strict agentskills.io validation. |
| `src/evaluate-skills.ts` | Top-level orchestrator: discovery → worker pool → aggregation → report. |
| `src/run-eval.ts` | Runs one eval case in one mode: builds prompt, calls target, grades, writes artifacts. |
| `src/grade.ts` | Judge-model rubric grading + deterministic `tool_assertions` grading. |
| `src/provider.ts` | `Provider` interface + shared tool/message types. |
| `src/*-provider.ts` | The three `Provider` implementations (api / opencode / claude-code). |
| `src/artifacts.ts` / `src/artifact-layout.ts` | Workspace allocation, artifact writing, canonical on-disk paths. |
| `src/report.ts` | Reads artifacts from disk, renders the static HTML report. |
| `src/console-reporter.ts` / `src/jsonl-reporter.ts` | Bundled `SkillsEvent` consumers (human-readable / machine-readable). |
| `src/types.ts` | Shared value types: `Skill`, `AgentSkillsEval`, artifact JSON shapes, `SkillsEvent` union. |

### Testing conventions

Tests are `node --test` files (`.test.mjs`) under `test/`, importing compiled output from `dist/` — always `npm run build` before running tests directly. `test/fixtures/` holds fake CLI binaries (`fake-opencode-binary.mjs`, `fake-claude-code-binary.mjs`, `fake-opencode-server.mjs`) used to test the subprocess-driving providers without a real `opencode`/`claude` install.
