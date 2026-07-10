import test from "node:test";
import assert from "node:assert/strict";
import { registerShutdownHook, installSignalHandlers } from "../dist/index.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubExitAndStderr() {
  const exitCalls = [];
  const stderrChunks = [];
  const originalExit = process.exit;
  const originalWrite = process.stderr.write;
  process.exit = (code) => {
    exitCalls.push(code);
  };
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  return {
    exitCalls,
    stderrChunks,
    restore: () => {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    },
  };
}

// These two tests share process-wide state in src/shutdown.ts (`installed`,
// `shuttingDown` module-level flags) since installSignalHandlers is
// idempotent by design (real CLI usage only installs it once). They must run
// in order: the first triggers a normal shutdown, the second relies on
// `shuttingDown` already being true to exercise the second-signal path.

test("installSignalHandlers: runs still-registered hooks on SIGINT, skips unregistered ones, bounds a hanging hook by timeoutMs, exits 130", async () => {
  const stub = stubExitAndStderr();
  try {
    let calledA = false;
    let calledB = false;
    let calledC = false;
    registerShutdownHook(() => {
      calledA = true;
    });
    const unregisterB = registerShutdownHook(() => {
      calledB = true;
    });
    registerShutdownHook(() => {
      calledC = true;
      return new Promise(() => {}); // never resolves — must be bounded by timeoutMs
    });
    unregisterB();

    installSignalHandlers({ timeoutMs: 150 });
    process.emit("SIGINT", "SIGINT");

    await sleep(400);

    assert.equal(calledA, true);
    assert.equal(calledB, false, "unregistered hook must not run");
    assert.equal(calledC, true);
    assert.ok(stub.exitCalls.includes(130), `expected exit(130), got ${JSON.stringify(stub.exitCalls)}`);
    assert.ok(stub.stderrChunks.some((line) => /received SIGINT, cleaning up 2 active subprocess\(es\)/.test(line)));
  } finally {
    stub.restore();
  }
});

test("installSignalHandlers: a second signal while shutting down forces an immediate exit(1)", async () => {
  const stub = stubExitAndStderr();
  try {
    // installSignalHandlers is idempotent (no-op here, already installed by
    // the previous test) and `shuttingDown` is already true from that
    // test's SIGINT, so this signal takes the "second signal" branch.
    installSignalHandlers();
    process.emit("SIGTERM", "SIGTERM");

    assert.deepEqual(stub.exitCalls, [1]);
    assert.ok(stub.stderrChunks.some((line) => /received second SIGTERM, forcing exit/.test(line)));
  } finally {
    stub.restore();
  }
});
