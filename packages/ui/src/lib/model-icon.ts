export const MODEL_ICON_ATTRIBUTES = Object.freeze({
  viewBox: "0 0 24 24",
  width: "1em",
  height: "1em",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const MODEL_ICON_PARTS = Object.freeze([
  { tag: "path", attributes: { d: "M12 8V4H9" } },
  { tag: "rect", attributes: { x: "4", y: "8", width: "16", height: "12", rx: "2" } },
  { tag: "path", attributes: { d: "M2 12v4m20-4v4M9 13v2m6-2v2" } },
] as const);

const namespace = "http://www.w3.org/2000/svg";
const nativeNames: Readonly<Record<string, string>> = {
  strokeWidth: "stroke-width",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
};

export function createModelIcon(document: Document, className = ""): SVGSVGElement {
  const icon = document.createElementNS(namespace, "svg");
  for (const [name, value] of Object.entries(MODEL_ICON_ATTRIBUTES)) {
    icon.setAttribute(nativeNames[name] ?? name, String(value));
  }
  icon.setAttribute("class", ["um-model-icon", className].filter(Boolean).join(" "));
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  for (const { tag, attributes } of MODEL_ICON_PARTS) {
    const part = document.createElementNS(namespace, tag);
    for (const [name, value] of Object.entries(attributes)) part.setAttribute(name, value);
    icon.appendChild(part);
  }
  return icon;
}
