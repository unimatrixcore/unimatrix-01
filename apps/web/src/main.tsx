import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { AuthBoundary } from "@/app/auth-boundary";
import { Providers } from "@/app/providers";
import { router } from "@/app/router";
import { loadWebRuntimeConfig } from "@/lib/config";
import "@/styles.css";

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Missing #app root element.");
}

document.documentElement.classList.add("dark");
document.documentElement.style.colorScheme = "dark";

const runtimeConfig = loadWebRuntimeConfig({
  VITE_API_BASE_URL: import.meta.env.VITE_API_BASE_URL,
  VITE_AUTH_APP_URL: import.meta.env.VITE_AUTH_APP_URL,
  VITE_CLERK_PUBLISHABLE_KEY: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
});

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AuthBoundary config={runtimeConfig}>
      <Providers>
        <RouterProvider router={router} />
      </Providers>
    </AuthBoundary>
  </React.StrictMode>,
);
