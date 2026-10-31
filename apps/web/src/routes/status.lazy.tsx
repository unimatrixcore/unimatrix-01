import { createLazyFileRoute } from "@tanstack/react-router";

import { PublicStatusPage } from "@/features/status/public-status-page";

export const Route = createLazyFileRoute("/status")({ component: PublicStatusPage });
