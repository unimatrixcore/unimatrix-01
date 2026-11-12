import { useEffect, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  backgroundListQueryOptions,
  InstantVirtualGrid,
  useBackgroundList,
} from "@unimatrix/instant-list";
import {
  pokerLabListItemSchema,
  pokerLabDatabaseItemSchema,
  pokerLabFilenameSchema,
  pokerLabNameSuggestionSchema,
  pokerLabDatasetSchema,
  pokerLabDatasetMetaSchema,
  pokerLabHistoryRowSchema,
  pokerLabCompletionRowSchema,
} from "@unimatrix/shared";
import { clearLabPageHandoff } from "./lab-page-handoff";
import {
  LabQueryProvider,
  labListOptions,
  labQueryClient,
  readLabListMeta,
} from "./background-lists";

type Item = Record<string, unknown> & { id: string };
type Options = {
  path: string;
  datasetId: string;
  query: Record<string, string>;
  key: (item: Item) => string;
  card: (item: Item) => HTMLElement;
  dispose?: (item: Item, node: HTMLElement) => void;
  height?: number | string;
  rowHeight?: number;
  minColumnWidth?: number;
  prefix?: Item[];
  emptyLabel?: string;
  changed: (
    items: readonly Item[],
    meta: unknown,
    loading: boolean,
    error: boolean,
    total: number,
  ) => void;
};
const roots = new WeakMap<HTMLElement, Root>();
function optionsFor(options: Options) {
  return labListOptions({
    path: options.path,
    datasetId: options.datasetId,
    query: options.query,
    getItemId: options.key,
    parseItem: (item) => {
      if (options.path === "/api/label_history") {
        const row = pokerLabHistoryRowSchema.parse(item);
        const id = row.payload.id;
        if (typeof id !== "string" && typeof id !== "number")
          throw new Error("Invalid history identity");
        return { ...row, id: `${row.kind}:${id}` };
      }
      return (
        options.path === "/api/db_entries"
          ? pokerLabDatabaseItemSchema
          : options.path === "/api/datasets"
            ? pokerLabDatasetSchema
            : pokerLabListItemSchema
      ).parse(item);
    },
  });
}
function NativeCard({
  item,
  card,
  dispose,
}: {
  item: Item;
  card: Options["card"];
  dispose?: Options["dispose"];
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let node: HTMLElement | undefined;
    const timer = setTimeout(() => {
      node = card(item);
      host.current?.replaceChildren(node);
      const input = node.querySelector<HTMLInputElement>("input.card-label");
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      if (node) {
        dispose?.(item, node);
        window.CollectorSharedUi?.disposeMenus(node);
        node.remove();
      }
    };
  }, [item, card, dispose]);
  return <div ref={host} />;
}
function OcrList({ options }: { options: Options }) {
  const key = JSON.stringify([options.path, options.datasetId, options.query]);
  const listOptions = useMemo(() => optionsFor(options), [key]);
  const list = useBackgroundList(listOptions);
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    latest.current.changed(
      list.items,
      readLabListMeta(list.data?.pages ?? [])?.meta,
      list.isFetching,
      list.isError,
      readLabListMeta(list.data?.pages ?? [])?.total ?? 0,
    );
  }, [list.dataUpdatedAt, list.isFetching, list.isError, key]);
  return (
    <>
      {options.emptyLabel && !list.isPending && !list.isError && list.items.length === 0 && (
        <p role="status">{options.emptyLabel}</p>
      )}
      <InstantVirtualGrid
        items={[...(options.prefix ?? []), ...list.items]}
        getItemId={options.key}
        renderItem={(item) => (
          <NativeCard item={item} card={options.card} dispose={options.dispose} />
        )}
        rowHeight={options.rowHeight ?? 300}
        minColumnWidth={options.minColumnWidth ?? 240}
        gap={12}
        height={options.height ?? "65vh"}
        ariaLabel="Crops"
        onEndReached={list.onEndReached}
        hasNextPage={list.hasNextPage}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={async () => {
          await labQueryClient.resetQueries({ queryKey: listOptions.queryKey, exact: true });
        }}
      />
    </>
  );
}
type SnapshotOptions = {
  items: Item[];
  key: (item: Item) => string;
  card: (item: Item) => HTMLElement;
  height?: number | string;
  rowHeight?: number;
  minColumnWidth?: number;
};
function SnapshotList({ options }: { options: SnapshotOptions }) {
  return (
    <InstantVirtualGrid
      items={options.items}
      getItemId={options.key}
      renderItem={(item) => <NativeCard item={item} card={options.card} />}
      rowHeight={options.rowHeight ?? 300}
      minColumnWidth={options.minColumnWidth ?? 240}
      gap={12}
      height={options.height ?? "65vh"}
      ariaLabel="Crops"
    />
  );
}
export function installOcrBackgroundLists() {
  window.CollectorBackgroundLists = {
    snapshot(host, options) {
      let root = roots.get(host);
      if (!root) {
        root = createRoot(host);
        roots.set(host, root);
      }
      root.render(<SnapshotList options={options} />);
    },
    render(host, options) {
      let root = roots.get(host);
      if (!root) {
        root = createRoot(host);
        roots.set(host, root);
      }
      root.render(
        <LabQueryProvider>
          <OcrList options={options} />
        </LabQueryProvider>,
      );
    },
    async historySummary(datasetId, runId, stats, lookup) {
      const makeOptions = (query: Record<string, string>) =>
        labListOptions<Record<string, unknown>>({
          path: "/api/get_session_history",
          datasetId,
          query,
          getItemId: (item) => String(item.timestamp),
          parseItem: (item) => pokerLabCompletionRowSchema.parse(item),
          pageSize: 500,
        });
      const ranked = await makeOptions({ order: "score" }).fetchPage({
        cursor: null,
        limit: 5,
        priority: "high",
        signal: new AbortController().signal,
      });
      const top = [...ranked.items];
      if (!lookup) return top;
      const options = makeOptions({ order: "recent" }),
        matches: Record<string, unknown>[] = [];
      let run: Record<string, unknown> | undefined,
        cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await options.fetchPage({
          cursor,
          limit: 500,
          priority: "high",
          signal: new AbortController().signal,
        });
        for (const row of page.items) {
          if (runId && row.review_run_id === runId) run = row;
          if (
            stats &&
            stats.items > 0 &&
            stats.time > 0 &&
            typeof row.avgTime === "number" &&
            typeof row.rpm === "number" &&
            row.items === stats.items &&
            row.avgTime === Math.round(stats.time / stats.items) &&
            row.rpm === Number((60000 / (stats.time / stats.items)).toFixed(1)) &&
            matches.length < 2
          )
            matches.push(row);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Repeated history cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      const extra = [...matches, ...(run && !matches.includes(run) ? [run] : [])];
      return [
        ...top.filter(
          (row) =>
            !extra.some(
              (item) =>
                item.timestamp === row.timestamp &&
                item.score === row.score &&
                item.review_run_id === row.review_run_id,
            ),
        ),
        ...extra,
      ];
    },
    async resolveDataset(remembered) {
      const options = labListOptions<{ id: string; name: string; archived: boolean }>({
        path: "/api/datasets",
        query: { include_archived: "1" },
        getItemId: (item) => item.id,
        parseItem: (item) => pokerLabDatasetSchema.parse(item),
        pageSize: 500,
      });
      const first = await options.fetchPage({
        cursor: null,
        limit: 500,
        priority: "high",
        signal: new AbortController().signal,
      });
      const meta = pokerLabDatasetMetaSchema.parse(readLabListMeta([first])?.meta);
      const desired = remembered || meta.default_dataset_id;
      let found = first.items.find((item) => item.id === desired && !item.archived);
      let fallback =
        first.items.find((item) => item.id === meta.default_dataset_id && !item.archived) ??
        first.items.find((item) => !item.archived);
      let cursor = first.nextCursor;
      const seen = new Set<string>();
      while (cursor && (!found || !fallback)) {
        if (seen.has(cursor)) throw new Error("Repeated dataset cursor");
        seen.add(cursor);
        const page = await options.fetchPage({
          cursor,
          limit: 500,
          priority: "high",
          signal: new AbortController().signal,
        });
        found ??= page.items.find((item) => item.id === desired && !item.archived);
        fallback ??=
          page.items.find((item) => item.id === meta.default_dataset_id && !item.archived) ??
          page.items.find((item) => !item.archived);
        cursor = page.nextCursor;
      }
      const selected = found ?? fallback;
      if (!selected) throw new Error("No dataset is available");
      return {
        items: first.items.some((item) => item.id === selected.id)
          ? [...first.items]
          : [...first.items, selected],
        default_dataset_id: selected.id,
      };
    },
    async readPages(path, datasetId, query, kind, all) {
      const schema =
        kind === "database"
          ? pokerLabDatabaseItemSchema
          : kind === "filenames"
            ? pokerLabFilenameSchema
            : kind === "names"
              ? pokerLabNameSuggestionSchema
              : pokerLabDatasetSchema;
      const options = labListOptions<Record<string, unknown>>({
        path,
        ...(datasetId ? { datasetId } : {}),
        query,
        getItemId: (item) => JSON.stringify(item),
        parseItem: (item) => schema.parse(item),
        pageSize: 500,
      });
      const items: Record<string, unknown>[] = [];
      let cursor: string | null = null;
      let meta: unknown;
      const seen = new Set<string>();
      do {
        const page = await options.fetchPage({
          cursor,
          limit: 500,
          priority: "high",
          signal: new AbortController().signal,
        });
        items.push(...page.items);
        meta = readLabListMeta([page])?.meta;
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("Repeated list cursor");
        if (cursor) seen.add(cursor);
      } while (all && cursor);
      if (kind === "datasets") pokerLabDatasetMetaSchema.parse(meta);
      return { items, meta, cursor };
    },
    invalidate(path, datasetId) {
      if (path === "/api/queue" || path === "/api/gameplay") clearLabPageHandoff();
      return labQueryClient.resetQueries({
        predicate: (query) =>
          query.queryKey[0] === "lab-list" &&
          query.queryKey[1] === path &&
          (!datasetId || query.queryKey[2] === datasetId),
      });
    },
    prefetch(options) {
      void labQueryClient.prefetchInfiniteQuery({
        ...backgroundListQueryOptions(optionsFor(options)),
        pages: 1,
      });
    },
    clear(host) {
      const root = roots.get(host);
      if (root) {
        root.unmount();
        roots.delete(host);
      }
    },
  };
}
declare global {
  interface Window {
    CollectorBackgroundLists: {
      snapshot: (host: HTMLElement, options: SnapshotOptions) => void;
      render: (host: HTMLElement, options: Options) => void;
      historySummary: (
        datasetId: string,
        runId: string | null,
        stats: { items: number; time: number } | null,
        lookup: boolean,
      ) => Promise<Record<string, unknown>[]>;
      resolveDataset: (remembered: string | null) => Promise<{
        items: Array<{ id: string; name: string; archived: boolean }>;
        default_dataset_id: string;
      }>;
      readPages: (
        path: string,
        datasetId: string | null,
        query: Record<string, string>,
        kind: "filenames" | "names" | "datasets" | "database",
        all: boolean,
      ) => Promise<{ items: Record<string, unknown>[]; meta: unknown; cursor: string | null }>;
      invalidate: (path: string, datasetId: string) => Promise<void>;
      prefetch: (options: Options) => void;
      clear: (host: HTMLElement) => void;
    };
  }
}
