import type { HomePageContent } from "@unimatrix/content";
import { parseHomeContentFile } from "@unimatrix/content";

import homeSource from "./home.md?raw";

/**
 * App-owned home/about copy is compiled into the bundle so the page heading
 * remains available when the content API cannot be reached.
 */
export const homeContent: HomePageContent = parseHomeContentFile(
  homeSource,
  "apps/web/src/features/content/home.md",
);
