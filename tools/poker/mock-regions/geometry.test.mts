import assert from "node:assert/strict";
import test from "node:test";
import { boundsOf, loopbackUrl } from "./geometry.mts";

test("rejects remote origins and embedded credentials", () => {
  for (const url of [
    "https://localhost:5173",
    "http://example.org",
    "http://localhost.evil.test",
    "http://user:password@localhost:5173",
  ])
    assert.throws(() => loopbackUrl(url));
  assert.equal(loopbackUrl("http://127.0.0.1:5173"), "http://127.0.0.1:5173/");
});
test("preserves rotated crop envelope without truncating corners", () => {
  assert.deepEqual(
    boundsOf([
      { x: 2, y: 3 },
      { x: 8, y: 1 },
      { x: 10, y: 7 },
      { x: 4, y: 9 },
    ]),
    { x: 2, y: 1, width: 8, height: 8 },
  );
  assert.throws(() =>
    boundsOf([
      { x: NaN, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 4 },
    ]),
  );
});
