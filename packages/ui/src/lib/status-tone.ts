export type StatusTone = "ok" | "warn" | "bad" | "idle";

export const STATUS_DOT_CLASSES: Readonly<Record<StatusTone, string>> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/60",
};

export const STATUS_TEXT_CLASSES: Readonly<Record<StatusTone, string>> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-destructive",
  idle: "text-muted-foreground",
};

export function getUptimeTone(uptime: number | null | undefined): StatusTone {
  if (uptime == null || !Number.isFinite(uptime) || uptime < 0 || uptime > 1) return "idle";
  if (uptime >= 0.999) return "ok";
  if (uptime >= 0.99) return "warn";
  return "bad";
}
