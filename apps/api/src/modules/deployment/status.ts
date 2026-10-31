import type { DeployClient } from "@unimatrix/deploy-client";
import type {
  DeployHealthHistoryResponse,
  PublicDeploymentStatusResponse,
} from "@unimatrix/shared";

import { ApiError } from "../../lib/http/errors.js";

const CACHE_MS = 15_000;
const SAMPLE_MS = 60_000;
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  api: "API",
  web: "Unimatrix",
  cflop: "CFLOP",
};

export interface VisibilityDeclaration {
  appDir: string;
  publicStatus?: boolean;
}

export function selectPublicApps<T extends VisibilityDeclaration>(apps: readonly T[]): T[] {
  return apps.filter((app) => app.publicStatus === true);
}

interface CachedApp {
  displayName: string;
  health: DeployHealthHistoryResponse | null;
}

export function createPublicStatusReader(client: DeployClient | null, now = Date.now) {
  let cached: CachedApp[] | null = null;
  let expiresAt = 0;
  let pending: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      if (client === null) throw new Error();
      const state = await client.getState();
      cached = await Promise.all(
        selectPublicApps(state.apps).map(async (app) => {
          let health: DeployHealthHistoryResponse | null = null;
          try {
            const observation = await client.getHealth(app.appDir);
            if (observation.app === app.appDir && observation.current.app === app.appDir)
              health = observation;
          } catch {
            // Failed monitoring must not preserve a previous healthy sample.
          }
          return { displayName: DISPLAY_NAMES[app.appDir] ?? app.appDir, health };
        }),
      );
    } catch {
      // Without a current declaration, even a cached app may have opted out.
      cached = null;
    } finally {
      expiresAt = now() + CACHE_MS;
    }
  }

  return async (): Promise<PublicDeploymentStatusResponse> => {
    if (now() >= expiresAt) {
      pending ??= refresh().finally(() => {
        pending = null;
      });
      await pending;
    }
    if (cached === null) {
      throw new ApiError({
        message: "Deployment status unavailable",
        statusCode: 503,
        code: "INTERNAL_ERROR",
      });
    }
    const checkedNow = now();
    return {
      apps: cached.map(({ displayName, health }) => {
        const checkedAt = health?.current.checkedAt ?? null;
        const fresh =
          health?.freshness === "fresh" &&
          checkedAt !== null &&
          checkedAt <= checkedNow &&
          checkedNow - checkedAt < SAMPLE_MS;
        const state =
          fresh && health?.current.state !== "unknown" ? health.current.state : "degraded";
        return {
          displayName,
          state,
          lastCheckedAt: checkedAt === null ? null : Math.floor(checkedAt / SAMPLE_MS) * SAMPLE_MS,
        };
      }),
    };
  };
}
