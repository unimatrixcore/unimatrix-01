import { Link, createFileRoute } from "@tanstack/react-router";

import { Surface } from "@/components/surface";

export const Route = createFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  return (
    <div className="route-stack">
      <Surface>
        <p className="eyebrow">LOC-36</p>
        <h2>Scaffold-only routing surface</h2>
        <p className="body-copy">
          This is the baseline app shell for the monorepo web workspace. Later
          issues will layer in the public IA, design system, typed env
          contracts, and repo-backed content flows.
        </p>
      </Surface>

      <Surface>
        <h2>What lands later</h2>
        <ul className="detail-list">
          <li>LOC-38 will own ShadCN, Tailwind, presets, and visual identity.</li>
          <li>LOC-42 will own typed environment and config validation.</li>
          <li>LOC-45 and the content issues will own the real public routes.</li>
        </ul>
        <p className="body-copy">
          Use the <Link to="/status">status route</Link> to inspect the local
          query-backed scaffold state.
        </p>
      </Surface>
    </div>
  );
}
