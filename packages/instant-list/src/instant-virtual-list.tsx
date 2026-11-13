import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  scrollToItemId?: string | number;
  getScrollElement?: () => HTMLElement | null;
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
  scrollToItemId,
  getScrollElement,
}: InstantVirtualListProps<T>) {
  const parent = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [externalVisible, setExternalVisible] = useState(false);
  useLayoutEffect(() => {
    const node = parent.current,
      scroller = getScrollElement?.();
    if (!node || !scroller) return;
    const update = () => {
      setExternalVisible(node.getClientRects().length > 0);
      setScrollMargin(
        node.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          scroller.clientTop +
          scroller.scrollTop,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    observer.observe(node);
    for (
      let ancestor = node.parentElement;
      ancestor && ancestor !== scroller;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor);
    }
    return () => {
      observer.disconnect();
    };
  }, [getScrollElement]);
  const [scrollIntent, setScrollIntent] = useState(false);
  useEffect(() => {
    const scroller = getScrollElement?.();
    if (!scroller) return;
    const onScroll = () => {
      setScrollIntent(true);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [getScrollElement]);
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled: !getScrollElement || externalVisible,
    getScrollElement: getScrollElement ?? (() => parent.current),
    scrollMargin,
    estimateSize: () => rowHeight,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getItemId(item);
    },
    overscan: 5,
    initialRect: { width: 800, height: typeof height === "number" ? height : 480 },
  });
  const requestedIndex =
    scrollToItemId === undefined
      ? -1
      : items.findIndex((item) => getItemId(item) === scrollToItemId);
  useEffect(() => {
    if (requestedIndex >= 0) virtualizer.scrollToIndex(requestedIndex, { align: "auto" });
  }, [scrollToItemId, requestedIndex, virtualizer]);
  const rows = virtualizer.getVirtualItems();
  const end = rows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (scrollIntent && hasNextPage && !isFetching && end >= items.length - 6) {
      setScrollIntent(false);
      void onEndReached?.();
    }
  }, [scrollIntent, end, items.length, hasNextPage, isFetching, onEndReached]);
  return (
    <div
      style={{ position: "relative", height: getScrollElement ? "auto" : height, minHeight: 0 }}
      className={className}
    >
      <div
        ref={parent}
        role={role}
        tabIndex={getScrollElement ? undefined : 0}
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
          height: getScrollElement ? "auto" : "100%",
          overflow: getScrollElement ? "visible" : "auto",
          scrollbarGutter: getScrollElement ? undefined : "stable",
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
                  transform: `translateY(${row.start - scrollMargin}px)`,
                }}
              >
                {renderItem(item, row.index)}
              </div>
            );
          })}
        </div>
      </div>
      {error !== undefined && error !== null && !isFetching && (
        <div
          role="alert"
          style={{
            position: getScrollElement ? "sticky" : "absolute",
            bottom: 4,
            right: 12,
            fontSize: 12,
            ...(getScrollElement ? { width: "fit-content", marginLeft: "auto" } : {}),
          }}
        >
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
            position: getScrollElement ? "sticky" : "absolute",
            bottom: 4,
            right: 12,
            pointerEvents: "none",
            fontSize: 12,
            ...(getScrollElement ? { width: "fit-content", marginLeft: "auto" } : {}),
          }}
        >
          Loading more…
        </div>
      )}
    </div>
  );
}
