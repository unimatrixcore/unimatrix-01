import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createCommandClient, defineCommand } from "../src/index";
import { commandMutationOptions, commandQueryOptions } from "../src/query";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(4) }));
import { tauriTransport } from "../src/transport";

const command = defineCommand({ name: "count", input: z.number().int(), output: z.number().int() });

describe("command boundary", () => {
  it("validates arguments before transport and results after transport", async () => {
    const transport = vi.fn().mockResolvedValue(4);
    const client = createCommandClient(transport);
    await expect(client(command, 3)).resolves.toBe(4);
    expect(transport).toHaveBeenCalledWith("count", { input: 3 });
    await expect(client(command, 1.5)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockResolvedValue("4");
    await expect(client(command, 3)).rejects.toThrow();
  });
  it("preserves backend rejection identity", async () => {
    const error = new Error("database_busy");
    await expect(createCommandClient(() => Promise.reject(error))(command, 1)).rejects.toBe(error);
  });
  it("maps queries, cache identities and mutations to the same boundary", async () => {
    const client = createCommandClient(tauriTransport);
    const options = commandQueryOptions(client, command, 3);
    expect(options.queryKey).toEqual(["tauri", "count", 3]);
    await expect(new QueryClient().fetchQuery(options)).resolves.toBe(4);
    const mutation = commandMutationOptions(client, command);
    expect(mutation.mutationKey).toEqual(["tauri", "count"]);
    await expect(mutation.mutationFn?.(3, {} as never)).resolves.toBe(4);
  });
});
