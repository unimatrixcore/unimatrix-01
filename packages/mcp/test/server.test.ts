import { createMcpHandler, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import type { ServicePrincipal } from "@unimatrix/auth";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { createToolServer, defineTool, ToolExecutionError } from "../src/index.js";
import type { McpTool, ToolDefinition, ToolExecutionContext } from "../src/index.js";

const principal: ServicePrincipal = {
  credentialKind: "oauth_token",
  userId: "owner",
  credentialId: "credential",
  clientId: "client",
  resource: "https://example.com/mcp",
  capabilities: ["notes:read"],
};
const inputSchema = z.object({ count: z.number().int().min(1).max(20) });
const outputSchema = z.object({ value: z.string() });
const definition: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: "notes",
  description: "Read synthetic notes",
  capabilities: ["notes:read"],
  inputSchema,
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  execute(input, context) {
    expectTypeOf(input.count).toEqualTypeOf<number>();
    expect(context.principal).toBe(principal);
    return Promise.resolve({
      data: { value: "note".repeat(input.count) },
      text: "A readable note",
    });
  },
};

interface Reply {
  result?: {
    tools?: { name: string; annotations: Record<string, unknown> }[];
    structuredContent?: { value: string };
    content?: { text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function call(
  tools: readonly McpTool[],
  method = "tools/call",
  params: Record<string, unknown> = { name: "notes", arguments: { count: 2 } },
  maxResultBytes?: number,
): Promise<Reply> {
  const handler = createMcpHandler(() =>
    createToolServer(
      {
        name: "test",
        version: "1",
        tools,
        ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
      },
      principal,
    ),
  );
  try {
    const response = await handler.fetch(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const text = await response.text();
    const json = text.startsWith("event:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      : text;
    return JSON.parse(json) as Reply;
  } finally {
    await handler.close();
  }
}

describe("typed MCP tools", () => {
  it("returns schema-validated structured output and readable text", async () => {
    expect(await call([defineTool(definition)])).toMatchObject({
      result: { structuredContent: { value: "notenote" }, content: [{ text: "A readable note" }] },
    });
  });

  it("passes transformed input to the executor exactly once", async () => {
    const tool = defineTool({
      ...definition,
      inputSchema: z.object({ count: z.number().transform((count) => count + 1) }),
      execute(input) {
        return Promise.resolve({ data: { value: String(input.count) }, text: "Transformed" });
      },
    });
    expect(await call([tool])).toMatchObject({ result: { structuredContent: { value: "3" } } });
  });

  it("bounds schema failures and validates transformed output exactly once", async () => {
    const input = defineTool({
      ...definition,
      inputSchema: z.object({ values: z.array(z.string().max(1, "private-validation-detail")) }),
      execute() {
        throw new Error("Invalid input must not execute");
      },
    });
    const invalid = await call(
      [input],
      "tools/call",
      {
        name: "notes",
        arguments: { values: Array<string>(100).fill("private-input") },
      },
      256,
    );
    expect(invalid.result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Invalid tool arguments" }],
    });
    expect(Buffer.byteLength(JSON.stringify(invalid.result))).toBeLessThanOrEqual(256);

    const output = defineTool({
      ...definition,
      outputSchema: z.object({ value: z.number().transform(String).pipe(z.string()) }),
      execute() {
        return Promise.resolve({ data: { value: 42 }, text: "Forty-two" });
      },
    });
    expect(await call([output])).toMatchObject({ result: { structuredContent: { value: "42" } } });
    const catalog = await call([output], "tools/list", {});
    expect(catalog.error).toBeUndefined();
  });

  it("advertises read annotations and hides unauthorized tools", async () => {
    const hidden = defineTool({ ...definition, name: "private", capabilities: ["private:read"] });
    const reply = await call([defineTool(definition), hidden], "tools/list", {});
    expect(reply.result?.tools).toEqual([
      expect.objectContaining({ name: "notes", annotations: definition.annotations }),
    ]);
    expect(
      await call([hidden], "tools/call", { name: "private", arguments: { count: 2 } }),
    ).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("returns protocol errors for invalid arguments and unknown methods/tools", async () => {
    const tools = [defineTool(definition)];
    expect(
      await call(tools, "tools/call", { name: "notes", arguments: { count: 99 } }),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "Invalid tool arguments" }],
      },
    });
    expect(await call(tools, "unknown", {})).toMatchObject({ error: { code: -32601 } });
    expect(await call(tools, "tools/call", { name: "missing", arguments: {} })).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("sanitizes executor and output validation failures", async () => {
    const broken = defineTool({
      ...definition,
      execute: () => {
        throw new Error("private-token");
      },
    });
    expect(await call([broken])).toMatchObject({
      result: { isError: true, content: [{ text: "Tool execution failed" }] },
    });
    const invalid = defineTool({
      ...definition,
      outputSchema: outputSchema.extend({ value: z.string().max(1) }),
    });
    expect(await call([invalid])).toMatchObject({
      result: { isError: true, content: [{ text: "Tool returned invalid output" }] },
    });
  });

  it("bounds UTF-8 output and explicit public errors without silently truncating", async () => {
    const large = defineTool({
      ...definition,
      execute() {
        return Promise.resolve({ data: { value: "🌌".repeat(80) }, text: "bounded" });
      },
    });
    expect(await call([large], undefined, undefined, 256)).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("response limit") as string }],
      },
    });
    for (const message of ["Try a smaller window", "x".repeat(300)]) {
      const tool = defineTool({
        ...definition,
        execute: () => {
          throw new ToolExecutionError(message);
        },
      });
      expect(await call([tool], undefined, undefined, 256)).toMatchObject({
        result: {
          isError: true,
          content: [{ text: message.length < 128 ? message : "Tool execution failed" }],
        },
      });
    }
  });

  it("rejects invalid registration and limits", () => {
    expect(() => defineTool({ ...definition, name: "bad tool" })).toThrow("tool name");
    expect(() => defineTool({ ...definition, capabilities: [] })).toThrow("capabilities");
    expect(() => defineTool({ ...definition, capabilities: [" "] })).toThrow("capabilities");
    const tool = defineTool(definition);
    expect(() =>
      createToolServer({ name: "t", version: "1", tools: [tool, tool] }, principal),
    ).toThrow("Duplicate");
    for (const maxResultBytes of [0, 255, 1.5, NaN, Infinity]) {
      expect(() =>
        createToolServer({ name: "t", version: "1", tools: [], maxResultBytes }, principal),
      ).toThrow("maxResultBytes");
    }
  });

  it("propagates cancellation to in-process execution", async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let aborted!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const tool = defineTool({
      ...definition,
      async execute(_input: z.output<typeof inputSchema>, context: ToolExecutionContext) {
        entered();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true },
          );
        });
        return { data: { value: "cancelled" }, text: "cancelled" };
      },
    });
    const handler = createMcpHandler(() =>
      createToolServer({ name: "t", version: "1", tools: [tool] }, principal),
    );
    const response = handler
      .fetch(
        new Request("https://example.com/mcp", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "notes",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "notes",
              arguments: { count: 1 },
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      )
      .catch(() => undefined);
    try {
      await Promise.race([
        started,
        response.then(async (reply) => {
          throw new Error(await reply?.text());
        }),
      ]);
      controller.abort();
      await cancelled;
      await response;
    } finally {
      await handler.close();
    }
  });
});
