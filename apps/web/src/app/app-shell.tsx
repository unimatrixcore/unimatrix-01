import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-shell">
      <header className="shell-header">
        <div className="shell-copy">
          <p className="eyebrow">apps/web scaffold</p>
          <h1>Unimatrix web app shell</h1>
          <p className="lede">
            This workspace now runs a real Vite + React app shell with the
            router, query client, and feature-first folders that later issues
            will extend.
          </p>
        </div>
        <nav aria-label="Scaffold navigation" className="shell-nav">
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ className: "nav-link nav-link-active" }}
            className="nav-link"
            to="/"
          >
            Overview
          </Link>
          <Link
            activeProps={{ className: "nav-link nav-link-active" }}
            className="nav-link"
            to="/status"
          >
            Status
          </Link>
        </nav>
      </header>
      <main className="shell-content">{children}</main>
    </div>
  );
}
