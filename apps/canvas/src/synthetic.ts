import {
  canvasSyntheticEchoInputSchema,
  canvasSyntheticEchoSchema,
  type CanvasSyntheticEcho,
} from "@unimatrix/shared";

export function echoSynthetic(input: unknown): CanvasSyntheticEcho {
  return canvasSyntheticEchoSchema.parse(canvasSyntheticEchoInputSchema.parse(input));
}
