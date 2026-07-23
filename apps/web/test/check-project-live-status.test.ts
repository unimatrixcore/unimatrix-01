import { afterEach, describe, expect, it, vi } from "vitest";

import { checkProjectLiveStatus } from "@/features/public-site/queries/check-project-live-status";

describe("checkProjectLiveStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves to live when the fetch succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkProjectLiveStatus("https://cube.unimatrix-01.dev")).resolves.toBe("live");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cube.unimatrix-01.dev",
      expect.objectContaining({ method: "HEAD", mode: "no-cors" }),
    );
  });

  it("resolves to offline when the fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(checkProjectLiveStatus("https://cube.unimatrix-01.dev")).resolves.toBe(
      "offline",
    );
  });

  it("resolves to offline when the request times out", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      ),
    );

    const pendingCheck = checkProjectLiveStatus("https://cube.unimatrix-01.dev");

    await vi.advanceTimersByTimeAsync(5000);

    await expect(pendingCheck).resolves.toBe("offline");
  });
});
