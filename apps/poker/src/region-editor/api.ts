import {
  pokerRegionEditorStateSchema,
  pokerRegionEditorSaveSchema,
  pokerRegionEditorResponseSchema,
  type PokerRegionEditorConfig,
  type PokerRegionEditorSave,
  type PokerRegionEditorResponse,
} from "@unimatrix/shared";
export async function loadEditorConfig(): Promise<PokerRegionEditorConfig> {
  const response = await fetch("/api/editor/regions");
  const body: unknown = await response.json();
  if (!response.ok) throw new Error("Could not load saved region coordinates.");
  return pokerRegionEditorStateSchema.parse(body);
}
export async function saveEditorConfig(
  config: PokerRegionEditorSave,
): Promise<PokerRegionEditorResponse> {
  const payload = pokerRegionEditorSaveSchema.parse(config);
  const response = await fetch("/api/editor/regions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "Could not save region coordinates.",
    );
  return pokerRegionEditorResponseSchema.parse(body);
}
