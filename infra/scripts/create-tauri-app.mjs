import { copyFile, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const templates = fileURLToPath(new URL("../templates/tauri-app/", import.meta.url));

export async function createTauriApp({
  name,
  identifier,
  port = 1420,
  router = false,
  root = repository,
}) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name ?? "")) {
    throw new Error("Name must be a lowercase kebab-case application name");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/.test(identifier ?? "")) {
    throw new Error("Identifier must be a stable reverse-DNS identifier");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Port must be an integer from 1024 through 65535");
  }
  const destination = path.join(root, "apps", name);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  try {
    const copy = async (source, target) => {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const output = path.join(target, entry.name.replace(/\.template$/, ""));
        if (entry.isDirectory()) {
          await mkdir(output);
          await copy(path.join(source, entry.name), output);
        } else if (entry.name.endsWith(".png")) {
          await copyFile(path.join(source, entry.name), output);
        } else {
          const body = await readFile(path.join(source, entry.name), "utf8");
          await writeFile(
            output,
            body
              .replaceAll("__NAME__", name)
              .replaceAll("__IDENTIFIER__", identifier)
              .replaceAll("__PORT__", String(port)),
          );
        }
      }
    };
    await copy(templates, destination);
    const packagePath = path.join(destination, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    const reference = JSON.parse(
      await readFile(path.join(repository, "apps/web/package.json"), "utf8"),
    );
    for (const section of ["dependencies", "devDependencies"]) {
      for (const dependency of Object.keys(manifest[section])) {
        manifest[section][dependency] =
          reference[section]?.[dependency] ?? manifest[section][dependency];
      }
    }
    if (router) {
      manifest.dependencies["@tanstack/react-router"] =
        reference.dependencies["@tanstack/react-router"];
      await writeFile(
        path.join(destination, "src/router.tsx"),
        `import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";\nimport { App } from "./app";\nconst rootRoute = createRootRoute();\nconst indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: App });\nexport const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });\ndeclare module "@tanstack/react-router" { interface Register { router: typeof router } }\n`,
      );
      const main = path.join(destination, "src/main.tsx");
      await writeFile(
        main,
        (await readFile(main, "utf8"))
          .replace(
            'import { App } from "./app";',
            'import { RouterProvider } from "@tanstack/react-router";\nimport { router } from "./router";',
          )
          .replace("<App />", "<RouterProvider router={router} />"),
      );
    }
    await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (router) {
      for (const file of ["src/main.tsx", "src/router.tsx"]) {
        const filename = path.join(destination, file);
        await writeFile(
          filename,
          await format(await readFile(filename, "utf8"), { parser: "typescript" }),
        );
      }
    }
    return destination;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const name = args.shift();
  const options = { name };
  while (args.length) {
    const flag = args.shift();
    if (flag === "--identifier") options.identifier = args.shift();
    else if (flag === "--port") options.port = Number(args.shift());
    else if (flag === "--router") options.router = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  const destination = await createTauriApp(options);
  console.log(
    `Created ${destination}\nRun pnpm install, then pnpm --filter @unimatrix/${name} desktop:dev`,
  );
}
