import { createElement } from "react";
import type { ComponentProps } from "react";
import { MODEL_ICON_ATTRIBUTES, MODEL_ICON_PARTS } from "../../lib/model-icon.js";
import { cn } from "../../lib/utils.js";

export type ModelIconProps = ComponentProps<"svg">;

export function ModelIcon({ className, ...props }: ModelIconProps) {
  return (
    <svg
      {...MODEL_ICON_ATTRIBUTES}
      aria-hidden="true"
      focusable="false"
      className={cn("um-model-icon", className)}
      {...props}
    >
      {MODEL_ICON_PARTS.map(({ tag, attributes }, index) =>
        createElement(tag, { ...attributes, key: index }),
      )}
    </svg>
  );
}
