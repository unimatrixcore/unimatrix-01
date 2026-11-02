import { CanvasConnectionError } from "@unimatrix/canvas";
import { SecretsClientError, type SecretsClient } from "@unimatrix/secrets/client";
import { CANVAS_ACCESS_TOKEN_SECRET } from "@unimatrix/shared";

export function createCanvasCredentialLoader(client: SecretsClient) {
  return async (signal?: AbortSignal): Promise<string> => {
    try {
      const value = await client.getSecretValue(CANVAS_ACCESS_TOKEN_SECRET.name, {
        ...(signal === undefined ? {} : { signal }),
      });
      return value.reveal();
    } catch (error) {
      if (error instanceof SecretsClientError) {
        if (error.status === 401 || error.status === 403) {
          throw new CanvasConnectionError("CREDENTIAL_DENIED");
        }
        if (error.status === 404) throw new CanvasConnectionError("CREDENTIAL_MISSING");
      }
      throw new CanvasConnectionError("CREDENTIAL_UNAVAILABLE");
    }
  };
}
