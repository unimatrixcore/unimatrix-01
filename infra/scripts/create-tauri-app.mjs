import { copyFile, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const templates = fileURLToPath(new URL("../templates/tauri-app/", import.meta.url));

const optionsSchema = z.strictObject({
  name: z
    .string()
    .regex(
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      "Name must be a lowercase kebab-case application name",
    ),
  identifier: z
    .string()
    .regex(
      /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/,
      "Identifier must be a stable reverse-DNS identifier",
    ),
  port: z
    .number()
    .int("Port must be an integer")
    .min(1024, "Port must be at least 1024")
    .max(65535, "Port must be at most 65535")
    .default(1420),
  router: z.boolean().default(false),
  root: z.string().refine(path.isAbsolute, "Root must be an absolute path").default(repository),
});

async function assertUniqueWorkspaceName(root, name) {
  const manifests = [path.join(root, "lab", "package.json")];
  for (const parent of ["apps", "packages"]) {
    let entries;
    try {
      entries = await readdir(path.join(root, parent), { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    manifests.push(
      ...entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, parent, entry.name, "package.json")),
    );
  }
  for (const file of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    if (manifest.name === name) throw new Error(`Workspace package already exists: ${name}`);
  }
}

export async function createTauriApp(options) {
  const { name, identifier, port, router, root } = optionsSchema.parse(options);
  await assertUniqueWorkspaceName(root, `@unimatrix/${name}`);
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
