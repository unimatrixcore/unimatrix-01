import { describe, expect, it } from "vitest";
import {
  canvasAnnouncementsQuerySchema,
  canvasFileSchema,
  canvasModuleItemSchema,
  canvasPageQuerySchema,
  canvasPageSchema,
  canvasSyllabusQuerySchema,
} from "../src/index.js";

const documentId = "a".repeat(64);

describe("Canvas reading contracts", () => {
  it("distinguishes numeric page slugs from numeric IDs and the front page", () => {
    for (const selector of [
      { selector: "slug", pageSlug: "123" },
      { selector: "id", pageId: "123" },
      { selector: "front_page" },
    ]) {
      expect(canvasPageQuerySchema.parse({ courseId: "1", ...selector })).toEqual({
        courseId: "1",
        ...selector,
      });
    }
    for (const selector of [
      { selector: "id", pageSlug: "123" },
      { selector: "slug", pageId: "123" },
      { selector: "front_page", pageId: "123" },
      { selector: "slug", pageSlug: "123", pageId: "123" },
      { selector: "slug", pageSlug: "../files" },
    ]) {
      expect(canvasPageQuerySchema.safeParse({ courseId: "1", ...selector }).success).toBe(false);
    }
  });

  it("requires both continuation fields and normalizes HTTP offsets", () => {
    expect(canvasSyllabusQuerySchema.parse({ courseId: "1", documentId, offset: "4000" })).toEqual({
      courseId: "1",
      documentId,
      offset: 4000,
    });
    for (const continuation of [
      { documentId },
      { offset: 4000 },
      { documentId, offset: 0 },
      { documentId, offset: 2_000_001 },
    ]) {
      expect(canvasSyllabusQuerySchema.safeParse({ courseId: "1", ...continuation }).success).toBe(
        false,
      );
    }
  });

  it("preserves announcement course and date filters through HTTP normalization", () => {
    const query = {
      start: "2026-10-01",
      end: "2026-10-30",
      courseIds: '["1","9007199254740993"]',
      limit: "2",
    };
    expect(canvasAnnouncementsQuerySchema.parse(query)).toEqual({
      start: query.start,
      end: query.end,
      courseIds: ["1", "9007199254740993"],
      limit: 2,
    });
    expect(
      canvasAnnouncementsQuerySchema.safeParse({ ...query, documentId, offset: 1500 }).success,
    ).toBe(false);
    expect(
      canvasAnnouncementsQuerySchema.safeParse({
        ...query,
        announcementId: "3",
        documentId,
        offset: 1500,
      }).success,
    ).toBe(true);
    expect(
      canvasAnnouncementsQuerySchema.safeParse({ ...query, start: "2026-11-01" }).success,
    ).toBe(false);
    expect(canvasAnnouncementsQuerySchema.safeParse({ ...query, courseIds: "[]" }).success).toBe(
      false,
    );
    expect(canvasAnnouncementsQuerySchema.safeParse({ ...query, studentId: "2" }).success).toBe(
      false,
    );
  });

  it("retains inaccessible page and module completion facts without arbitrary wire fields", () => {
    const page = {
      id: "1",
      courseId: "2",
      slug: "reading",
      title: "Reading",
      htmlUrl: "https://learn.maricopa.edu/courses/2/pages/reading",
      frontPage: false,
      lockedForUser: true,
      lockExplanation: "Complete prerequisite",
      document: null,
      availability: "unavailable",
      warnings: [],
    };
    expect(canvasPageSchema.parse(page).availability).toBe("unavailable");
    expect(canvasPageSchema.safeParse({ ...page, body: "upstream HTML" }).success).toBe(false);
    const item = {
      id: "3",
      courseId: "2",
      moduleId: "4",
      title: "Reading",
      type: "Page",
      position: 1,
      contentId: null,
      pageSlug: "reading",
      htmlUrl: page.htmlUrl,
      lockedForUser: true,
      completionRequirement: { type: "must_view", minScore: null, completed: false },
      availability: "unavailable",
    };
    expect(canvasModuleItemSchema.parse(item).completionRequirement?.completed).toBe(false);
    expect(canvasModuleItemSchema.safeParse({ ...item, arbitrary: true }).success).toBe(false);
  });

  it("exposes file metadata without accepting download URL fields", () => {
    const file = {
      id: "3",
      courseId: "2",
      displayName: "Reading.pdf",
      filename: "reading.pdf",
      size: 100,
      contentType: "application/pdf",
      locked: false,
      lockedForUser: false,
      hidden: null,
      hiddenForUser: null,
      lockExplanation: null,
      lockAt: null,
      unlockAt: null,
      htmlUrl: "https://learn.maricopa.edu/courses/2/files/3",
      availability: "available",
    };
    expect(canvasFileSchema.parse(file).size).toBe(100);
    expect(
      canvasFileSchema.safeParse({ ...file, url: "https://download.example/signed" }).success,
    ).toBe(false);
    expect(canvasFileSchema.safeParse({ ...file, size: -1 }).success).toBe(false);
  });
});
