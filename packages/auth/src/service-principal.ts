export type ServiceCredentialKind = "oauth_token" | "api_key";

export interface ServicePrincipal {
  readonly credentialKind: ServiceCredentialKind;
  readonly userId: string;
  readonly credentialId: string;
  readonly clientId: string | null;
  readonly resource: string;
  readonly capabilities: readonly string[];
}

export function hasServiceCapability(principal: ServicePrincipal, capability: string): boolean {
  return principal.capabilities.includes(capability);
}
