import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createInstantQueryClient } from "./use-background-list";

export function InstantListProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createInstantQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
export interface InstantVirtualListProps<T> {
  items: readonly T[];
  getItemId: (item: T) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  rowHeight: number;
  height?: number | string;
  onEndReached?: () => void | Promise<void>;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void | Promise<void>;
  hasNextPage?: boolean;
  ariaLabel?: string;
  className?: string;
  role?: "list" | "table";
  rowRole?: "listitem" | "row" | "presentation";
  header?: ReactNode;
  measureRows?: boolean;
}
export function InstantVirtualList<T>({
  items,
  getItemId,
  renderItem,
  rowHeight,
  height = 480,
  onEndReached,
  isFetching = false,
  error,
  onRetry,
  hasNextPage = false,
  ariaLabel,
  className,
  role = "list",
  rowRole = "listitem",
  header,
  measureRows = false,
}: InstantVirtualListProps<T>) {
  const parent = useRef<HTMLDivElement>(null);
  const [scrollIntent, setScrollIntent] = useState(false);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getItemId(item);
    },
    overscan: 5,
    initialRect: { width: 800, height: typeof height === "number" ? height : 480 },
  });
  const rows = virtualizer.getVirtualItems();
  const end = rows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (scrollIntent && hasNextPage && !isFetching && end >= items.length - 6) {
      setScrollIntent(false);
      void onEndReached?.();
    }
  }, [scrollIntent, end, items.length, hasNextPage, isFetching, onEndReached]);
  return (
    <div style={{ position: "relative", height, minHeight: 0 }} className={className}>
      <div
        ref={parent}
        role={role}
        tabIndex={0}
        onScroll={() => {
          setScrollIntent(true);
        }}
        onWheel={(event) => {
          if (event.deltaY > 0) setScrollIntent(true);
        }}
        onKeyDown={(event) => {
          if (["End", "PageDown", "ArrowDown"].includes(event.key)) setScrollIntent(true);
        }}
        aria-label={ariaLabel}
        style={{
          height: "100%",
          overflow: "auto",
          scrollbarGutter: "stable",
          overflowAnchor: "none",
        }}
      >
        {header}
        <div
          role={role === "table" ? "rowgroup" : "presentation"}
          style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
        >
          {rows.map((row) => {
            const item = items[row.index];
            if (item === undefined) return null;
            return (
              <div
                key={row.key}
                ref={measureRows ? virtualizer.measureElement : undefined}
                data-index={row.index}
                role={rowRole}
                aria-posinset={role === "list" ? row.index + 1 : undefined}
                aria-setsize={role === "list" && !hasNextPage ? items.length : undefined}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  ...(measureRows ? {} : { height: rowHeight, overflow: "hidden" }),
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {renderItem(item, row.index)}
              </div>
            );
          })}
        </div>
      </div>
      {error !== undefined && error !== null && !isFetching && (
        <div role="alert" style={{ position: "absolute", bottom: 4, right: 12, fontSize: 12 }}>
          Could not load more.
          {onRetry && (
            <button
              type="button"
              onClick={() => {
                void onRetry();
              }}
              style={{ marginLeft: 8 }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {isFetching && end >= items.length - 6 && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            bottom: 4,
            right: 12,
            pointerEvents: "none",
            fontSize: 12,
          }}
        >
          Loading more…
        </div>
      )}
    </div>
  );
}
