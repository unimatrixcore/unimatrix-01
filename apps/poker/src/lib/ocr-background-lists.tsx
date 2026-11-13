import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { waitForViewport } from "./viewport-ready";
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
  fillViewport?: boolean;
  changed: (
    items: readonly Item[],
    meta: unknown,
    loading: boolean,
    error: boolean,
    total: number,
  ) => void;
};
const roots = new WeakMap<HTMLElement, Root>();
let generation = 0;
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
  estimatedHeight,
  measuredHeight,
}: {
  item: Item;
  card: Options["card"];
  dispose?: Options["dispose"];
  estimatedHeight: number;
  measuredHeight: { current: number | null };
}) {
  const host = useRef<HTMLDivElement>(null);
  const placeholderHeight = useRef(measuredHeight.current ?? estimatedHeight);
  const ownMeasuredHeight = useRef<number | null>(null);
  useEffect(() => {
    let node: HTMLElement | undefined;
    let frame = 0;
    const timer = setTimeout(() => {
      node = card(item);
      host.current?.replaceChildren(node);
      host.current?.style.removeProperty("min-height");
      frame = requestAnimationFrame(() => {
        const height = host.current?.getBoundingClientRect().height;
        if (height) {
          ownMeasuredHeight.current = height;
          measuredHeight.current = height;
        }
      });
      const input = node.querySelector<HTMLInputElement>("input.card-label");
      if (input) {
        input.focus({ preventScroll: true });
        input.select();
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      if (node) {
        if (host.current)
          host.current.style.minHeight = `${ownMeasuredHeight.current ?? placeholderHeight.current}px`;
        dispose?.(item, node);
        window.CollectorSharedUi?.disposeMenus(node);
        node.remove();
      }
    };
  }, [item, card, dispose, estimatedHeight, measuredHeight]);
  return <div ref={host} data-native-card style={{ minHeight: placeholderHeight.current }} />;
}
const getWorkspaceScroller = () => document.getElementById("main-content");

function useGridColumnWidth(fallback = 240) {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width:760px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width:760px)");
    const update = () => {
      setNarrow(media.matches);
    };
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);
  return narrow && fallback === 240 ? 200 : fallback;
}

function useCollectionDockSpace(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!enabled || !ref.current) return;
    const node = ref.current;
    const dock = document.getElementById("record-dock");
    const update = () => {
      if (dock)
        node.style.setProperty(
          "--record-dock-space",
          `${Math.max(0, window.innerHeight - dock.getBoundingClientRect().top + 16)}px`,
        );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (dock) observer.observe(dock);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [enabled]);
  return ref;
}
function OcrList({ options, revision }: { options: Options; revision: number }) {
  const key = JSON.stringify([options.path, options.datasetId, options.query]);
  const listOptions = useMemo(() => optionsFor(options), [key]);
  const list = useBackgroundList(listOptions);
  const latest = useRef(options);
  const measuredHeight = useRef<number | null>(null);
  const collectionRef = useCollectionDockSpace(!!options.fillViewport);
  const minColumnWidth = useGridColumnWidth(options.minColumnWidth);
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
    <div
      ref={collectionRef}
      data-list-revision={revision}
      data-list-state={list.isError ? "error" : list.isSuccess ? "ready" : "pending"}
      data-list-count={list.items.length + (options.prefix?.length ?? 0)}
      data-list-complete={!list.isPending && !list.hasNextPage}
      data-list-paused={list.pauseReason ?? ""}
      className={options.fillViewport ? "collection-virtual-list" : undefined}
    >
      {options.emptyLabel && !list.isPending && !list.isError && list.items.length === 0 && (
        <p role="status">{options.emptyLabel}</p>
      )}
      <InstantVirtualGrid
        items={[...(options.prefix ?? []), ...list.items]}
        getItemId={options.key}
        renderItem={(item) => (
          <NativeCard
            item={item}
            card={options.card}
            dispose={options.dispose}
            estimatedHeight={options.rowHeight ?? 300}
            measuredHeight={measuredHeight}
          />
        )}
        rowHeight={options.rowHeight ?? 300}
        minColumnWidth={minColumnWidth}
        gap={12}
        {...(options.height === undefined
          ? { getScrollElement: getWorkspaceScroller }
          : { height: options.height })}
        ariaLabel="Crops"
        onEndReached={list.onEndReached}
        hasNextPage={list.hasNextPage}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={async () => {
          await labQueryClient.resetQueries({ queryKey: listOptions.queryKey, exact: true });
        }}
      />
    </div>
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
function SnapshotList({ options, revision }: { options: SnapshotOptions; revision: number }) {
  const minColumnWidth = useGridColumnWidth(options.minColumnWidth);
  const measuredHeight = useRef<number | null>(null);
  return (
    <div
      data-list-revision={revision}
      data-list-state="ready"
      data-list-count={options.items.length}
      data-list-complete="true"
    >
      <InstantVirtualGrid
        items={options.items}
        getItemId={options.key}
        renderItem={(item) => (
          <NativeCard
            item={item}
            card={options.card}
            estimatedHeight={options.rowHeight ?? 300}
            measuredHeight={measuredHeight}
          />
        )}
        rowHeight={options.rowHeight ?? 300}
        minColumnWidth={minColumnWidth}
        gap={12}
        {...(options.height === undefined
          ? { getScrollElement: getWorkspaceScroller }
          : { height: options.height })}
        ariaLabel="Crops"
      />
    </div>
  );
}
export function installOcrBackgroundLists() {
  window.CollectorBackgroundLists = {
    snapshot(host, options) {
      host.dataset.listExpected = "snapshot";
      const revision = ++generation;
      host.dataset.listRevision = String(revision);
      let root = roots.get(host);
      if (!root) {
        root = createRoot(host);
        roots.set(host, root);
      }
      root.render(<SnapshotList options={options} revision={revision} />);
    },
    render(host, options) {
      host.dataset.listExpected = "query";
      const revision = ++generation;
      host.dataset.listRevision = String(revision);
      let root = roots.get(host);
      if (!root) {
        root = createRoot(host);
        roots.set(host, root);
      }
      root.render(
        <LabQueryProvider>
          <OcrList options={options} revision={revision} />
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
    async readPages(path, datasetId, query, kind, all, signal = new AbortController().signal) {
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
          signal,
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
      delete host.dataset.listExpected;
      delete host.dataset.listRevision;
    },
    waitForViewport,
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
        signal?: AbortSignal,
      ) => Promise<{ items: Record<string, unknown>[]; meta: unknown; cursor: string | null }>;
      invalidate: (path: string, datasetId: string) => Promise<void>;
      prefetch: (options: Options) => void;
      clear: (host: HTMLElement) => void;
      waitForViewport: typeof waitForViewport;
    };
  }
}
