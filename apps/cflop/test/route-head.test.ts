import { describe, expect, it } from "vitest";

import { ROBOTS_EXCLUDED, ROBOTS_INDEXABLE, isIndexable, routeHead } from "@/lib/route-head";

function metaEntry(head: ReturnType<typeof routeHead>, key: "name" | "property", value: string) {
  return head.meta.find((entry) => (entry as Record<string, unknown>)[key] === value) as
    { content: string } | undefined;
}

describe("routeHead", () => {
  it("always emits a title, a description and a robots directive", () => {
    const head = routeHead({
      path: "/learn",
      title: "CFLOP - Learn",
      description: "Learn the algorithms.",
      indexable: false,
    });

    expect(head.meta[0]).toEqual({ title: "CFLOP - Learn" });
    expect(metaEntry(head, "name", "description")?.content).toBe("Learn the algorithms.");
    expect(metaEntry(head, "name", "robots")?.content).toBe(ROBOTS_EXCLUDED);
  });

  it("omits social cards and the canonical when the route is excluded", () => {
    const head = routeHead({
      path: "/learn",
      title: "CFLOP - Learn",
      description: "Learn the algorithms.",
      indexable: false,
    });

    expect(head.links).toEqual([]);
    expect(metaEntry(head, "property", "og:title")).toBeUndefined();
    expect(metaEntry(head, "name", "twitter:card")).toBeUndefined();
  });

  it("emits Open Graph, Twitter and canonical tags when the route is indexable", () => {
    const head = routeHead({
      path: "/",
      title: "CFLOP - Home",
      description: "A flashcard trainer.",
      indexable: true,
    });

    expect(metaEntry(head, "name", "robots")?.content).toBe(ROBOTS_INDEXABLE);
    expect(metaEntry(head, "property", "og:type")?.content).toBe("website");
    expect(metaEntry(head, "property", "og:site_name")?.content).toBe("CFLOP");
    expect(metaEntry(head, "property", "og:title")?.content).toBe("CFLOP - Home");
    expect(metaEntry(head, "property", "og:description")?.content).toBe("A flashcard trainer.");
    expect(metaEntry(head, "name", "twitter:card")?.content).toBe("summary");
    expect(metaEntry(head, "name", "twitter:title")?.content).toBe("CFLOP - Home");
    expect(metaEntry(head, "name", "twitter:description")?.content).toBe("A flashcard trainer.");
  });

  it("builds og:url and the canonical href from the canonical origin and the path", () => {
    const head = routeHead({
      path: "/learn",
      title: "CFLOP - Learn",
      description: "Learn the algorithms.",
      indexable: true,
    });

    expect(metaEntry(head, "property", "og:url")?.content).toBe("https://cflop.us/learn");
    expect(head.links).toEqual([{ rel: "canonical", href: "https://cflop.us/learn" }]);
  });

  it("carries jsonLd as a script:ld+json meta entry", () => {
    const head = routeHead({
      path: "/",
      title: "CFLOP - Home",
      description: "A flashcard trainer.",
      indexable: true,
      jsonLd: { "@context": "https://schema.org", "@type": "SoftwareApplication" },
    });

    expect(head.meta).toContainEqual({
      "script:ld+json": { "@context": "https://schema.org", "@type": "SoftwareApplication" },
    });
  });

  it("emits no script:ld+json entry when jsonLd is omitted", () => {
    const head = routeHead({
      path: "/learn",
      title: "CFLOP - Learn",
      description: "Learn the algorithms.",
      indexable: false,
    });

    expect(head.meta.some((entry) => entry !== undefined && "script:ld+json" in entry)).toBe(false);
  });
});

describe("isIndexable", () => {
  it("is true for the meta of an indexable route", () => {
    expect(
      isIndexable(routeHead({ path: "/", title: "t", description: "d", indexable: true }).meta),
    ).toBe(true);
  });

  it("is false for an excluded route, which is not a substring match", () => {
    expect(
      isIndexable(
        routeHead({ path: "/learn", title: "t", description: "d", indexable: false }).meta,
      ),
    ).toBe(false);
    expect(isIndexable([{ name: "robots", content: ROBOTS_EXCLUDED }])).toBe(false);
  });

  it("is false for anything that is not an array of meta descriptors", () => {
    expect(isIndexable(undefined)).toBe(false);
    expect(isIndexable([])).toBe(false);
    expect(isIndexable("index,follow")).toBe(false);
    expect(isIndexable([null, { name: "description", content: "d" }])).toBe(false);
  });
});
