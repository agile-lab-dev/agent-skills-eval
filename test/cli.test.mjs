import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createFakeOpencodeServer } from "./fixtures/fake-opencode-server.mjs";

const FAKE_CLAUDE_BINARY = fileURLToPath(new URL("./fixtures/fake-claude-code-binary.mjs", import.meta.url));

const execFileAsync = promisify(execFile);

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "agent-skills-eval-cli-"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await sleep(20);
  }
  return readFileSync(filePath, "utf8").trim();
}

function writeSkill(root) {
  const dir = path.join(root, "basic-skill");
  mkdirSync(path.join(dir, "evals", "files"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      "name: basic-skill",
      "description: Summarize revenue CSV files.",
      "---",
      "",
      "Identify the highest revenue month.",
    ].join("\n"),
  );
  writeFileSync(path.join(dir, "evals", "files", "revenue.csv"), "month,revenue\nJanuary,12\nFebruary,18\n");
  writeFileSync(
    path.join(dir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "basic-skill",
      evals: [
        {
          id: "top",
          name: "top month",
          prompt: "Find the top revenue month.",
          files: ["evals/files/revenue.csv"],
          assertions: ["The output names February.", "The output includes 18."],
        },
      ],
    }),
  );
}

function startOpenAiMock() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const user = parsed.messages?.at(-1)?.content ?? "";
      const isJudge = user.includes("Return STRICT JSON only") || user.includes("Assertions:");
      const content = isJudge
        ? JSON.stringify({
            assertion_results: [
              { text: "The output names February.", passed: true, evidence: "February is named." },
              { text: "The output includes 18.", passed: true, evidence: "18 is included." },
            ],
            summary: { passed: 2, failed: 0, total: 2, pass_rate: 1 },
          })
        : "February has the highest revenue with 18.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: parsed.model,
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("CLI runs from YAML config and writes JSONL logs plus report artifacts", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const logFile = path.join(root, "events.jsonl");
  const configPath = path.join(root, "agent-skills-eval.yaml");
  const mock = await startOpenAiMock();

  try {
    writeFileSync(configPath, [
      `root: ${JSON.stringify(root)}`,
      `workspace: ${JSON.stringify(workspace)}`,
      "baseline: true",
      "target: mock-target",
      "judge: mock-judge",
      `baseUrl: ${JSON.stringify(mock.url)}`,
      "apiKeyEnv: MOCK_OPENAI_KEY",
      "layout: iteration",
      "strict: true",
      "report:",
      "  enabled: true",
      "  title: CLI Test Report",
      "logging:",
      "  format: jsonl",
      `  file: ${JSON.stringify(logFile)}`,
    ].join("\n"));

    const { stdout } = await execFileAsync(
      process.execPath,
      ["dist/cli.js", "--config", configPath],
      {
        cwd: path.resolve("."),
        env: { ...process.env, MOCK_OPENAI_KEY: "test-key" },
      },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.failed, 0);
    assert.equal(result.iteration, 1);
    assert.equal(result.skills.length, 1);
    assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-month", "with_skill", "grading.json")));
    assert.ok(existsSync(path.join(workspace, "iteration-1", "report", "index.html")));

    const events = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "suite-start");
    assert.ok(events.some((event) => event.type === "eval-end" && event.mode === "with_skill"));
    assert.ok(mock.requests.length >= 4, "baseline run should call target and judge for both modes");

    const requestsWithFile = mock.requests.filter((req) =>
      (req.messages?.at(-1)?.content ?? "").includes("<file path=\"evals/files/revenue.csv\"")
    );
    assert.equal(requestsWithFile.length, 2, "both with_skill and without_skill target requests should include the attached file");
  } finally {
    await mock.close();
  }
});

