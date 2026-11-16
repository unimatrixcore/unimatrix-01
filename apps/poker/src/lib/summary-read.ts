import { abortableDelay } from "@unimatrix/instant-list";
import { pokerLabResponseSchema, type PokerLabResponse } from "@unimatrix/shared";

export async function readWithSummaryRetry(
  read: () => Promise<unknown>,
  path: string,
  signal?: AbortSignal | null,
): Promise<PokerLabResponse> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = pokerLabResponseSchema.parse(await read());
    signal?.throwIfAborted();
    const error = response.body as { error?: unknown } | null;
    if (
      attempt >= 2 ||
      !/^\/api\/gameplay\/sessions\/[^/]+(?:\/frames)?$/.test(path) ||
      response.status !== 409 ||
      ![
        "Frame evidence changed during summary read; retry",
        "Frame profile changed during summary read; retry",
      ].includes(typeof error?.error === "string" ? error.error : "")
    )
      return response;
    await abortableDelay(100 * 2 ** attempt, signal ?? new AbortController().signal);
  }
}
