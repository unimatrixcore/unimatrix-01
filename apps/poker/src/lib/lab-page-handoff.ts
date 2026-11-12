import {
  pokerLabPageHandoffSchema,
  pokerLabListItemSchema,
  pokerGameplaySessionSchema,
} from "@unimatrix/shared";
const key = "poker-lab:first-page:v1",
  maxBytes = 256 * 1024,
  ttl = 15_000;
let generation = 0;
export function handoffGeneration() {
  return generation;
}
export function clearLabPageHandoff() {
  generation++;
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Storage can be unavailable. */
  }
}
export function storeLabPageHandoff(value: unknown, expectedGeneration: number): void {
  if (expectedGeneration !== generation) return;
  const parsed = pokerLabPageHandoffSchema.safeParse(value);
  if (!parsed.success || parsed.data.page.items.length > 100) return;
  const schema =
    parsed.data.path === "/api/queue" ? pokerLabListItemSchema : pokerGameplaySessionSchema;
  if (!parsed.data.page.items.every((item) => schema.safeParse(item).success)) return;
  const encoded = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(encoded).length > maxBytes) return;
  try {
    sessionStorage.setItem(key, encoded);
  } catch {
    /* Storage can be unavailable. */
  }
}
export function consumeLabPageHandoff(
  path: string,
  datasetId: string | undefined,
  query: Record<string, string>,
): unknown {
  if (path !== "/api/queue" && path !== "/api/gameplay") return undefined;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch {
    return undefined;
  }
  if (!raw || new TextEncoder().encode(raw).length > maxBytes) return undefined;
  try {
    const parsed = pokerLabPageHandoffSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return undefined;
    const item = parsed.data,
      age = Date.now() - item.storedAt;
    if (
      age < 0 ||
      age > ttl ||
      item.path !== path ||
      item.datasetId !== (datasetId || null) ||
      JSON.stringify(item.query) !== JSON.stringify(query) ||
      item.page.items.length > 100
    )
      return undefined;
    const schema = item.path === "/api/queue" ? pokerLabListItemSchema : pokerGameplaySessionSchema;
    return item.page.items.every((row) => schema.safeParse(row).success) ? item.page : undefined;
  } catch {
    return undefined;
  }
}
