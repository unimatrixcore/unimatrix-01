import { describe, expect, it } from "vitest";

import { createPostBodySchema, updatePostBodySchema } from "../src/index.js";

const POST_ID = "3f8a1c2e-5b7d-4e91-a0c3-6d2f8b4e1a97";

const BASE_POST = {
  type: "project",
  slug: "cflop",
  title: "CFLOP",
  summary: "A trainer.",
  body: "# CFLOP",
} as const;

function parseWithLiveUrl(liveUrl: string): boolean {
  return createPostBodySchema.safeParse({ ...BASE_POST, liveUrl }).success;
}

describe("urlSchema scheme restriction", () => {
  it("accepts http and https URLs", () => {
    expect(parseWithLiveUrl("https://cflop.unimatrix-01.dev")).toBe(true);
    expect(parseWithLiveUrl("http://localhost:5173")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(parseWithLiveUrl("javascript:alert(1)")).toBe(false);
    // Scheme matching is case-insensitive in the URL parser, so a mixed-case
    // spelling must not slip past.
    expect(parseWithLiveUrl("jAvAsCrIpT:alert(1)")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(parseWithLiveUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects other schemes that z.url() alone would accept", () => {
    expect(parseWithLiveUrl("ftp://example.dev/x")).toBe(false);
    expect(parseWithLiveUrl("mailto:someone@example.dev")).toBe(false);
  });

  it("still rejects strings that are not URLs at all", () => {
    expect(parseWithLiveUrl("not a url")).toBe(false);
    expect(parseWithLiveUrl("/relative/path")).toBe(false);
  });

  it("applies the same restriction to repoUrl and to updates", () => {
    expect(createPostBodySchema.safeParse({ ...BASE_POST, repoUrl: "javascript:0" }).success).toBe(
      false,
    );
    expect(updatePostBodySchema.safeParse({ id: POST_ID, repoUrl: "javascript:0" }).success).toBe(
      false,
    );
    expect(
      updatePostBodySchema.safeParse({ id: POST_ID, repoUrl: "https://example.dev" }).success,
    ).toBe(true);
  });

  it("still allows clearing a URL with null", () => {
    expect(createPostBodySchema.safeParse({ ...BASE_POST, liveUrl: null }).success).toBe(true);
  });
});
