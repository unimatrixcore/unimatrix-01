export function gameplayErrorMessage(
  value: unknown,
  fallback = "Unable to load Gameplay data.",
): string {
  return value instanceof Error && value.name !== "ZodError" && value.message.length < 240
    ? value.message
    : fallback;
}
