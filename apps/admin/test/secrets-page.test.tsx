import type { ApiClient } from "@unimatrix/api-client";
import type { AdminSecretRow, SecretMetadata } from "@unimatrix/shared";
import type * as EditorModule from "@unimatrix/ui/editor";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderInRouter } from "./helpers/render-in-router";

const apiClient = {
  adminListSecrets: vi.fn(),
  adminCreateSecret: vi.fn(),
  adminRotateSecret: vi.fn(),
  adminDeleteSecret: vi.fn(),
} satisfies Partial<ApiClient>;

vi.mock("@/lib/api-client", () => ({
  useApiClient: () => apiClient as unknown as ApiClient,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Only the toast host is stubbed out — the table and dialogs under test are
// the real primitives from `@unimatrix/ui/editor`.
vi.mock("@unimatrix/ui/editor", async () => {
  const actual = await vi.importActual<typeof EditorModule>("@unimatrix/ui/editor");

  return { ...actual, toast: { success: toastSuccess, error: toastError } };
});

function metadata(overrides: Partial<SecretMetadata> = {}): SecretMetadata {
  return {
    name: "platform/clerk-secret-key",
    maskedPrefix: "sk_l",
    kekVersion: 2,
    createdAt: "2026-07-01T00:00:00.000Z",
    rotatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const PLATFORM_SET: AdminSecretRow = {
  name: "platform/clerk-secret-key",
  tier: "platform",
  metadata: metadata(),
  consumedBy: "apps/api's Clerk backend calls.",
};

const PLATFORM_NOT_SET: AdminSecretRow = {
  name: "platform/clerk-jwt-key",
  tier: "platform",
  metadata: null,
  consumedBy: "Networkless verification of Clerk session tokens.",
};

const INTEGRATION_DECLARED: AdminSecretRow = {
  name: "integrations/github/api-token",
  tier: "integration",
  metadata: metadata({ name: "integrations/github/api-token", maskedPrefix: "ghp_" }),
  consumedBy: "The nightly repository sync.",
};

const INTEGRATION_UNLISTED: AdminSecretRow = {
  name: "integrations/stripe/api-key",
  tier: "integration",
  // Behind the active key, so exactly one row carries the re-seal badge.
  metadata: metadata({ name: "integrations/stripe/api-key", maskedPrefix: "sk_t", kekVersion: 1 }),
  consumedBy: null,
};

function panel(name: "Platform credentials" | "Integrations") {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
  return within(screen.getByRole("region", { name }));
}

/** The credential row containing the name. */
function row(name: string): HTMLElement {
  const element = screen.getByText(name).closest("tr");

  if (element === null) {
    throw new Error(`No row found for ${name}`);
  }

  return element;
}

async function renderPage() {
  const { SecretsPage } = await import("@/features/secrets/secrets-page");

  renderInRouter(<SecretsPage />);

  return screen.findByText("platform/clerk-secret-key");
}

describe("SecretsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.adminListSecrets.mockResolvedValue({
      secrets: [PLATFORM_SET, PLATFORM_NOT_SET, INTEGRATION_DECLARED, INTEGRATION_UNLISTED],
      activeKekVersion: 2,
    });
  });

  it("splits the two tiers into their own panels", async () => {
    await renderPage();

    expect(panel("Platform credentials").getByText("platform/clerk-jwt-key")).toBeInTheDocument();
    expect(
      panel("Platform credentials").queryByText("integrations/github/api-token"),
    ).not.toBeInTheDocument();
    expect(panel("Integrations").getByText("integrations/stripe/api-key")).toBeInTheDocument();

    // Platform names come from the registry, so the panel offers no way to
    // invent one; integrations are the tier an operator adds to.
    expect(
      panel("Platform credentials").queryByRole("button", { name: "Add credential" }),
    ).not.toBeInTheDocument();
    panel("Integrations");
    expect(screen.getByRole("button", { name: "Add credential" })).toBeInTheDocument();
  });

  it("uses fixed table columns without implementation notes", async () => {
    await renderPage();
    expect(screen.queryByText(/never display a credential/u)).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveClass("table-fixed");
    expect(screen.getByRole("columnheader", { name: "Credential" })).toBeInTheDocument();
  });

  /**
   * `consumedBy` is what a destructive dialog needs, not what a row at rest
   * needs — on the row it doubled every credential's height for prose the
   * operator acts on once.
   */
  it("says what is stored and how stale it is, and nothing else", async () => {
    await renderPage();

    const setRow = row("platform/clerk-secret-key");

    expect(setRow).toHaveTextContent("sk_l…");
    expect(setRow).toHaveTextContent(/rotated/u);
    expect(setRow).not.toHaveTextContent(/Clerk backend calls/u);

    // A row with no value has nothing to date, and must not read as rotated at
    // the epoch.
    expect(row("platform/clerk-jwt-key")).toHaveTextContent("No value stored");
  });

  it("badges only the row sealed under an older key", async () => {
    await renderPage();

    panel("Integrations");
    const badges = screen.getAllByText("Sealed under an older key");

    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest("tr")).toHaveTextContent("integrations/stripe/api-key");
  });

  it("offers Set value, not Rotate, for a name the store has nothing for", async () => {
    await renderPage();

    expect(
      screen.getByRole("button", { name: "Set value platform/clerk-jwt-key" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rotate platform/clerk-jwt-key" }),
    ).not.toBeInTheDocument();
    expect(panel("Platform credentials").getAllByText("Not set")).toHaveLength(1);
  });

  /**
   * Decision 3, as the console renders it: clearing Clerk's secret key by
   * misclick is the failure this prevents, and `apps/api` refuses the same
   * call with a 403 behind it.
   */
  it("never offers a destructive action on a platform credential", async () => {
    await renderPage();

    expect(panel("Platform credentials").queryByText("Clear value")).not.toBeInTheDocument();
    expect(
      panel("Integrations").getByRole("button", {
        name: "Clear value integrations/github/api-token",
      }),
    ).toBeInTheDocument();
  });

  it("fills a not-set name through the create route without asking for the name", async () => {
    apiClient.adminCreateSecret.mockResolvedValue(
      metadata({ name: "platform/clerk-jwt-key", maskedPrefix: "eyJh" }),
    );
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Set value platform/clerk-jwt-key" }));

    const dialog = await screen.findByRole("dialog");

    // The name came from the registry: it is stated, never typed.
    expect(within(dialog).getByText("platform/clerk-jwt-key")).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/Networkless verification of Clerk session tokens/u),
    ).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "a-new-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set value" }));

    await waitFor(() => {
      expect(apiClient.adminCreateSecret).toHaveBeenCalledWith({
        name: "platform/clerk-jwt-key",
        value: "a-new-key",
      });
    });
    expect(toastSuccess).toHaveBeenCalledWith('"platform/clerk-jwt-key" set.');
  });

  it("refuses a new name the store could never hold, before sending it", async () => {
    await renderPage();

    panel("Integrations");
    fireEvent.click(screen.getByRole("button", { name: "Add credential" }));

    const dialog = await screen.findByRole("dialog");
    const nameField = within(dialog).getByLabelText("Name");
    const submit = within(dialog).getByRole("button", { name: "Add credential" });

    fireEvent.change(nameField, { target: { value: "Slack_Token" } });
    expect(submit).toBeDisabled();

    fireEvent.change(nameField, { target: { value: "slack/bot-token" } });
    expect(submit).toBeEnabled();

    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "xoxb-1" } });
    fireEvent.click(submit);

    // The fixed affix is part of the name, not decoration around the field.
    await waitFor(() => {
      expect(apiClient.adminCreateSecret).toHaveBeenCalledWith({
        name: "integrations/slack/bot-token",
        value: "xoxb-1",
      });
    });
  });

  it("says the current value is never shown when rotating", async () => {
    await renderPage();

    panel("Integrations");
    fireEvent.click(screen.getByRole("button", { name: "Rotate integrations/github/api-token" }));

    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/never shown here, by design/u)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("New value"), { target: { value: "ghp_new" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));

    await waitFor(() => {
      expect(apiClient.adminRotateSecret).toHaveBeenCalledWith({
        name: "integrations/github/api-token",
        value: "ghp_new",
      });
    });
  });

  /**
   * The two halves of the destructive dialog that the first build had neither
   * of: what actually consumes this credential, and whether the row survives.
   */
  it("names what consumes a declared credential and says its row stays listed", async () => {
    await renderPage();

    panel("Integrations");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear value integrations/github/api-token" }),
    );

    const dialog = await screen.findByRole("alertdialog");

    expect(within(dialog).getByText("The nightly repository sync.")).toBeInTheDocument();
    expect(within(dialog).getByText(/row stays listed as Not set/u)).toBeInTheDocument();
    expect(within(dialog).queryByText(/disappears from this console/u)).not.toBeInTheDocument();
  });

  it("says an unlisted credential's row disappears instead", async () => {
    await renderPage();

    panel("Integrations");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear value integrations/stripe/api-key" }),
    );

    const dialog = await screen.findByRole("alertdialog");

    expect(within(dialog).getByText(/disappears from this console/u)).toBeInTheDocument();
    expect(within(dialog).queryByText(/row stays listed as Not set/u)).not.toBeInTheDocument();
  });

  it("clears nothing until the full name is typed", async () => {
    apiClient.adminDeleteSecret.mockResolvedValue({ deleted: true });
    await renderPage();

    panel("Integrations");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear value integrations/github/api-token" }),
    );

    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear value" });

    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Type the full name to confirm"), {
      target: { value: "integrations/github" },
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Type the full name to confirm"), {
      target: { value: "integrations/github/api-token" },
    });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(apiClient.adminDeleteSecret).toHaveBeenCalledWith({
        name: "integrations/github/api-token",
      });
    });
    // The action's own word, so the confirmation of what happened matches the
    // button that did it.
    expect(toastSuccess).toHaveBeenCalledWith('"integrations/github/api-token" cleared.');
  });

  it("reports a failed load in both panels instead of rendering empty tables", async () => {
    apiClient.adminListSecrets.mockRejectedValue(new Error("network down"));

    const { SecretsPage } = await import("@/features/secrets/secrets-page");

    renderInRouter(<SecretsPage />);

    expect(await screen.findAllByText("Credentials could not be loaded.")).toHaveLength(2);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("invites the operator to act rather than describing an empty list", async () => {
    apiClient.adminListSecrets.mockResolvedValue({ secrets: [], activeKekVersion: 1 });

    const { SecretsPage } = await import("@/features/secrets/secrets-page");

    renderInRouter(<SecretsPage />);

    expect(
      await screen.findByText(/Add a credential when you wire a provider up/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Create one to see it listed here/u)).not.toBeInTheDocument();
  });
});
