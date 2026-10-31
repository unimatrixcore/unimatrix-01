import { describe, expect, it } from "vitest";

import {
  adminDeployAttemptHistoryContract,
  adminDeployHealthHistoryContract,
  adminDeployReconciliationContract,
  adminDeployStateContract,
  deployAttemptHistoryContract,
  deployHealthHistoryContract,
  deployReconciliationContract,
  deployStateContract,
} from "../src/index.js";

describe("admin deployment read contracts", () => {
  it.each([
    [adminDeployStateContract, deployStateContract, "/deployment/admin/state"],
    [adminDeployHealthHistoryContract, deployHealthHistoryContract, "/deployment/admin/health"],
    [
      adminDeployReconciliationContract,
      deployReconciliationContract,
      "/deployment/admin/reconciliation",
    ],
    [adminDeployAttemptHistoryContract, deployAttemptHistoryContract, "/deployment/admin/attempts"],
  ] as const)("reuses the internal schemas for %s", (admin, internal, path) => {
    expect(admin.method).toBe("GET");
    expect(admin.path).toBe(path);
    expect(admin.querySchema).toBe(internal.querySchema);
    expect(admin.responseSchema).toBe(internal.responseSchema);
  });
});
