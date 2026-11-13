import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Input } from "@unimatrix/ui/public";
import { NativeSelect } from "@unimatrix/ui/native-select";
import "./form_controls.css";

// Collector controllers keep references to these native nodes and mutate their
// options, values and disabled state. Adopt those exact nodes into the shared
// primitive once rather than replacing their identities or duplicating state.
function adoptControl(node: HTMLInputElement | HTMLSelectElement) {
  const host = document.createElement("span");
  host.className = "shared-ui-island";
  const classes = [...node.classList];
  node.replaceWith(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      node instanceof HTMLSelectElement ? (
        <NativeSelect size="sm" className="shared-native-select" />
      ) : (
        <Input type={node.type} />
      ),
    );
  });
  const shared = host.querySelector<HTMLInputElement | HTMLSelectElement>("input,select");
  if (!shared) return;
  node.className = shared.className;
  for (const name of classes) node.classList.add(name);
  for (const { name, value } of [...shared.attributes]) {
    if (name.startsWith("data-")) node.setAttribute(name, value);
  }
  // Layout dimensions remain local; shared primitives own the field surface.
  for (const property of [...node.style]) {
    if (/^(border|background|padding|box-shadow|outline|font|color)/.test(property)) {
      node.style.removeProperty(property);
    }
  }
  node.dataset.sharedForm = "true";
  shared.replaceWith(node);
}

export function enhanceFormControls(container: ParentNode = document) {
  for (const node of container.querySelectorAll<HTMLSelectElement>("select:not([data-slot])")) {
    adoptControl(node);
  }
  for (const node of container.querySelectorAll<HTMLInputElement>("input:not([data-slot])")) {
    // Native checkbox/radio controllers use checked state and need their own
    // adapter; text fields retain their browser editing/validation semantics.
    if (
      ![
        "checkbox",
        "radio",
        "hidden",
        "file",
        "range",
        "color",
        "button",
        "submit",
        "reset",
      ].includes(node.type)
    ) {
      adoptControl(node);
    }
  }
}
