import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { cn } from "../../lib/utils.js";

export type ScrollAreaViewportProps = Omit<
  React.ComponentProps<typeof ScrollAreaPrimitive.Viewport>,
  "children" | "asChild" | "style"
>;

export type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  variant?: "default" | "overlay";
  orientation?: "vertical" | "horizontal" | "both";
  viewportProps?: ScrollAreaViewportProps;
};

function ScrollArea({
  className,
  children,
  variant = "default",
  orientation = "vertical",
  viewportProps = {},
  onPointerMove,
  onPointerLeave,
  onPointerDownCapture,
  onPointerUpCapture,
  onPointerCancelCapture,
  onLostPointerCapture,
  ...props
}: ScrollAreaProps) {
  const overlay = variant === "overlay";
  const [visible, setVisible] = React.useState(false);
  const [pressed, setPressed] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nearEdge = React.useRef(false);
  const dragging = React.useRef(false);
  const { className: viewportClassName, ref, onScroll, ...restViewportProps } = viewportProps;
  const viewportRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      const cleanup = typeof ref === "function" ? ref(node) : undefined;
      if (ref && typeof ref !== "function") ref.current = node;
      return () => {
        if (typeof cleanup === "function") cleanup();
        else if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref],
  );

  const scheduleHide = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!nearEdge.current && !dragging.current) setVisible(false);
    }, 1500);
  }, []);

  const reveal = () => {
    setVisible(true);
    scheduleHide();
  };

  const release = React.useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    setPressed(false);
    scheduleHide();
  }, [scheduleHide]);

  React.useEffect(() => {
    if (!overlay) return;
    // Capture outside releases even if another control prevents the event.
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      clearTimeout(timer.current);
    };
  }, [overlay, release]);

  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      {...props}
      type={overlay ? "auto" : (props.type ?? "hover")}
      className={cn(
        "relative",
        overlay && "ui-scroll-overlay min-h-0 min-w-0 overflow-hidden",
        className,
      )}
      data-variant={variant}
      data-axis={orientation}
      data-visible={overlay ? visible : undefined}
      data-pressed={overlay ? pressed : undefined}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (!overlay || event.defaultPrevented || event.pointerType === "touch") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        nearEdge.current =
          (orientation !== "horizontal" && bounds.right - event.clientX <= 40) ||
          (orientation !== "vertical" && bounds.bottom - event.clientY <= 40);
        if (nearEdge.current) reveal();
        else scheduleHide();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        nearEdge.current = false;
        if (overlay) scheduleHide();
      }}
      onPointerDownCapture={(event) => {
        onPointerDownCapture?.(event);
        if (!overlay || event.defaultPrevented || !(event.target instanceof Element)) return;
        if (event.target.closest('[data-slot="scroll-area-scrollbar"]')) {
          dragging.current = true;
          setPressed(true);
          reveal();
        }
      }}
      onPointerUpCapture={(event) => {
        onPointerUpCapture?.(event);
        release();
      }}
      onPointerCancelCapture={(event) => {
        onPointerCancelCapture?.(event);
        release();
      }}
      onLostPointerCapture={(event) => {
        onLostPointerCapture?.(event);
        release();
      }}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        {...restViewportProps}
        ref={viewportRef}
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName,
        )}
        onScroll={(event) => {
          onScroll?.(event);
          if (overlay && !event.defaultPrevented && event.target === event.currentTarget) reveal();
        }}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" ? <ScrollBar /> : null}
      {orientation !== "vertical" ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