test("CLI runs with an api: { timeoutMs, judgeTimeoutMs } config block", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "agent-skills-eval.yaml");
  const logFile = path.join(root, "events.jsonl");
  const mock = await startOpenAiMock();

  try {
    writeFileSync(configPath, [
      `root: ${JSON.stringify(root)}`,
      `workspace: ${JSON.stringify(workspace)}`,
      "target: mock-target",
      "judge: mock-judge",
      `baseUrl: ${JSON.stringify(mock.url)}`,
      "apiKeyEnv: MOCK_OPENAI_KEY",
      "api:",
      "  timeoutMs: 60000",
      "  judgeTimeoutMs: 120000",
      "layout: iteration",
      "strict: true",
      "report:",
      "  enabled: false",
      "logging:",
      "  format: jsonl",
      `  file: ${JSON.stringify(logFile)}`,
    ].join("\n"));

    const { stdout } = await execFileAsync(
      process.execPath,
      ["dist/cli.js", "--config", configPath],
      {
        cwd: path.resolve("."),
        env: { ...process.env, MOCK_OPENAI_KEY: "test-key" },
      },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.failed, 0);
  } finally {
    await mock.close();
  }
});

test("CLI --run-mode opencode skips API credential requirements and runs via the opencode server", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "agent-skills-eval.yaml");
  const logFile = path.join(root, "events.jsonl");
  const fakeServer = await createFakeOpencodeServer();

  try {
    writeFileSync(configPath, [
      `root: ${JSON.stringify(root)}`,
      `workspace: ${JSON.stringify(workspace)}`,
      "baseline: true",
      "target: fake/model",
      "judge: fake/model",
      "runMode: opencode",
      "opencode:",
      `  baseUrl: ${JSON.stringify(fakeServer.url)}`,
      "  timeoutMs: 60000",
      "  judgeTimeoutMs: 120000",
      "layout: iteration",
      "strict: true",
      "report:",
      "  enabled: false",
      "logging:",
      "  format: jsonl",
      `  file: ${JSON.stringify(logFile)}`,
    ].join("\n"));

    const { stdout } = await execFileAsync(
      process.execPath,
      ["dist/cli.js", "--config", configPath],
      {
        cwd: path.resolve("."),
        env: { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "" },
      },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.failed, 0);
    assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-month", "with_skill", "grading.json")));
  } finally {
    await fakeServer.close();
  }
});

test("CLI --run-mode claude-code skips API credential requirements and runs via the claude binary", async () => {
  const root = tempRoot();
  writeSkill(root);
  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "agent-skills-eval.yaml");
  const logFile = path.join(root, "events.jsonl");

  writeFileSync(configPath, [
    `root: ${JSON.stringify(root)}`,
    `workspace: ${JSON.stringify(workspace)}`,
    "baseline: true",
    "target: fake-model",
    "judge: fake-model",
    "runMode: claude-code",
    "claudeCode:",
    `  claudeBinary: ${JSON.stringify(FAKE_CLAUDE_BINARY)}`,
    "  timeoutMs: 60000",
    "  judgeTimeoutMs: 120000",
    "layout: iteration",
    "strict: true",
    "report:",
    "  enabled: false",
    "logging:",
    "  format: jsonl",
    `  file: ${JSON.stringify(logFile)}`,
  ].join("\n"));

  const { stdout } = await execFileAsync(
    process.execPath,
    ["dist/cli.js", "--config", configPath],
    {
      cwd: path.resolve("."),
      env: { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "" },
    },
  );

  const result = JSON.parse(stdout);
  assert.equal(result.failed, 0);
  assert.ok(existsSync(path.join(workspace, "iteration-1", "eval-top-month", "with_skill", "grading.json")));
});

