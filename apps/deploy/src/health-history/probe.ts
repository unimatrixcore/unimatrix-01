import { X509Certificate } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

import type { DeployDesiredState } from "@unimatrix/deploy-config";

import { PROBE_TIMEOUT_MS, type HealthObservation } from "./model.js";

export interface HealthProbeTarget {
  app: string;
  url: string;
  ca?: string;
  configured: boolean;
}

export function resolveHealthProbeTargets(
  desired: DeployDesiredState,
  env: Readonly<Record<string, string | undefined>>,
): readonly HealthProbeTarget[] {
  return desired.map((service) => {
    const { url, caCertificateEnv } = service.healthProbe;
    if (caCertificateEnv === undefined) return { app: service.appDir, url, configured: true };
    try {
      const encoded = env[caCertificateEnv];
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
        throw new Error("Missing certificate");
      const ca = Buffer.from(encoded, "base64").toString("utf8");
      new X509Certificate(ca);
      return { app: service.appDir, url, ca, configured: true };
    } catch {
      return { app: service.appDir, url, configured: false };
    }
  });
}

/** No redirects, credentials, response bodies or exception text cross this boundary. */
export async function probeHealth(
  target: HealthProbeTarget,
  signal: AbortSignal,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HealthObservation["state"]> {
  if (!target.configured) return "unknown";
  if (signal.aborted) return "unknown";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: HealthObservation["state"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(state);
    };
    const get = target.url.startsWith("https:") ? httpsGet : httpGet;
    const request = get(
      target.url,
      {
        signal,
        ...(target.ca === undefined ? {} : { ca: target.ca }),
        agent: false,
        rejectUnauthorized: true,
      },
      (response) => {
        finish(
          response.statusCode !== undefined &&
            response.statusCode >= 200 &&
            response.statusCode < 300
            ? "up"
            : "down",
        );
        response.destroy();
      },
    );
    const timer = setTimeout(() => {
      finish("down");
      request.destroy();
    }, timeoutMs);
    request.on("error", () => {
      finish(signal.aborted ? "unknown" : "down");
    });
  });
}
