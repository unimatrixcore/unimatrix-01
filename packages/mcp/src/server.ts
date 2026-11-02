import { McpServer } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { hasServiceCapability } from "@unimatrix/auth";
import type { ServicePrincipal } from "@unimatrix/auth";
import type { z } from "zod";

export interface ToolExecutionContext {
  readonly principal: ServicePrincipal;
  readonly signal: AbortSignal;
}

export interface ToolResult<Data> {
  readonly data: Data;
  readonly text: string;
}

export interface ToolDefinition<Input extends z.ZodObject, Output extends z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: Input;
  readonly outputSchema: Output;
  readonly annotations: ToolAnnotations;
  execute(
    input: z.output<Input>,
    context: ToolExecutionContext,
  ): Promise<ToolResult<z.input<Output>>>;
}

export interface McpTool {
  readonly name: string;
  readonly capabilities: readonly string[];
  register(server: McpServer, principal: ServicePrincipal, maxResultBytes: number): void;
}

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpTool[];
  readonly maxResultBytes?: number;
}

/** Only explicitly public messages belong in this error. */
export class ToolExecutionError extends Error {}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function advertisedSchema(schema: z.ZodObject): StandardSchemaWithJSON {
  return {
    "~standard": {
      ...schema["~standard"],
      // Validate inside the bounded handler: SDK validation errors bypass its result limit.
      validate(value) {
        return { value };
      },
    },
  };
}

export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  definition: ToolDefinition<Input, Output>,
): McpTool {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(definition.name)) {
    throw new TypeError("Invalid MCP tool name");
  }
  if (!definition.capabilities.length || definition.capabilities.some((value) => !value.trim())) {
    throw new TypeError("MCP tools require capabilities");
  }
  const capabilities = Object.freeze([...definition.capabilities]);
  return Object.freeze({
    name: definition.name,
    capabilities,
    register(server: McpServer, principal: ServicePrincipal, maxResultBytes: number) {
      server.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: advertisedSchema(definition.inputSchema),
          outputSchema: advertisedSchema(definition.outputSchema),
          annotations: definition.annotations,
        },
        async (input, context) => {
          try {
            context.mcpReq.signal.throwIfAborted();
            const parsedInput = await definition.inputSchema.safeParseAsync(input);
            if (!parsedInput.success) return failure("Invalid tool arguments");
            const result = await definition.execute(parsedInput.data, {
              principal,
              signal: context.mcpReq.signal,
            });
            context.mcpReq.signal.throwIfAborted();
            const parsed = await definition.outputSchema.safeParseAsync(result.data);
            if (!parsed.success || typeof result.text !== "string") {
              return failure("Tool returned invalid output");
            }
            const response: CallToolResult = {
              structuredContent: parsed.data,
              content: [{ type: "text", text: result.text }],
            };
            if (Buffer.byteLength(JSON.stringify(response), "utf8") > maxResultBytes) {
              return failure("Tool output exceeds the response limit; narrow the request");
            }
            return response;
          } catch (error) {
            if (context.mcpReq.signal.aborted) return failure("Tool request cancelled");
            if (error instanceof ToolExecutionError) {
              const response = failure(error.message);
              if (Buffer.byteLength(JSON.stringify(response), "utf8") <= maxResultBytes) {
                return response;
              }
            }
            return failure("Tool execution failed");
          }
        },
      );
    },
  });
}

export function validateServerOptions(options: McpServerOptions): number {
  const maxResultBytes = options.maxResultBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 256) {
    throw new TypeError("maxResultBytes must be an integer of at least 256");
  }
  const names = new Set<string>();
  for (const tool of options.tools) {
    if (names.has(tool.name)) throw new TypeError("Duplicate MCP tool name");
    names.add(tool.name);
  }
  return maxResultBytes;
}

export function createToolServer(
  options: McpServerOptions,
  principal: ServicePrincipal,
): McpServer {
  const maxResultBytes = validateServerOptions(options);
  const server = new McpServer({ name: options.name, version: options.version });
  for (const tool of options.tools) {
    if (tool.capabilities.every((capability) => hasServiceCapability(principal, capability))) {
      tool.register(server, principal, maxResultBytes);
    }
  }
  return server;
}
