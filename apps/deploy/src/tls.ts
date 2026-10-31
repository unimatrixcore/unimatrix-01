import { createPrivateKey, X509Certificate } from "node:crypto";
import { Agent, type ServerOptions } from "node:https";

export interface DeployTlsEnv {
  NODE_ENV?: string | undefined;
  DEPLOY_TLS_CERT_BASE64?: string | undefined;
  DEPLOY_TLS_KEY_BASE64?: string | undefined;
}

function tlsConfigError(): Error {
  return new Error(
    "Invalid deploy TLS configuration: supply a valid matching base64 PEM certificate and private key; production requires TLS.",
  );
}

function decodePem(value: string): string {
  const encoded = value.trim();
  const decoded = Buffer.from(encoded, "base64");

  if (encoded.length === 0 || decoded.toString("base64") !== encoded) {
    throw tlsConfigError();
  }

  return decoded.toString("utf8");
}

function readCertificate(encoded: string): { pem: string; certificate: X509Certificate } {
  const pem = decodePem(encoded);

  if (
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\s*$/u.test(
      pem,
    )
  ) {
    throw tlsConfigError();
  }

  return { pem, certificate: new X509Certificate(pem) };
}

export function loadDeployTlsOptions(env: DeployTlsEnv = process.env): ServerOptions | undefined {
  const certificateValue = env.DEPLOY_TLS_CERT_BASE64;
  const privateKeyValue = env.DEPLOY_TLS_KEY_BASE64;

  if (
    certificateValue === undefined &&
    privateKeyValue === undefined &&
    env.NODE_ENV?.trim() !== "production"
  ) {
    return undefined;
  }

  if (certificateValue === undefined || privateKeyValue === undefined) {
    throw tlsConfigError();
  }

  try {
    const { pem: cert, certificate } = readCertificate(certificateValue);
    const key = decodePem(privateKeyValue);

    if (
      !/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END (?:RSA |EC )?PRIVATE KEY-----\s*$/u.test(
        key,
      ) ||
      !certificate.checkPrivateKey(createPrivateKey(key))
    ) {
      throw tlsConfigError();
    }

    return { cert, key, minVersion: "TLSv1.2" };
  } catch {
    // OpenSSL errors may carry input fragments; only the configuration category crosses this boundary.
    throw tlsConfigError();
  }
}

export function createDeployPinnedAgent(certificateBase64: string): Agent {
  try {
    const { pem } = readCertificate(certificateBase64);

    // Setting ca replaces Node's default roots. Hostname verification remains enabled.
    return new Agent({ ca: pem, rejectUnauthorized: true, minVersion: "TLSv1.2" });
  } catch {
    throw new Error("Invalid deploy TLS certificate pin: expected one base64 PEM certificate.");
  }
}
