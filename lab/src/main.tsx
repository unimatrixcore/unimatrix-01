import { InstantListProvider } from "@unimatrix/instant-list";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { router } from "@/app/router";
import "@/styles.css";

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Missing #app root element.");
}

// The lab matches the services: dark by default, set before first paint rather
// than in a component, so nothing renders light and then flips.
document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <InstantListProvider>
      <RouterProvider router={router} />
    </InstantListProvider>
  </React.StrictMode>,
);
