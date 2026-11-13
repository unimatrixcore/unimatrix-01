import React from "react";
import ReactDOM from "react-dom/client";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import ControlPanel from "./original/ControlPanel.js";
import { ToolShell } from "@unimatrix/chrome/tool";

function Assistant() {
  return (
    <ToolShell className="h-screen" showFooter={false} width="full">
      <ControlPanel />
    </ToolShell>
  );
}
import "./styles.css";

const root = createRootRoute({ component: Outlet });
const index = createRoute({ getParentRoute: () => root, path: "/", component: Assistant });
const router = createRouter({ routeTree: root.addChildren([index]) });
const element = document.getElementById("app");
if (!element) throw new Error("Missing #app root element.");
document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";
ReactDOM.createRoot(element).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
