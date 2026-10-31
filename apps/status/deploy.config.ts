import { staticSpaApp } from "@unimatrix/deploy-config";

export default staticSpaApp({
  appDir: "status",
  packageName: "@unimatrix/status",
  publicStatus: false,
  buildArgs: [{ name: "VITE_API_BASE_URL", default: "https://api.unimatrix-01.dev" }],
});
