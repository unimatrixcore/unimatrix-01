import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";

import { queryClient } from "@/lib/query-client";

type ProvidersProps = {
  children: ReactNode;
  client?: QueryClient;
};

export function Providers({ children, client = queryClient }: ProvidersProps) {
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
