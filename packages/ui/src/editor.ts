/**
 * The editing surface, kept out of both other entry points on purpose.
 *
 * This split is not stylistic. Measured on this app's production build: a
 * barrel's whole re-export graph lands in the chunk that imports it, whether
 * or not anything imports the symbols. Adding one line — `export {
 * MarkdownEditor }` — to `./public` took the eagerly-loaded set (every script
 * `index.html` preloads) from 954.55 kB to 1452.14 kB raw, 289.62 kB to
 * 458.87 kB gzipped: CodeMirror, shipped to every anonymous reader on every
 * page, with nothing in `apps/web` importing it. Measure it that way rather
 * than by chunk name — rolldown reshuffles chunk boundaries and names between
 * tree states, so the eager total is the number that stays comparable.
 *
 * Three cheaper explanations were tested and ruled out. `sideEffects: false`
 * and `treeshake: { moduleSideEffects: false }` each changed nothing. Nor is
 * the cause the dynamic *namespace* import in
 * `apps/web/src/features/content/lazy-public-markdown.tsx`: replacing that
 * `await import("@unimatrix/ui/public")` with a static named import left the
 * editor in the eager set all the same. Dropping the export from `./public`
 * is the only change that moved it back behind a lazy boundary.
 *
 * So `./public` stays the narrow primitive set the public site imports,
 * pinned to an exact export list by `apps/web/test/public-ui-usage.test.ts`,
 * the root barrel stays un-importable from `apps/web`, and everything the
 * editor needs lives here. Anything added here reaches the browser only
 * through a dynamic `import()`; anything moved to `./public` is paid for by
 * every visitor.
 *
 * The name is the editor because that is what forced the split, but the
 * entry point is the whole authoring surface: the primitives below are here
 * so the CMS's table and dialogs have somewhere to come from that is not
 * `./public`. `Badge` and `Button` are deliberately re-exported rather than
 * imported from `./public` alongside these — one import specifier per module
 * in the admin code, and the shared modules dedupe in the graph either way.
 */
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog.js";
export { Alert, AlertTitle, AlertDescription } from "./components/ui/alert.js";
export { Badge } from "./components/ui/badge.js";
export { Button } from "./components/ui/button.js";
export { Checkbox } from "./components/ui/checkbox.js";
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty.js";
export { Input } from "./components/ui/input.js";
export { Label } from "./components/ui/label.js";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
export { Separator } from "./components/ui/separator.js";
// Not a Tailwind `sm:hidden` pair: a table and a compact list are different
// markup for the same rows, and shipping both would put two controls with the
// same accessible name in the tree at once.
export { useIsMobile } from "./hooks/use-mobile.js";
export { Skeleton } from "./components/ui/skeleton.js";
export { Spinner } from "./components/ui/spinner.js";
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.js";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs.js";
export { Textarea } from "./components/ui/textarea.js";
export { Toaster } from "./components/ui/sonner.js";
// Re-exported rather than imported from `sonner` by the consumer: `<Toaster />`
// and the `toast()` feeding it must come from the same resolved copy, and this
// keeps `sonner` out of `apps/web`'s own dependency list.
export { toast } from "sonner";
export { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group.js";
export { cn } from "./lib/utils.js";
export {
  MarkdownEditor,
  MARKDOWN_EDITOR_MODES,
} from "./components/markdown-editor/markdown-editor.js";
export type {
  MarkdownEditorHandle,
  MarkdownEditorMode,
  MarkdownEditorProps,
} from "./components/markdown-editor/markdown-editor.js";
export { markdownLivePreview } from "./components/markdown-editor/live-preview.js";
export { STATUS_DOT_CLASSES, STATUS_TEXT_CLASSES, getUptimeTone } from "./lib/status-tone.js";
export type { StatusTone } from "./lib/status-tone.js";
export { StatusDot } from "./components/ui/status-dot.js";
export type { StatusDotProps } from "./components/ui/status-dot.js";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./components/ui/tooltip.js";
export { Popover, PopoverTrigger, PopoverContent } from "./components/ui/popover.js";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./components/ui/dropdown-menu.js";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./components/ui/card.js";
export type { CardHeight, CardProps } from "./components/ui/card.js";
export { DigestCard } from "./components/ui/digest-card.js";
export type { DigestCardProps } from "./components/ui/digest-card.js";
export { DigestCardGrid } from "./components/ui/digest-card-grid.js";
export type { DigestCardGridProps } from "./components/ui/digest-card-grid.js";
export { DigestRowList, DigestRow } from "./components/ui/digest-row-list.js";
export type { DigestRowListProps, DigestRowProps } from "./components/ui/digest-row-list.js";
export { UptimeStrip } from "./components/ui/uptime-strip.js";
export type { UptimeStripProps, UptimeSample } from "./components/ui/uptime-strip.js";

export { ScrollArea, ScrollBar } from "./components/ui/scroll-area.js";
export type { ScrollAreaProps, ScrollAreaViewportProps } from "./components/ui/scroll-area.js";

export { ActionTooltip } from "./components/ui/action-tooltip.js";
export type { ActionTooltipProps } from "./components/ui/action-tooltip.js";
