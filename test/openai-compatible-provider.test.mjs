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

function okBody() {
  return JSON.stringify({
    choices: [{ message: { content: "hi" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    model: "fake-model",
  });
}

// Serves `responses` in order (by request count), holding on the last entry
// once exhausted. Exposes `requests.count` so tests can assert how many
// attempts actually hit the wire.
async function scriptedServer(responses) {
  const requests = { count: 0 };
  const server = await startServer((req, res) => {
    const entry = responses[Math.min(requests.count, responses.length - 1)];
    requests.count++;
    res.writeHead(entry.status, entry.headers ?? {});
    res.end(entry.body ?? "");
  });
  return { ...server, requests };
}

// Replaces global setTimeout so the provider's own retry/backoff delays fire
// (almost) immediately instead of making the test suite actually wait, while
// recording the requested delay for each call so tests can assert on it.
// Only calls originating from openai-compatible-provider.js are intercepted
// this way — fetch's underlying HTTP client (undici) also schedules its own
// unrelated internal timers (e.g. keep-alive socket bookkeeping) on the same
// global setTimeout, and those must keep their real timing untouched. The
// per-attempt request-timeout abort timer (`this.timeoutMs`, default 120s)
// also originates from this same file, so it's excluded by a delay-size
// cutoff — every retry/backoff delay exercised here is well under 60s while
// the default abort timer is 120s, and firing the abort timer immediately
// would race (and sometimes beat) the fake server's response.
function stubSetTimeout() {
  const original = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (cb, ms, ...args) => {
    const isRetryDelay = ms < 60_000 && (new Error().stack ?? "").includes("dist/openai-compatible-provider.js");
    if (isRetryDelay) {
      delays.push(ms);
      return original(cb, 0, ...args);
    }
    return original(cb, ms, ...args);
  };
  return {
    delays,
    restore() {
      globalThis.setTimeout = original;
    },
  };
}

function provider(url, options = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: url,
    apiKey: "test-key",
    model: "fake-model",
    retry: { attempts: 2, backoffMs: 1500 },
    ...options,
  });
}

test("OpenAICompatibleProvider.completeChat: a 401 fails fast without retrying", async () => {
  const server = await scriptedServer([{ status: 401, body: "unauthorized" }]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.match(result.error, /401/);
    assert.equal(server.requests.count, 1);
    assert.equal(timer.delays.length, 0);
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: 400 and 404 fail fast without retrying", async () => {
  for (const status of [400, 404]) {
    const server = await scriptedServer([{ status, body: "bad request" }]);
    const timer = stubSetTimeout();
    try {
      const result = await provider(server.url).completeChat({ user: "hi" });
      assert.match(result.error, new RegExp(String(status)), `status ${status}`);
      assert.equal(server.requests.count, 1, `status ${status}`);
      assert.equal(timer.delays.length, 0, `status ${status}`);
    } finally {
      timer.restore();
      await server.close();
    }
  }
});

test("OpenAICompatibleProvider.completeChat: 429 with Retry-After header overrides the computed backoff", async () => {
  const server = await scriptedServer([
    { status: 429, headers: { "retry-after": "2" } },
    { status: 200, headers: { "content-type": "application/json" }, body: okBody() },
  ]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.equal(result.error, undefined);
    assert.equal(result.output, "hi");
    assert.equal(server.requests.count, 2);
    assert.deepEqual(timer.delays, [2000]);
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: 429 with no Retry-After falls back to computed backoff", async () => {
  const server = await scriptedServer([
    { status: 429 },
    { status: 200, headers: { "content-type": "application/json" }, body: okBody() },
  ]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.equal(result.error, undefined);
    assert.deepEqual(timer.delays, [1500]);
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: Retry-After as an HTTP-date is parsed to a millisecond delay", async () => {
  const futureDate = new Date(Date.now() + 5000).toUTCString();
  const server = await scriptedServer([
    { status: 429, headers: { "retry-after": futureDate } },
    { status: 200, headers: { "content-type": "application/json" }, body: okBody() },
  ]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.equal(result.error, undefined);
    assert.equal(timer.delays.length, 1);
    assert.ok(
      Math.abs(timer.delays[0] - 5000) < 500,
      `expected ~5000ms delay, got ${timer.delays[0]}ms`
    );
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: 503 with Retry-After gets the same override behavior as 429", async () => {
  const server = await scriptedServer([
    { status: 503, headers: { "retry-after": "3" } },
    { status: 200, headers: { "content-type": "application/json" }, body: okBody() },
  ]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.equal(result.error, undefined);
    assert.deepEqual(timer.delays, [3000]);
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: an oversized Retry-After is clamped to the max wait", async () => {
  const server = await scriptedServer([
    { status: 429, headers: { "retry-after": "999999" } },
    { status: 200, headers: { "content-type": "application/json" }, body: okBody() },
  ]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.equal(result.error, undefined);
    assert.deepEqual(timer.delays, [30_000]);
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: 500 with no Retry-After retries using the computed backoff", async () => {
  const server = await scriptedServer([
    { status: 500 },
    { status: 200, headers: { "content-type": "application/json" }, body: okBody() },
  ]);
  const timer = stubSetTimeout();
  try {
    const result = await provider(server.url).completeChat({ user: "hi" });
    assert.equal(result.error, undefined);
    assert.equal(server.requests.count, 2);
    assert.deepEqual(timer.delays, [1500]);
  } finally {
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: a network-level TypeError still retries using the computed backoff", async () => {
  const server = await scriptedServer([{ status: 200, headers: { "content-type": "application/json" }, body: okBody() }]);
  const timer = stubSetTimeout();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls++;
    if (calls === 1) return Promise.reject(new TypeError("fetch failed"));
    return originalFetch(...args);
  };
  try {
    const result = await provider(server.url, { retry: { attempts: 2, backoffMs: 100 } }).completeChat({
      user: "hi",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.output, "hi");
    assert.deepEqual(timer.delays, [100]);
  } finally {
    globalThis.fetch = originalFetch;
    timer.restore();
    await server.close();
  }
});

test("OpenAICompatibleProvider.completeChat: an AbortError from timeoutMs still retries (existing behavior preserved)", async () => {
  let count = 0;
  const server = await startServer((req, res) => {
    count++;
    if (count === 1) return; // hang forever on the first attempt
    res.writeHead(200, { "content-type": "application/json" });
    res.end(okBody());
  });
  try {
    const p = provider(server.url, { timeoutMs: 100, retry: { attempts: 2, backoffMs: 50 } });
    const started = Date.now();
    const result = await p.completeChat({ user: "hi" });
    const elapsed = Date.now() - started;
    assert.equal(result.error, undefined);
    assert.equal(result.output, "hi");
    assert.equal(count, 2);
    assert.ok(elapsed < 5000, `expected a quick bounded run, took ${elapsed}ms`);
  } finally {
    await server.close();
  }
});
