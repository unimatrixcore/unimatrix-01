import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Route as AnalyticsRoute } from "../src/routes/analytics.lazy.js";
import { Route as FeedbackRoute } from "../src/routes/feedback.lazy.js";
import { Route as SocialRoute } from "../src/routes/social.lazy.js";

/**
 * The still-unbuilt section routes render the same placeholder with a
 * different label. One assertion each is enough to prove the route wires the
 * right label through, not a repeat of `NotBuiltPlaceholder`'s own test.
 * Content, Deploys and Secrets are not here — each is built, gated, and covered by its
 * own suite.
 */
const ROUTES = [
  { Route: FeedbackRoute, label: "Feedback" },
  { Route: AnalyticsRoute, label: "Analytics" },
  { Route: SocialRoute, label: "Social" },
];

describe("unbuilt section routes", () => {
  for (const { Route, label } of ROUTES) {
    it(`${label} renders its not-built-yet placeholder`, () => {
      const Component = Route.options.component;

      if (Component === undefined) {
        throw new Error(`${label} route has no component`);
      }

      render(<Component />);

      expect(screen.getByText(`${label} has not been built yet.`)).toBeInTheDocument();
    });
  }
});
