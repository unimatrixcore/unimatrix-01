import { mutationOptions, queryOptions } from "@tanstack/react-query";

import type { CommandClient, CommandContract } from "./index";

export function commandQueryOptions<Input, Output>(
  client: CommandClient,
  contract: CommandContract<Input, Output>,
  input: Input,
) {
  return queryOptions({
    queryKey: ["tauri", contract.name, input] as const,
    queryFn: () => client(contract, input),
  });
}

export function commandMutationOptions<Input, Output>(
  client: CommandClient,
  contract: CommandContract<Input, Output>,
) {
  return mutationOptions({
    mutationKey: ["tauri", contract.name] as const,
    mutationFn: (input: Input) => client(contract, input),
  });
}
