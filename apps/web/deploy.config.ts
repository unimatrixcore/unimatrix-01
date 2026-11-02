import { staticSpaApp } from "@unimatrix/deploy-config";

export default staticSpaApp({
  appDir: "web",
  packageName: "@unimatrix/web",
  publicStatus: true,
  buildArgs: [{ name: "VITE_API_BASE_URL", default: "https://api.unimatrix-01.dev" }],
});
