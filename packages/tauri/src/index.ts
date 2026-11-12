export interface Validator<T> {
  parse(value: unknown): T;
}

export interface CommandContract<Input, Output> {
  name: string;
  input: Validator<Input>;
  output: Validator<Output>;
}

export type InvokeTransport = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function defineCommand<Input, Output>(
  contract: CommandContract<Input, Output>,
): CommandContract<Input, Output> {
  return contract;
}

export function createCommandClient(transport: InvokeTransport) {
  return async function invokeCommand<Input, Output>(
    contract: CommandContract<Input, Output>,
    input: Input,
  ): Promise<Output> {
    const validated = contract.input.parse(input);
    return contract.output.parse(await transport(contract.name, { input: validated }));
  };
}

export type CommandClient = ReturnType<typeof createCommandClient>;
