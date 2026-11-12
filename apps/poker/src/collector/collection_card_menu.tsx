import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useLayoutEffect, useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@unimatrix/ui/public";

interface CardMenuAction {
  label: string;
  destructive: boolean;
  disabled: boolean;
  anchor: HTMLAnchorElement | null;
  button: HTMLButtonElement | null;
}
interface MenuControl {
  root: Root;
  close: () => void;
}
interface CardMenuProps {
  region: string;
  label: string;
  actions: CardMenuAction[];
  control: MenuControl;
}
const menus = new Map<HTMLElement, MenuControl>();

function CollectionCardMenu({ region, label, actions, control }: CardMenuProps) {
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    control.close = () => {
      setOpen(false);
    };
    return () => {
      control.close = () => {};
    };
  }, [control]);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild data-slot="button">
        <Button
          variant="ghost"
          size="icon-sm"
          className="collection-card-menu-trigger"
          aria-label={`Crop actions for ${region}`}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="19" cy="12" r="1.5" />
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={5}
        collisionPadding={8}
        className="collection-card-menu-content z-[120] min-w-40 max-w-[calc(100vw-16px)]"
      >
        {label && (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {actions.map((action, index) =>
          action.anchor ? (
            <DropdownMenuItem key={index} asChild disabled={action.disabled}>
              <a
                href={action.anchor.getAttribute("href") || undefined}
                target={action.anchor.target || undefined}
                rel={action.anchor.rel || undefined}
                onClick={(event) => {
                  if (
                    action.anchor?.onclick?.call(
                      action.anchor,
                      event.nativeEvent as PointerEvent,
                    ) === false
                  )
                    event.preventDefault();
                }}
              >
                {action.label}
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={index}
              disabled={action.disabled}
              variant={action.destructive ? "destructive" : "default"}
              onSelect={() => action.button?.click()}
            >
              {action.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Move each card's existing native actions into the shared accessible menu. */
export function enhanceCollectionMenus(container: ParentNode): void {
  const selector = ".collection-card-menu:not([data-shared-menu])";
  const hosts = [...container.querySelectorAll<HTMLElement>(selector)];
  if (container instanceof HTMLElement && container.matches(selector)) hosts.unshift(container);
  for (const host of hosts) {
    const actions = [
      ...host.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>("a,button"),
    ].map((node) => ({
      label: node.textContent?.trim() || node.getAttribute("aria-label") || "Action",
      destructive: node.classList.contains("btn-danger"),
      disabled: node instanceof HTMLButtonElement && node.disabled,
      anchor: node instanceof HTMLAnchorElement ? node : null,
      button: node instanceof HTMLButtonElement ? node : null,
    }));
    const region = host.dataset.regionId || "crop";
    const label = host.dataset.menuLabel || "";
    host.replaceChildren();
    host.dataset.sharedMenu = "true";
    const control: MenuControl = { root: createRoot(host), close: () => {} };
    menus.set(host, control);
    flushSync(() => {
      control.root.render(
        <CollectionCardMenu region={region} label={label} actions={actions} control={control} />,
      );
    });
  }
}

/** Hide portals when their collection view becomes inactive, preserving menus. */
export function closeMenus(): void {
  flushSync(() => {
    for (const menu of menus.values()) menu.close();
  });
}

/** Remove React roots and portals before native cards are removed or replaced. */
export function disposeMenus(container: ParentNode = document): void {
  for (const [host, menu] of menus) {
    if (container !== document && container !== host && !(container as Node).contains(host))
      continue;
    flushSync(() => {
      menu.root.unmount();
    });
    menus.delete(host);
  }
}
