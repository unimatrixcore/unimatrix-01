import { QueryClientProvider } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  configureListMemoryProvider,
  createInstantQueryClient,
  createInvokePageFetcher,
  type BackgroundListOptions,
  type ListPage,
} from "@unimatrix/instant-list";
import {
  pokerLabRequestSchema,
  pokerLabResponseSchema,
  pokerLabSystemMemorySchema,
  pokerLabListPageSchema,
  pokerLabListMetaSchema,
} from "@unimatrix/shared";
import type { ReactNode } from "react";
import { consumeLabPageHandoff, clearLabPageHandoff } from "./lab-page-handoff";

export const labQueryClient = createInstantQueryClient();
export function LabQueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={labQueryClient}>{children}</QueryClientProvider>;
}
configureListMemoryProvider(async () => {
  if (!isTauri()) return { totalBytes: 4 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 };
  return pokerLabSystemMemorySchema.parse(await invoke("get_system_memory_info", { input: null }));
});
type LabPage<T> = ListPage<T, string> & { total: number; meta: unknown };
export function readLabListMeta<T>(
  pages: readonly ListPage<T, string>[],
): { total: number; meta: unknown } | undefined {
  const result = pokerLabListMetaSchema.safeParse(pages.at(-1));
  return result.success ? result.data : undefined;
}
export function labListOptions<T>({
  path,
  datasetId,
  query = {},
  getItemId,
  parseItem,
  enabled,
  pageSize = 250,
}: {
  path: string;
  datasetId?: string;
  query?: Record<string, string>;
  getItemId: (item: T) => string | number;
  parseItem: (value: unknown) => T;
  enabled?: boolean;
  pageSize?: number;
}): BackgroundListOptions<T, string> {
  const request = pokerLabRequestSchema.parse({
    method: "GET",
    path,
    query,
    headers: datasetId ? { "x-dataset-id": datasetId } : {},
    body: null,
  });
  return {
    queryKey: ["lab-list", path, datasetId ?? null, query],
    getItemId,
    transport: "tauri",
    pageSize,
    ...(enabled === undefined ? {} : { enabled }),
    fetchPage: async (context) => {
      if (context.cursor === null) {
        const saved = consumeLabPageHandoff(path, datasetId, query);
        if (saved) {
          const body = pokerLabListPageSchema.parse(saved);
          return {
            items: body.items.map(parseItem),
            nextCursor: body.nextCursor,
            total: body.total,
            meta: body.meta,
          } as LabPage<T>;
        }
      }
      return createInvokePageFetcher({
        command: "lab_list_page",
        args: { request },
        invoke: async (command, args) => {
          const fixture =
            import.meta.env.MODE === "test-browser" ? window.__POKER_LAB_TEST_INVOKE__ : undefined;
          if (fixture)
            return fixture({
              ...request,
              query: {
                ...request.query,
                background_page: "1",
                limit: String(args.limit),
                ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
              },
            });
          return invoke(command, args);
        },
        parse: (value) => {
          const response = pokerLabResponseSchema.parse(value);
          if (response.status < 200 || response.status >= 300)
            throw new Error(`List request failed (${response.status})`);
          const body = pokerLabListPageSchema.parse(response.body);
          return {
            items: body.items.map(parseItem),
            nextCursor: body.nextCursor,
            total: body.total,
            meta: body.meta,
          } as LabPage<T>;
        },
      })(context);
    },
  };
}
export function invalidateLabLists(scope?: { path?: string; datasetId?: string }): Promise<void> {
  clearLabPageHandoff();
  return labQueryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "lab-list" &&
      (scope?.path === undefined || query.queryKey[1] === scope.path) &&
      (scope?.datasetId === undefined || query.queryKey[2] === scope.datasetId),
  });
}
