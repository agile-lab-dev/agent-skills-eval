// Fake `opencode` CLI used to test OpencodeProvider's real spawn path
// (`spawnOpencodeServer`) without a real opencode install. Reuses the fake
// HTTP server fixture for request handling, then — after printing the
// "listening" line the real CLI prints — writes a bit more to stdout/stderr,
// mimicking the post-startup log chatter (tool calls, crashes, etc.) a real
// `opencode serve` process would produce during a session.
import { createFakeOpencodeServer } from "./fake-opencode-server.mjs";
import { writeFiller } from "./write-filler.mjs";

const server = await createFakeOpencodeServer();
process.stdout.write(`opencode server listening on ${server.url}\n`);

if (process.env.FAKE_OPENCODE_HUGE_LOG === "1") {
  // Emit >10MB of filler (well past OpencodeProvider's MAX_LOG_BYTES cap)
  // before a final, identifiable tail line, to exercise log truncation
  // without losing the most-recently-written content.
  writeFiller(process.stdout, `${"x".repeat(1000)}\n`, 11 * 1024 * 1024);
  process.stdout.write("post-huge-log tail line\n");
} else {
  setTimeout(() => {
    process.stdout.write("post-startup stdout line\n");
    process.stderr.write("post-startup stderr line\n");
  }, 50);
}
