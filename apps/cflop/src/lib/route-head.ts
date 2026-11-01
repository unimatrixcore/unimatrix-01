import type { AnyRouteMatch, MetaDescriptor } from "@tanstack/react-router";

/**
 * The origin every absolute URL in a route head is built from. Hardcoded rather
 * than read from an env var: this app has no `.env` files, and a canonical that
 * varies by build is a canonical that can point at a preview host.
 */
export const CANONICAL_ORIGIN = "https://cflop.us";

export const ROBOTS_INDEXABLE = "index,follow";
export const ROBOTS_EXCLUDED = "noindex,follow";

type LdJson = Extract<MetaDescriptor, { "script:ld+json": unknown }>["script:ld+json"];

type HeadMeta = NonNullable<AnyRouteMatch["meta"]>;
type HeadMetaEntry = HeadMeta[number];
type HeadLinks = NonNullable<AnyRouteMatch["links"]>;

export interface RouteHeadOptions {
  /** Route path, leading slash included — `/` or `/learn`. */
  path: string;
  title: string;
  description: string;
  /** When false the route gets `noindex,follow`, no canonical and no social cards. */
  indexable: boolean;
  jsonLd?: LdJson;
}

export interface RouteHeadResult {
  meta: HeadMeta;
  links: HeadLinks;
}

export function routeHead({
  path,
  title,
  description,
  indexable,
  jsonLd,
}: RouteHeadOptions): RouteHeadResult {
  const url = `${CANONICAL_ORIGIN}${path}`;
  const meta: HeadMeta = [
    { title },
    { name: "description", content: description },
    { name: "robots", content: indexable ? ROBOTS_INDEXABLE : ROBOTS_EXCLUDED },
  ];

  if (indexable) {
    meta.push(
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "CFLOP" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: url },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    );
  }

  // JSON-LD travels in `meta`, not a `scripts` key: `HeadContent` builds its
  // tags by walking `match.meta` and branching on this key, and never reads
  // `scripts` at all. The cast is the gap between that runtime behaviour and
  // the React binding, which types a match's `meta` as `<meta>` props only —
  // `MetaDescriptor` in `@tanstack/router-core` is the shape actually accepted.
  if (jsonLd) meta.push({ "script:ld+json": jsonLd } as unknown as HeadMetaEntry);

  return { meta, links: indexable ? [{ rel: "canonical", href: url }] : [] };
}

/**
 * Whether a route's `meta` marks it indexable. Takes `unknown` because the
 * prerender driver reads it back off a route's own `head()` output, where the
 * router's types no longer narrow it.
 */
export function isIndexable(meta: unknown): boolean {
  if (!Array.isArray(meta)) return false;

  return meta.some(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { name?: unknown }).name === "robots" &&
      (entry as { content?: unknown }).content === ROBOTS_INDEXABLE,
  );
}
