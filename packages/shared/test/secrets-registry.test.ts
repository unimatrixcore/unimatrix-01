import { describe, expect, it } from "vitest";

import {
  CANVAS_ACCESS_TOKEN_SECRET,
  integrationSecretNames,
  secretNameSchema,
  secretTierForName,
  secretTierSchema,
  SECRET_REGISTRY,
} from "../src/index.js";

function platformEntryCount(): number {
  return SECRET_REGISTRY.filter((entry) => entry.tier === "platform").length;
}

describe("SECRET_REGISTRY", () => {
  it("declares only names the store can hold", () => {
    for (const entry of SECRET_REGISTRY) {
      expect(secretNameSchema.safeParse(entry.name).success, entry.name).toBe(true);
    }
  });

  it("declares a known tier and a non-empty consumedBy for every entry", () => {
    for (const entry of SECRET_REGISTRY) {
      expect(secretTierSchema.safeParse(entry.tier).success, entry.name).toBe(true);
      expect(entry.consumedBy.length, entry.name).toBeGreaterThan(0);
    }
  });

  it("declares each name once", () => {
    const names = SECRET_REGISTRY.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("declares every Clerk key in the platform tier", () => {
    expect(secretTierForName("platform/clerk-secret-key")).toBe("platform");
    expect(secretTierForName("platform/clerk-jwt-key")).toBe("platform");
    expect(secretTierForName("platform/clerk-publishable-key")).toBe("platform");
  });
});

describe("integrationSecretNames", () => {
  it("declares the Admin-managed Canvas name in the integration tier", () => {
    expect(CANVAS_ACCESS_TOKEN_SECRET.name).toBe("integrations/canvas/access-token");
    expect(secretTierForName(CANVAS_ACCESS_TOKEN_SECRET.name)).toBe("integration");
    expect(integrationSecretNames()).toContain(CANVAS_ACCESS_TOKEN_SECRET.name);
  });
  it("returns nothing outside the integration tier", () => {
    const names = integrationSecretNames();

    expect(names.length).toBe(SECRET_REGISTRY.length - platformEntryCount());

    for (const name of names) {
      expect(secretTierForName(name), name).toBe("integration");
    }
  });
});

describe("secretTierForName", () => {
  it("returns null for a name the registry does not declare", () => {
    expect(secretTierForName("integrations/github/token")).toBeNull();
  });
});
