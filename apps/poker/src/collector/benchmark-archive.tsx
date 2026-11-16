import { useState } from "react";
import { Badge } from "@unimatrix/ui/public";
import { NativeSelect } from "@unimatrix/ui/native-select";
import { InstantVirtualGrid, useBackgroundList } from "@unimatrix/instant-list";
import { pokerLabDatasetSchema, pokerLabDatabaseItemSchema } from "@unimatrix/shared";
import { labListOptions } from "../lib/background-lists";
import { mediaUrl } from "../lib/native-transport";
import { WorkspaceTopbar } from "./workspace_topbar";

type Dataset = ReturnType<typeof pokerLabDatasetSchema.parse>;
type Crop = ReturnType<typeof pokerLabDatabaseItemSchema.parse>;

export function BenchmarkArchive() {
  const [datasetId, setDatasetId] = useState("");
  const datasets = useBackgroundList(
    labListOptions<Dataset>({
      path: "/api/datasets",
      query: { include_archived: "1" },
      getItemId: (item) => item.id,
      parseItem: (value) => pokerLabDatasetSchema.parse(value),
    }),
  );
  const current = datasetId || datasets.items[0]?.id || "";
  const crops = useBackgroundList(
    labListOptions<Crop>({
      path: "/api/db_entries",
      datasetId: current,
      getItemId: (item) => item.filename,
      parseItem: (value) => pokerLabDatabaseItemSchema.parse(value),
      enabled: !!current,
    }),
  );
  return (
    <section className="gameplay-workspace benchmark-archive" aria-label="Archived OCR Benchmark">
      <WorkspaceTopbar
        ariaLabel="Benchmark archive"
        leading={<Badge variant="outline">Archived · Read-only</Badge>}
        actions={
          <NativeSelect
            aria-label="Archived benchmark dataset"
            value={current}
            onChange={(event) => {
              setDatasetId(event.target.value);
            }}
          >
            {datasets.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
        }
      />
      {datasets.error && <p role="alert">{datasets.error.message}</p>}
      <InstantVirtualGrid
        ariaLabel="Archived benchmark crops"
        items={crops.items}
        getItemId={(item) => item.filename}
        rowHeight={150}
        minColumnWidth={200}
        height="min(70vh,700px)"
        isFetching={crops.isFetching}
        error={crops.error}
        hasNextPage={crops.hasNextPage}
        onEndReached={crops.onEndReached}
        onRetry={() => {
          void crops.refetch();
        }}
        renderItem={(item) => (
          <article className="benchmark-archive-crop">
            <img
              loading="lazy"
              src={mediaUrl(
                `${typeof item.image_url === "string" ? item.image_url : `/api/db_image/${encodeURIComponent(item.filename)}`}?dataset_id=${encodeURIComponent(current)}`,
              )}
              alt={item.filename}
            />
            <strong>{item.label || "∅"}</strong>
            <small>{typeof item.region_id === "string" ? item.region_id : item.filename}</small>
          </article>
        )}
      />
    </section>
  );
}