test("CLI: SIGINT during a running claude-code call exits promptly with code 130 and kills the underlying subprocess", async () => {
  const root = tempRoot();
  const skillDir = path.join(root, "hang-skill");
  mkdirSync(path.join(skillDir, "evals"), { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    ["---", "name: hang-skill", "description: Hangs forever, for signal-handling tests.", "---", "", "Do nothing."].join("\n"),
  );
  writeFileSync(
    path.join(skillDir, "evals", "evals.json"),
    JSON.stringify({
      skill_name: "hang-skill",
      evals: [{ id: "hang", name: "hang", prompt: "__FAKE_CLAUDE_HANG__", assertions: ["n/a"] }],
    }),
  );

  const workspace = path.join(root, "workspace");
  const configPath = path.join(root, "agent-skills-eval.yaml");
  const pidFile = path.join(root, "fake-claude.pid");

  writeFileSync(configPath, [
    `root: ${JSON.stringify(root)}`,
    `workspace: ${JSON.stringify(workspace)}`,
    "target: fake-model",
    "judge: fake-model",
    "runMode: claude-code",
    "claudeCode:",
    `  claudeBinary: ${JSON.stringify(FAKE_CLAUDE_BINARY)}`,
    `  dir: ${JSON.stringify(path.join(root, "claude-code-dir"))}`,
    "  timeoutMs: 60000",
    "  judgeTimeoutMs: 60000",
    "layout: iteration",
    "report:",
    "  enabled: false",
    "logging:",
    "  format: silent",
  ].join("\n"));

  const child = spawn(process.execPath, ["dist/cli.js", "--config", configPath], {
    cwd: path.resolve("."),
    env: { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "", FAKE_CLAUDE_PID_FILE: pidFile },
  });

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const fakePid = Number(await waitForFile(pidFile, 5000));
    assert.doesNotThrow(() => process.kill(fakePid, 0), "fake claude subprocess should be alive before SIGINT");

    const started = Date.now();
    child.kill("SIGINT");

    const { code } = await exitPromise;
    assert.ok(Date.now() - started < 8000, "CLI should exit within a few seconds of SIGINT, not hang");
    assert.equal(code, 130);

    await sleep(200);
    assert.throws(() => process.kill(fakePid, 0), /ESRCH/, "fake claude subprocess should be gone after the CLI exits");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("CLI --run-mode bogus fails validation with a clear error", async () => {
  const root = tempRoot();
  writeSkill(root);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["dist/cli.js", root, "--run-mode", "bogus", "--target", "fake/model"],
      { cwd: path.resolve(".") },
    ),
    (err) => {
      assert.match(err.stderr, /--run-mode must be "api", "opencode", or "claude-code"/);
      return true;
    },
  );
});

test("CLI --api-timeout rejects non-positive values", async () => {
  const root = tempRoot();
  writeSkill(root);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "dist/cli.js",
        root,
        "--target",
        "fake-model",
        "--base-url",
        "http://127.0.0.1:1/v1",
        "--api-timeout",
        "0",
      ],
      { cwd: path.resolve("."), env: { ...process.env, OPENAI_API_KEY: "test-key" } },
    ),
    (err) => {
      assert.match(err.stderr, /--api-timeout must be a positive integer/);
      return true;
    },
  );
});

test("CLI --api-judge-timeout rejects non-positive values", async () => {
  const root = tempRoot();
  writeSkill(root);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "dist/cli.js",
        root,
        "--target",
        "fake-model",
        "--base-url",
        "http://127.0.0.1:1/v1",
        "--api-judge-timeout",
        "0",
      ],
      { cwd: path.resolve("."), env: { ...process.env, OPENAI_API_KEY: "test-key" } },
    ),
    (err) => {
      assert.match(err.stderr, /--api-judge-timeout must be a positive integer/);
      return true;
    },
  );
});

test("CLI --opencode-judge-timeout rejects non-positive values", async () => {
  const root = tempRoot();
  writeSkill(root);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "dist/cli.js",
        root,
        "--run-mode",
        "opencode",
        "--target",
        "fake/model",
        "--opencode-judge-timeout",
        "0",
      ],
      { cwd: path.resolve(".") },
    ),
    (err) => {
      assert.match(err.stderr, /--opencode-judge-timeout must be a positive integer/);
      return true;
    },
  );
});
