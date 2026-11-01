export interface DokployCreationEnv {
  DOKPLOY_ENVIRONMENT_ID?: string | undefined;
  DOKPLOY_GITHUB_ID?: string | undefined;
}

export interface DokployCreationConfig {
  readonly environmentId: string;
  readonly githubId: string;
}

function readIdentifier(name: keyof DokployCreationEnv, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be set for service creation.`);
  }

  const identifier = value.trim();
  if (identifier.length > 256 || /\s/u.test(identifier) || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must be a valid opaque identifier.`);
  }

  return identifier;
}

export function loadDokployCreationConfig(
  env: DokployCreationEnv = process.env,
): DokployCreationConfig {
  return {
    environmentId: readIdentifier("DOKPLOY_ENVIRONMENT_ID", env.DOKPLOY_ENVIRONMENT_ID),
    githubId: readIdentifier("DOKPLOY_GITHUB_ID", env.DOKPLOY_GITHUB_ID),
  };
}
