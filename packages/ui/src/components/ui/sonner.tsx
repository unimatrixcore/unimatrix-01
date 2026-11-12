"use client";

import type * as React from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  RiCheckboxCircleLine,
  RiInformationLine,
  RiErrorWarningLine,
  RiCloseCircleLine,
  RiLoaderLine,
} from "@remixicon/react";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();
  const resolvedTheme: ToasterProps["theme"] =
    theme === "light" || theme === "dark" || theme === "system" ? theme : "system";

  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      icons={{
        success: <RiCheckboxCircleLine className="size-4" />,
        info: <RiInformationLine className="size-4" />,
        warning: <RiErrorWarningLine className="size-4" />,
        error: <RiCloseCircleLine className="size-4" />,
        loading: <RiLoaderLine className="size-4 animate-spin" />,
      }}
      style={
        {
          // Sonner injects `[data-sonner-toaster] { font-family: <sans stack> }`
          // into the head at runtime, which overrides the inherited monospace font
          // and makes the toast the only proportional-font surface on the site.
          // Set inline rather than by class: a Tailwind `font-mono` utility ties
          // that selector on specificity and loses on source order, because the
          // injected rule lands after the stylesheet. Verified in Chromium —
          // computed `font-family` on `[data-sonner-toast]` follows the shared
          // monospace family once this inline inheritance is applied.
          fontFamily: "inherit",
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
