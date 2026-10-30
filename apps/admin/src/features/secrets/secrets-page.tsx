import { RiKeyLine, RiPlugLine, RiAddLine, RiEraserLine, RiRefreshLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import {
  formatAge,
  formatPublishedDate,
  secretNameSchema,
  type SecretTier,
} from "@unimatrix/shared";
import {
  Card,
  CardHeader,
  CardTitle,
  ScrollArea,
  ActionTooltip,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Label,
  Skeleton,
} from "@unimatrix/ui/editor";
import { useId, useMemo, useState, type ReactNode } from "react";

import { useApiClient } from "@/lib/api-client";

import {
  useClearSecretValue,
  useRotateSecret,
  useSetSecretValue,
  describeSecretsError,
} from "./mutations";
import { secretsQueryOptions } from "./queries";
import {
  SECRET_ACTION_LABELS,
  describeSecretRow,
  type SecretRowAction,
  type SecretRowDescription,
} from "./row-state";

const INTEGRATION_NAME_PREFIX = "integrations/";

const PANELS: readonly {
  tier: SecretTier;
  title: string;
  empty: string;
}[] = [
  {
    tier: "platform",
    title: "Platform credentials",
    empty: "Nothing declared. These names come from the registry in the codebase.",
  },
  {
    tier: "integration",
    title: "Integrations",
    empty: "Nothing yet. Add a credential when you wire a provider up.",
  },
];

export function SecretsPage() {
  const client = useApiClient();
  const { data, error, isPending } = useQuery(secretsQueryOptions(client));

  const rows = useMemo(
    () =>
      data === undefined
        ? []
        : data.secrets.map((row) => describeSecretRow(row, data.activeKekVersion)),
    [data],
  );

  const [tier, setTier] = useState<SecretTier>("platform");
  const [isAddOpen, setIsAddOpen] = useState(false);

  const [pending, setPending] = useState<{
    action: SecretRowAction;
    row: SecretRowDescription;
  } | null>(null);

  function closeDialog() {
    setPending(null);
  }

  return (
    <Card
      role="region"
      aria-label="Secrets"
      size="sm"
      height="fill"
      className="min-w-0 gap-0 rounded-none p-0 shadow-none ring-0"
    >
      <CardHeader className="flex h-11 shrink-0 flex-row items-center px-3 pt-4 pb-1">
        <CardTitle className="text-lg leading-none font-semibold tracking-[-0.03em]">
          <h1>Secrets</h1>
        </CardTitle>
      </CardHeader>
      <Tabs
        value={tier}
        onValueChange={(value) => {
          setTier(value as SecretTier);
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 px-3 pt-3 pb-4"
      >
        <div className="grid shrink-0 grid-cols-1 items-center gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="col-start-1 row-start-2 flex items-center lg:row-start-1">
            {tier === "integration" ? (
              <Button
                onClick={() => {
                  setIsAddOpen(true);
                }}
                size="sm"
                variant="outline"
              >
                <RiAddLine aria-hidden="true" className="size-4" />
                Add credential
              </Button>
            ) : null}
          </div>
          <ScrollArea
            variant="overlay"
            orientation="horizontal"
            className="col-start-1 row-start-1 h-9 w-full min-w-0 lg:col-start-2 lg:w-96"
            viewportProps={{ "aria-label": "Credential collections", tabIndex: 0 }}
          >
            <TabsList variant="line" className="-translate-y-0.5 ml-auto w-max justify-end px-3">
              <TabsTrigger value="platform">
                <RiKeyLine aria-hidden="true" className="size-4" />
                Platform credentials
              </TabsTrigger>
              <TabsTrigger value="integration">
                <RiPlugLine aria-hidden="true" className="size-4" />
                Integrations
              </TabsTrigger>
            </TabsList>
          </ScrollArea>
        </div>
        {PANELS.map((panel) => (
          <TabsContent
            key={panel.tier}
            value={panel.tier}
            forceMount
            hidden={tier !== panel.tier}
            className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
          >
            <ScrollArea
              variant="overlay"
              orientation="both"
              className="min-h-0 flex-1"
              viewportProps={{ "aria-label": panel.title, tabIndex: 0 }}
            >
              <section aria-label={panel.title}>
                <SecretsList
                  empty={panel.empty}
                  error={error}
                  isPending={isPending}
                  onAct={(action, row) => {
                    setPending({ action, row });
                  }}
                  rows={rows.filter((row) => row.tier === panel.tier)}
                />
              </section>
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>

      {isAddOpen ? (
        <AddCredentialDialog
          onClose={() => {
            setIsAddOpen(false);
          }}
        />
      ) : null}
      {pending?.action === "set-value" ? (
        <SetValueDialog onClose={closeDialog} row={pending.row} />
      ) : null}
      {pending?.action === "rotate" ? (
        <RotateDialog onClose={closeDialog} row={pending.row} />
      ) : null}
      {pending?.action === "clear-value" ? (
        <ClearValueDialog onClose={closeDialog} row={pending.row} />
      ) : null}
    </Card>
  );
}

function SecretsList({
  empty,
  error,
  isPending,
  onAct,
  rows,
}: {
  empty: string;
  error: Error | null;
  isPending: boolean;
  onAct: (action: SecretRowAction, row: SecretRowDescription) => void;
  rows: readonly SecretRowDescription[];
}) {
  if (error !== null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Credentials could not be loaded.</EmptyTitle>
          <EmptyDescription>{describeSecretsError(error)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (isPending) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">{empty}</p>;
  }

  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead>Credential</TableHead>
          <TableHead className="w-20 sm:w-24">State</TableHead>
          <TableHead className="w-20">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell className="min-w-0 py-3">
              <p title={row.name} className="truncate font-mono text-sm">
                {row.name}
              </p>
              <RowMeta row={row} />
              {row.needsReseal ? (
                <p className="mt-1 text-xs text-muted-foreground">Sealed under an older key</p>
              ) : null}
            </TableCell>
            <TableCell>
              <StatusBadge row={row} />
            </TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
                {row.actions.map((action) => (
                  <RowActionButton
                    key={action}
                    action={action}
                    row={row}
                    onClick={() => {
                      onAct(action, row);
                    }}
                  />
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RowMeta({ row }: { row: SecretRowDescription }) {
  if (row.rotatedAt === null) {
    return <p className="text-xs text-muted-foreground">No value stored</p>;
  }

  const age = formatAge(row.rotatedAt) ?? formatPublishedDate(row.rotatedAt);

  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span className="font-mono">{row.maskedValue}</span>
      <span aria-hidden="true">·</span>
      <span>rotated {age}</span>
    </p>
  );
}

function StatusBadge({ row }: { row: SecretRowDescription }) {
  if (row.status === "set") {
    return <Badge variant="secondary">{row.statusLabel}</Badge>;
  }

  return (
    <Badge className={row.status === "not-set" ? "border-dashed" : undefined} variant="outline">
      {row.statusLabel}
    </Badge>
  );
}

const ROW_ACTION_STYLES = {
  "set-value": { icon: RiAddLine, className: "" },
  rotate: { icon: RiRefreshLine, className: "" },
  "clear-value": { icon: RiEraserLine, className: "text-destructive hover:text-destructive" },
};

function RowActionButton({
  action,
  onClick,
  row,
}: {
  action: SecretRowAction;
  onClick: () => void;
  row: SecretRowDescription;
}) {
  const label = SECRET_ACTION_LABELS[action];
  const { className, icon: Icon } = ROW_ACTION_STYLES[action];

  return (
    <ActionTooltip label={label}>
      <Button
        aria-label={`${label} ${row.name}`}
        className={className}
        onClick={onClick}
        size="icon-sm"
        variant="ghost"
      >
        <Icon aria-hidden="true" className="size-4" />
      </Button>
    </ActionTooltip>
  );
}

function DialogSubject({ row }: { row: SecretRowDescription }) {
  return (
    <div className="grid gap-1 bg-muted/50 px-3 py-2">
      <span className="font-mono text-sm text-foreground">{row.name}</span>
      {row.consumedBy === null ? null : (
        <p className="text-xs text-muted-foreground">{row.consumedBy}</p>
      )}
      {row.tier === "platform" ? (
        <p className="text-xs text-muted-foreground">
          Each service still reads this from its own deploy environment, so saving it here does not
          change anything currently running.
        </p>
      ) : null}
    </div>
  );
}

function SecretValueField({
  autoFocus,
  label,
  onChange,
  value,
}: {
  autoFocus?: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const fieldId = useId();

  return (
    <div className="grid gap-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input
        autoComplete="off"
        autoFocus={autoFocus}
        id={fieldId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        required
        type="password"
        value={value}
      />
    </div>
  );
}

function DialogShell({
  children,
  description,
  isSubmitting,
  onClose,
  onSubmit,
  submitLabel,
  submittingLabel,
  title,
}: {
  children: ReactNode;
  description: string;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submittingLabel: string;
  title: string;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">{children}</div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? submittingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The name is fixed text rather than an input: it came from the registry, and
 * a typo would create a second credential beside the one the system is waiting
 * for instead of filling it.
 */
function SetValueDialog({ onClose, row }: { onClose: () => void; row: SecretRowDescription }) {
  const [value, setValue] = useState("");
  const setSecretValue = useSetSecretValue();

  return (
    <DialogShell
      description="Sealed under the store’s active key as soon as you save it."
      isSubmitting={setSecretValue.isPending}
      onClose={onClose}
      onSubmit={() => {
        setSecretValue.mutate({ name: row.name, value }, { onSuccess: onClose });
      }}
      submitLabel={SECRET_ACTION_LABELS["set-value"]}
      submittingLabel="Setting"
      title={SECRET_ACTION_LABELS["set-value"]}
    >
      <DialogSubject row={row} />
      <SecretValueField autoFocus label="Value" onChange={setValue} value={value} />
    </DialogShell>
  );
}

function RotateDialog({ onClose, row }: { onClose: () => void; row: SecretRowDescription }) {
  const [value, setValue] = useState("");
  const rotateSecret = useRotateSecret();

  return (
    <DialogShell
      // The one place the no-read-back rule is worth stating: it is why this
      // dialog asks for the whole value instead of offering the old one to
      // edit.
      description="The current value is never shown here, by design. Rotating seals a new one under the store’s active key and retires the old one."
      isSubmitting={rotateSecret.isPending}
      onClose={onClose}
      onSubmit={() => {
        rotateSecret.mutate({ name: row.name, value }, { onSuccess: onClose });
      }}
      submitLabel={SECRET_ACTION_LABELS.rotate}
      submittingLabel="Rotating"
      title={SECRET_ACTION_LABELS.rotate}
    >
      <DialogSubject row={row} />
      <SecretValueField autoFocus label="New value" onChange={setValue} value={value} />
    </DialogShell>
  );
}

/**
 * The only free-form name in this console.
 *
 * Validated against `secretNameSchema` as it is typed, because the store's
 * namespace excludes characters an operator would reasonably reach for —
 * `SLACK_TOKEN` and `slack.token` are both refused — and finding that out from
 * a 400 after typing a live credential is a worse way to learn it.
 */
function AddCredentialDialog({ onClose }: { onClose: () => void }) {
  const [suffix, setSuffix] = useState("");
  const [value, setValue] = useState("");
  const setSecretValue = useSetSecretValue();
  const nameFieldId = useId();
  // The rule is the only stated reason the submit button is disabled, so it has
  // to reach a screen reader through the field rather than by proximity.
  const nameHintId = useId();

  const name = `${INTEGRATION_NAME_PREFIX}${suffix}`;
  const isNameValid = secretNameSchema.safeParse(name).success;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSecretValue.mutate({ name, value }, { onSuccess: onClose });
          }}
        >
          <DialogHeader>
            <DialogTitle>Add credential</DialogTitle>
            <DialogDescription>
              The name is how the code will ask for this credential, and rotating changes the value
              rather than the name — so pick one you can live with.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={nameFieldId}>Name</Label>
              <div className="flex items-stretch">
                {/* A fixed affix, not a placeholder: every name this console
                    can create lives under it, and typing it again is a way to
                    get `integrations/integrations/…`. */}
                <span className="flex items-center border border-r-0 border-input px-3 font-mono text-sm text-muted-foreground">
                  {INTEGRATION_NAME_PREFIX}
                </span>
                <Input
                  aria-describedby={nameHintId}
                  aria-invalid={suffix.length > 0 && !isNameValid}
                  autoComplete="off"
                  autoFocus
                  className="font-mono"
                  id={nameFieldId}
                  onChange={(event) => {
                    setSuffix(event.target.value);
                  }}
                  placeholder="github/api-token"
                  required
                  value={suffix}
                />
              </div>
              <p
                className={
                  suffix.length > 0 && !isNameValid
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
                id={nameHintId}
              >
                Lowercase letters, digits and hyphens, with <code>/</code> between segments. No
                underscores, no dots.
              </p>
            </div>
            <SecretValueField label="Value" onChange={setValue} value={value} />
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!isNameValid || setSecretValue.isPending} type="submit">
              {setSecretValue.isPending ? "Adding" : "Add credential"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Confirms by typed name rather than a single click: every sealed version of
 * the credential is destroyed by this call and no route this console can reach
 * would let it be read back first.
 *
 * What happens to the row afterwards branches, and the copy has to say which —
 * a declared name keeps its row because the registry still records that the
 * system expects it, while an undeclared one leaves nothing behind to list.
 */
function ClearValueDialog({ onClose, row }: { onClose: () => void; row: SecretRowDescription }) {
  const [typedName, setTypedName] = useState("");
  const clearSecretValue = useClearSecretValue();
  const fieldId = useId();
  const isConfirmed = typedName === row.name;

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{SECRET_ACTION_LABELS["clear-value"]}</AlertDialogTitle>
          <AlertDialogDescription>
            Every sealed version of this credential is destroyed. It cannot be recovered from here,
            or anywhere else.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <DialogSubject row={row} />
        <p className="text-sm text-muted-foreground">
          {row.isDeclared
            ? "The row stays listed as Not set — the system still expects this credential, and anything using it will fail until a new value is set."
            : "The row disappears from this console. Nothing in the codebase declares this name, so there is nothing left for it to list."}
        </p>
        <div className="grid gap-2">
          <Label htmlFor={fieldId}>Type the full name to confirm</Label>
          <Input
            autoComplete="off"
            className="font-mono"
            id={fieldId}
            onChange={(event) => {
              setTypedName(event.target.value);
            }}
            placeholder={row.name}
            value={typedName}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!isConfirmed || clearSecretValue.isPending}
            onClick={() => {
              clearSecretValue.mutate({ name: row.name });
              onClose();
            }}
            variant="destructive"
          >
            {SECRET_ACTION_LABELS["clear-value"]}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
