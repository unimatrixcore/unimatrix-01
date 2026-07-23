/**
 * Open-redirect protection for the `redirect_url` a service passes when it
 * sends a user to the auth app (e.g. `auth.unimatrix-01.dev/sign-in?redirect_url=...`).
 *
 * Only same-family origins are honored: the `unimatrix-01.dev` apex and its
 * subdomains over https, plus localhost during development. Anything else
 * falls back to the auth app's own landing, so this app can never be abused
 * as an open redirector to an attacker-controlled site.
 */
const ROOT_DOMAIN = "unimatrix-01.dev";

function isAllowedRedirectUrl(raw: string): boolean {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    // Not an absolute URL (relative paths, garbage) — never honored.
    return false;
  }

  const { hostname, protocol } = url;

  // Production: the root domain or any of its subdomains, https only. The
  // leading dot in the suffix check prevents lookalikes like
  // `evilunimatrix-01.dev` or `unimatrix-01.dev.attacker.com` from matching.
  if (hostname === ROOT_DOMAIN || hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    return protocol === "https:";
  }

  // Local development across the sibling dev servers (web 5173, auth 5175,
  // cube 5173, previews 417x, etc.) — any port on loopback, http or https.
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return protocol === "http:" || protocol === "https:";
  }

  return false;
}

/**
 * Returns `raw` when it is a safe same-family redirect target, otherwise
 * `fallback` (the auth app's landing by default). Pass the result to Clerk's
 * `forceRedirectUrl` so post-auth navigation only ever lands on trusted
 * origins.
 */
export function safeRedirectUrl(raw: string | undefined, fallback = "/"): string {
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }

  return isAllowedRedirectUrl(raw) ? raw : fallback;
}

/**
 * Appends a `redirect_url` query param to an in-app path so switching between
 * `/sign-in` and `/sign-up` preserves the originating destination. The value
 * is passed through unvalidated (it is re-validated by {@link safeRedirectUrl}
 * on the destination route before it is ever used as a redirect target).
 */
export function withRedirectParam(path: string, redirectUrl: string | undefined): string {
  if (redirectUrl === undefined || redirectUrl.length === 0) {
    return path;
  }

  return `${path}?redirect_url=${encodeURIComponent(redirectUrl)}`;
}
