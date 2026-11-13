import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { InstantVirtualList, type InstantVirtualListProps } from "./instant-virtual-list";

export interface InstantVirtualGridProps<T> extends Omit<
  InstantVirtualListProps<T>,
  | "items"
  | "getItemId"
  | "renderItem"
  | "rowHeight"
  | "role"
  | "rowRole"
  | "measureRows"
  | "scrollToItemId"
> {
  items: readonly T[];
  getItemId: (item: T) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  rowHeight: number;
  minColumnWidth: number;
  gap?: number;
}
export function InstantVirtualGrid<T>({
  items,
  getItemId,
  renderItem,
  rowHeight,
  minColumnWidth,
  gap = 8,
  ...listProps
}: InstantVirtualGridProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  const columns = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
  const rows = useMemo(() => {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += columns) result.push(items.slice(i, i + columns));
    return result;
  }, [items, columns]);
  return (
    <div
      ref={container}
      style={{
        height: listProps.getScrollElement ? "auto" : (listProps.height ?? 480),
        minWidth: 0,
      }}
    >
      <InstantVirtualList
        {...listProps}
        height="100%"
        items={rows}
        rowHeight={rowHeight + gap}
        measureRows
        rowRole="presentation"
        getItemId={(row) => (row[0] === undefined ? "empty" : getItemId(row[0]))}
        renderItem={(row, rowIndex) => (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              gap,
              paddingBottom: gap,
            }}
          >
            {row.map((item, index) => (
              <div role="listitem" key={getItemId(item)}>
                {renderItem(item, rowIndex * columns + index)}
              </div>
            ))}
          </div>
        )}
      />
    </div>
  );
}
