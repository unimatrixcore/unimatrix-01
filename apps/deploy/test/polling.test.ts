import assert from "node:assert/strict";
import test from "node:test";

import { startContainerPolling } from "../src/observe/polling.js";

void test("polling starts immediately, serializes samples, and stops on request", async () => {
  let calls = 0;
  let finishFirst: (() => void) | undefined;
  let finishSecond: (() => void) | undefined;
  let notifySecond: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    notifySecond = resolve;
  });

  const stop = startContainerPolling(
    {
      poll: () => {
        calls += 1;
        if (calls === 1)
          return new Promise<readonly []>((resolve) => {
            finishFirst = () => {
              resolve([]);
            };
          });
        notifySecond?.();
        return new Promise<readonly []>((resolve) => {
          finishSecond = () => {
            resolve([]);
          };
        });
      },
    },
    () => assert.fail("poll should not fail"),
    1,
  );

  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);

  finishFirst?.();
  await secondStarted;
  assert.equal(calls, 2);
  stop();
  finishSecond?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
});
