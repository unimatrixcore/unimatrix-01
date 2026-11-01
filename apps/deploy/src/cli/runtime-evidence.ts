import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

import { runtimeEvidenceSnapshotSchema } from "../attempts/runtime-evidence.js";
import { DEPLOY_DESIRED_STATE } from "../reconcile/desired-state.gen.js";

type DockerCommand = (args: readonly string[]) => Promise<string>;
type RegistryRead = (repository: string, digest: string) => Promise<Uint8Array>;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const imageSchema = z.strictObject({
  Id: digestSchema,
  RepoDigests: z.array(z.string().max(512)).max(64),
  Os: z.literal("linux"),
  Architecture: z.enum(["amd64", "arm64"]),
  Revision: z.string().nullable().optional(),
  CommitSubject: z.string().max(512).nullable().optional(),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.enum([
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ]),
  config: z.object({ digest: digestSchema }),
});

export async function collectRuntimeEvidence(
  docker: DockerCommand,
  readManifest: RegistryRead,
  apps: readonly { appDir: string; image: string }[],
  now: () => number = Date.now,
) {
  const observedAt = now();
  const evidence: DeployAttemptRuntimeEvidence[] = [];
  const counts = new Map<string, number>();
  const ids = (await docker(["ps", "--no-trunc", "--format", "{{.ID}}"]))
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (ids.length > 64 || ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
    return { observedAt, evidence };
  for (const id of ids) {
    try {
      const container = z
        .strictObject({
          Id: z.literal(id),
          Image: digestSchema,
          Name: z.string().max(256).optional(),
          StartedAt: z.string().optional(),
          Health: z.enum(["healthy", "unhealthy", "starting"]).nullable().optional(),
          ImageReference: z.string().max(2048).optional(),
        })
        .parse(
          JSON.parse(
            await docker([
              "inspect",
              "--type",
              "container",
              "--format",
              '{"Id":{{json .Id}},"Image":{{json .Image}},"Name":{{json .Name}},"StartedAt":{{json .State.StartedAt}},"Health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},"ImageReference":{{json .Config.Image}}}',
              id,
            ]),
          ),
        );
      const image = imageSchema.parse(
        JSON.parse(
          await docker([
            "image",
            "inspect",
            "--format",
            '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"CommitSubject":{{json (index .Config.Labels "org.opencontainers.image.commit.subject")}}}',
            container.Image,
          ]),
        ),
      );
      if (image.Id !== container.Image) continue;
      const candidates = image.RepoDigests.flatMap((reference) => {
        const [repository, digest] = reference.split("@");
        return repository !== undefined &&
          apps.filter((app) => app.image === repository).length === 1 &&
          digestSchema.safeParse(digest).success
          ? [{ repository, digest: digest! }]
          : [];
      });
      if (candidates.length !== 1) continue;
      const candidate = candidates[0]!;
      const app = apps.find((entry) => entry.image === candidate.repository)!.appDir;
      counts.set(app, (counts.get(app) ?? 0) + 1);
      const bytes = await readManifest(candidate.repository, candidate.digest);
      if (
        bytes.length > 1_048_576 ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== candidate.digest
      )
        continue;
      const manifest = manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
      if (manifest.config.digest !== container.Image) continue;
      evidence.push({
        app,
        containerId: id,
        observedAt,
        ...(container.Name === undefined
          ? {}
          : {
              metadata: {
                name: container.Name.replace(/^\//u, ""),
                startedAt:
                  container.StartedAt !== undefined &&
                  Number.isFinite(Date.parse(container.StartedAt)) &&
                  Date.parse(container.StartedAt) >= 0
                    ? Date.parse(container.StartedAt)
                    : null,
                health: container.Health ?? null,
                imageTag:
                  container.ImageReference?.startsWith(`${candidate.repository}:`) === true
                    ? container.ImageReference.slice(candidate.repository.length + 1)
                    : null,
                commit: /^[a-f0-9]{40}$/u.test(image.Revision ?? "") ? image.Revision! : null,
                commitSubject: image.CommitSubject || null,
              },
            }),
        image: {
          repository: candidate.repository,
          platform: `linux/${image.Architecture}`,
          digestKind: "manifest",
          digest: candidate.digest,
        },
      });
    } catch {
      // A failed source contributes no immutable image evidence.
    }
  }
  return runtimeEvidenceSnapshotSchema.parse({
    observedAt,
    evidence: evidence.filter((entry) => counts.get(entry.app) === 1),
  });
}

async function limitedBody(response: Response): Promise<Uint8Array> {
  if (!response.ok || response.body === null) throw new Error("Registry evidence unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value = z.instanceof(Uint8Array).parse(result.value);
      size += value.length;
      if (size > 1_048_576) throw new Error("Registry evidence too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export async function readGhcrManifest(repository: string, digest: string): Promise<Uint8Array> {
  if (!/^ghcr\.io\/[a-z0-9._/-]+$/u.test(repository) || !digestSchema.safeParse(digest).success)
    throw new Error("Invalid registry evidence identity.");
  const name = repository.slice("ghcr.io/".length);
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`,
    { signal: AbortSignal.timeout(10_000), redirect: "error" },
  );
  const token = z
    .object({ token: z.string().min(1).max(16_384) })
    .parse(JSON.parse(Buffer.from(await limitedBody(tokenResponse)).toString("utf8"))).token;
  return limitedBody(
    await fetch(`https://ghcr.io/v2/${name}/manifests/${digest}`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    }),
  );
}

export interface RuntimeEvidenceCollectionOptions {
  docker?: DockerCommand;
  readManifest?: RegistryRead;
  apps?: readonly { appDir: string; image: string }[];
  now?: () => number;
}

export async function writeRuntimeEvidence(
  path: string,
  options: RuntimeEvidenceCollectionOptions = {},
): Promise<void> {
  const run = promisify(execFile);
  const snapshot = await collectRuntimeEvidence(
    options.docker ??
      (async (args) =>
        (await run("docker", [...args], { timeout: 10_000, maxBuffer: 1_048_576 })).stdout),
    options.readManifest ?? readGhcrManifest,
    options.apps ?? DEPLOY_DESIRED_STATE,
    options.now,
  );
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await writeRuntimeEvidence(process.argv[2] ?? "/data/runtime-images.json");
  } catch {
    console.error("Runtime image evidence collection failed.");
    process.exitCode = 1;
  }
}
