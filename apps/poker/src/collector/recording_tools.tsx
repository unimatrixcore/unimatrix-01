import { useState } from "react";
import { Archive, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { Button, Input } from "@unimatrix/ui/public";
import { NativeSelect } from "@unimatrix/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@unimatrix/ui/popover";

type Recording = { id: string; name: string; frame_count: number };
interface RecordingToolsProps {
  current: Recording | null;
  disabled: boolean;
  onNew: () => void;
  onRename: (name: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  loadArchived: () => Promise<Recording[]>;
}

/** Recording equivalents of OCR Data's create, rename, and archive tools. */
export function RecordingTools({
  current,
  disabled,
  onNew,
  onRename,
  onArchive,
  onRestore,
  loadArchived,
}: RecordingToolsProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState("");
  const [archived, setArchived] = useState<Recording[]>([]);
  const [restoreId, setRestoreId] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const blocked = disabled || pending;

  async function perform(action: () => Promise<void>, close: () => void) {
    setPending(true);
    setError("");
    try {
      await action();
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }

  async function manage(open: boolean) {
    setManageOpen(open);
    setError("");
    if (!open) return;
    setLoading(true);
    try {
      const items = await loadArchived();
      setArchived(items);
      setRestoreId(items[0]?.id || "");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="dataset-tools" aria-label="Recording tools">
      <Button
        variant="ghost"
        size="icon-sm"
        className="dataset-icon"
        aria-label="New recording"
        title="New recording"
        disabled={blocked}
        onClick={onNew}
      >
        <Plus size={16} />
      </Button>
      <Popover
        open={renameOpen}
        onOpenChange={(open) => {
          setRenameOpen(open);
          setName(current?.name || "");
          setError("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="dataset-icon"
            aria-label="Rename recording"
            title="Rename recording"
            disabled={blocked || !current}
          >
            <Pencil size={16} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="recording-settings-popover rounded-none border-0 ring-0 animate-none transition-none"
        >
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim())
                void perform(
                  () => onRename(name.trim()),
                  () => {
                    setRenameOpen(false);
                  },
                );
            }}
          >
            <label className="grid gap-2 text-xs">
              Recording name
              <Input
                aria-label="Recording name to rename"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                maxLength={100}
                disabled={blocked}
                required
                autoFocus
              />
            </label>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" size="sm" disabled={blocked || !name.trim()}>
              Save name
            </Button>
          </form>
        </PopoverContent>
      </Popover>
      <Popover
        open={manageOpen}
        onOpenChange={(open) => {
          void manage(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="dataset-icon"
            aria-label="Manage recordings"
            title="Archive and restore recordings"
            disabled={blocked}
          >
            <MoreHorizontal size={16} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="recording-settings-popover rounded-none border-0 ring-0 animate-none transition-none"
        >
          <strong className="text-sm font-medium">Manage recordings</strong>
          <Button
            variant="outline"
            size="sm"
            disabled={blocked || !current}
            onClick={() =>
              void perform(onArchive, () => {
                setManageOpen(false);
              })
            }
          >
            <Archive size={16} />
            Archive current recording
          </Button>
          <p className="text-xs text-muted-foreground">
            Archiving keeps captured frames and OCR readings.
          </p>
          <label className="grid gap-2 text-xs">
            Archived recordings
            <NativeSelect
              className="w-full"
              size="sm"
              aria-label="Archived recordings"
              value={restoreId}
              onChange={(event) => {
                setRestoreId(event.target.value);
              }}
              disabled={blocked || loading || !archived.length}
            >
              {!archived.length && (
                <option value="">{loading ? "Loading…" : "No archived recordings"}</option>
              )}
              {archived.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.frame_count} {item.frame_count === 1 ? "frame" : "frames"}
                </option>
              ))}
            </NativeSelect>
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={blocked || loading || !restoreId}
            onClick={() =>
              void perform(
                () => onRestore(restoreId),
                () => {
                  setManageOpen(false);
                },
              )
            }
          >
            Restore selected
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
