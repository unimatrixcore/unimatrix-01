import { RiArrowDownSLine } from "@remixicon/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@unimatrix/ui";
import { InstantVirtualList, useBackgroundList } from "@unimatrix/instant-list";
import { pokerLabDatasetSchema } from "@unimatrix/shared";
import { LabQueryProvider, labListOptions } from "../lib/background-lists";

type Dataset = { id: string; name: string; archived: boolean };
export type DatasetPickerOptions = {
  activeId: string;
  activeName: string;
  changed: (items: readonly Dataset[]) => void;
  select: (item: Dataset) => Promise<void>;
};

export function DatasetPicker(options: DatasetPickerOptions) {
  const query = useMemo(
    () =>
      labListOptions({
        path: "/api/datasets",
        datasetId: "",
        query: { include_archived: "1" },
        getItemId: (item: Dataset) => item.id,
        parseItem: (item) => pokerLabDatasetSchema.parse(item),
      }),
    [],
  );
  const list = useBackgroundList(query);
  const latest = useRef(options);
  latest.current = options;
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string>();
  const content = useRef<HTMLDivElement>(null);
  const search = useRef({ value: "", time: 0 });
  useEffect(() => {
    latest.current.changed(list.items);
  }, [list.items]);
  useEffect(() => {
    if (!open || !focusId) return;
    // Virtual rows mount after scrolling; focus the shared menu item once mounted.
    const focus = () => {
      const item = [
        ...(content.current?.querySelectorAll<HTMLElement>("[data-dataset-id]") ?? []),
      ].find((node) => node.dataset.datasetId === focusId);
      item?.focus({ preventScroll: true });
    };
    focus();
    const observer = new MutationObserver(focus);
    if (content.current) observer.observe(content.current, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [open, focusId]);
  const active = list.items.find((item) => item.id === options.activeId);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setFocusId(options.activeId);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button id="dataset-catalog-label" variant="outline" size="sm" aria-label="Working dataset">
          <span>{active?.name || options.activeName}</span>
          <RiArrowDownSLine aria-hidden="true" className="size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={content}
        className="dataset-dropdown"
        align="end"
        onKeyDownCapture={(event) => {
          const items = list.items;
          if (!items.length) return;
          const index = Math.max(
            0,
            items.findIndex((item) => item.id === focusId),
          );
          let next: number | undefined;
          if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
          if (event.key === "ArrowUp") next = Math.max(0, index - 1);
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = items.length - 1;
          if (
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            (event.key !== " " ||
              (search.current.value !== "" && Date.now() - search.current.time < 700))
          ) {
            event.preventDefault();
            event.stopPropagation();
            const now = Date.now();
            search.current.value =
              (now - search.current.time < 700 ? search.current.value : "") +
              event.key.toLowerCase();
            search.current.time = now;
            const found = items.findIndex((item) =>
              item.name.toLowerCase().startsWith(search.current.value),
            );
            if (found >= 0) next = found;
          }
          if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            setFocusId(items[next]!.id);
          }
        }}
      >
        <DropdownMenuRadioGroup value={options.activeId}>
          <InstantVirtualList
            items={list.items}
            getItemId={(item) => item.id}
            rowHeight={40}
            height={Math.min(260, Math.max(40, list.items.length * 40))}
            {...(focusId === undefined ? {} : { scrollToItemId: focusId })}
            rowRole="presentation"
            ariaLabel="Datasets"
            hasNextPage={list.hasNextPage}
            isFetching={list.isFetching}
            onEndReached={list.onEndReached}
            error={list.error}
            onRetry={async () => {
              await list.refetch();
            }}
            renderItem={(item) => (
              <DropdownMenuRadioItem
                value={item.id}
                data-dataset-id={item.id}
                onFocus={() => {
                  setFocusId(item.id);
                }}
                onSelect={() => {
                  void latest.current.select(item);
                }}
              >
                {item.name}
                {item.archived ? " · Restore" : ""}
              </DropdownMenuRadioItem>
            )}
          />
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

let root: Root | undefined;
export function renderDatasetPicker(options: DatasetPickerOptions) {
  const host = document.getElementById("dataset-catalog");
  if (!host) return;
  root ??= createRoot(host);
  root.render(
    <LabQueryProvider>
      <DatasetPicker {...options} />
    </LabQueryProvider>,
  );
}
