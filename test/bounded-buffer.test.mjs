import test from "node:test";
import assert from "node:assert/strict";
import { appendBounded } from "../dist/bounded-buffer.js";

test("appendBounded: under the cap returns the exact concatenation, untruncated", () => {
  const result = appendBounded("foo\n", "bar\n", 1024);
  assert.equal(result.value, "foo\nbar\n");
  assert.equal(result.truncated, false);
});

test("appendBounded: the last chunk appended is always fully present, even smaller than a dropped line", () => {
  const bigLine = `${"z".repeat(500)}\n`;
  const first = appendBounded("", bigLine, 100);
  assert.equal(first.truncated, true);

  // Cap tight enough that appending the tiny chunk forces another round of
  // front-dropping (eating into the marker itself), so this actually
  // exercises the tail-preservation guarantee rather than just fitting
  // under the cap with room to spare.
  const tinyChunk = "ok\n";
  const second = appendBounded(first.value, tinyChunk, 10);
  assert.equal(second.truncated, true);
  assert.ok(second.value.endsWith(tinyChunk), "expected the newly appended chunk to be fully preserved");
});

test("appendBounded: past the cap keeps exactly the last maxBytes bytes and marks truncation", () => {
  const hugeLine = "x".repeat(1000);
  const result = appendBounded("", hugeLine, 100);
  assert.equal(result.truncated, true);
  assert.match(result.value, /^# TRUNCATED:/m);
  assert.ok(result.value.endsWith("x".repeat(100)));
});
