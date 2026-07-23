import type { FaceletCube } from "@/features/cube/model";
import { deriveOllDiagram, derivePllDiagram } from "@/features/cube/last-layer-diagram";
import type { LastLayerDiagram } from "@/features/cube/last-layer-diagram";

import type { AlgorithmSetId } from "./types";

/** Picks the OLL- or PLL-appropriate derivation for a given set, so callers don't hand-roll the ternary. */
export function deriveDiagramForSet(setId: AlgorithmSetId, cube: FaceletCube): LastLayerDiagram {
  return setId === "oll" ? deriveOllDiagram(cube) : derivePllDiagram(cube);
}
