import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "../dist/index.js";

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function okServer() {
  return startServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: "fake-model",
      })
    );
  });
}

function hangingServer() {
  return startServer(() => {
    // Never responds, never closes the connection.
  });
}

test("OpenAICompatibleProvider.completeChat: a hung request aborts and resolves with a timeout error instead of hanging", async () => {
  const server = await hangingServer();
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: server.url,
      apiKey: "test-key",
      model: "fake-model",
      timeoutMs: 300,
      retry: { attempts: 1 },
    });
    const started = Date.now();
    const result = await provider.completeChat({ user: "hello" });
    const elapsed = Date.now() - started;
    assert.match(result.error, /timed out after 300ms/);
    assert.ok(elapsed < 5000, `expected timeout to fire quickly, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: with no timeoutMs option, the 120s default is what schedules the abort", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let capturedDelay;
  let capturedCallback;
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (capturedDelay === undefined) {
      capturedDelay = ms;
      capturedCallback = cb;
    }
    return originalSetTimeout(cb, ms, ...args);
  };
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      model: "fake-model",
      retry: { attempts: 1 },
    });
    const resultPromise = provider.completeChat({ user: "hello" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capturedDelay, 120_000);

    capturedCallback();
    const result = await resultPromise;
    assert.match(result.error, /timed out after 120000ms/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("OpenAICompatibleProvider.completeChat: success path is unaffected by the default timeout", async () => {
  const server = await okServer();
  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: server.url,
      apiKey: "test-key",
      model: "fake-model",
    });
    const result = await provider.completeChat({ user: "hello" });
    assert.equal(result.error, undefined);
    assert.equal(result.output, "hi");
  } finally {
    await server.close();
  }
});
