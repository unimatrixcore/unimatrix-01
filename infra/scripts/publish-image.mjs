import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function publicationFromPush(output, { repository, tag, app }) {
  const matches = [...output.matchAll(/^(\S+): digest: (sha256:[a-f0-9]{64}) size: [0-9]+\s*$/gmu)];
  if (matches.length !== 1 || matches[0][1] !== tag || !/^[a-f0-9]{40}$/u.test(tag)) {
    throw new Error("Push did not provide one immutable publication digest.");
  }
  return {
    app,
    image: {
      repository,
      tag,
      commit: tag,
      platform: "linux/amd64",
      digestKind: "manifest",
      digest: matches[0][2],
    },
  };
}

export function publishImage(env = process.env, run = spawnSync, outputDirectory = "publication") {
  const { IMAGE: repository, REVISION: tag, APP: app } = env;
  if (
    !/^ghcr\.io\/unimatrixcore\/unimatrix-[a-z][a-z0-9-]*$/u.test(repository ?? "") ||
    !/^[a-z][a-z0-9-]*$/u.test(app ?? "") ||
    repository !== `ghcr.io/unimatrixcore/unimatrix-${app}` ||
    !/^[a-f0-9]{40}$/u.test(tag ?? "")
  )
    throw new Error("Invalid publication identity.");
  const pushed = run("docker", ["push", "--platform", "linux/amd64", `${repository}:${tag}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (pushed.status !== 0) throw new Error("Image push failed.");
  const publication = publicationFromPush(`${pushed.stdout ?? ""}\n${pushed.stderr ?? ""}`, {
    repository,
    tag,
    app,
  });
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, `${app}.json`), `${JSON.stringify(publication)}\n`);
  if (env.IS_MAIN_PUSH === "true") {
    const main = run("docker", ["push", "--platform", "linux/amd64", `${repository}:main`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (main.status !== 0) throw new Error("Moving image tag push failed.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    publishImage();
  } catch {
    console.error("::error::Image publication failed; no deployment is permitted.");
    process.exitCode = 1;
  }
}
