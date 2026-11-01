import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeEvidenceReader } from "../src/attempts/runtime-evidence.js";
import {
  collectRuntimeEvidence,
  readGhcrManifest,
  writeRuntimeEvidence,
} from "../src/cli/runtime-evidence.js";

const id = "a".repeat(64);
const config = `sha256:${"b".repeat(64)}`;
const repository = "ghcr.io/unimatrixcore/unimatrix-api";
const apps = [{ appDir: "api", image: repository }];
const now = 100_000;
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: config },
  }),
);
const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
function docker(
  options: { ids?: string; image?: object; container?: object; references?: string[] } = {},
) {
  return (args: readonly string[]): Promise<string> => {
    if (args[0] === "ps") return Promise.resolve(options.ids ?? id);
    if (args[0] === "inspect") {
      assert.equal(args.at(-1), id);
      assert.equal(args.includes("--format"), true);
      return Promise.resolve(JSON.stringify(options.container ?? { Id: id, Image: config }));
    }
    assert.equal(args[0], "image");
    assert.equal(args.at(-1), config);
    return Promise.resolve(
      JSON.stringify(
        options.image ?? {
          Id: config,
          RepoDigests: options.references ?? [`${repository}@${digest}`],
          Os: "linux",
          Architecture: "amd64",
        },
      ),
    );
  };
}
const readManifest = (repo: string, requested: string) => {
  assert.equal(repo, repository);
  assert.equal(requested, digest);
  return Promise.resolve(manifest);
};

void test("runtime collection links the exact container config to content-verified platform manifest", async () => {
  const snapshot = await collectRuntimeEvidence(docker(), readManifest, apps, () => now);
  assert.deepEqual(snapshot, {
    observedAt: now,
    evidence: [
      {
        app: "api",
        containerId: id,
        observedAt: now,
        image: { repository, digest, digestKind: "manifest", platform: "linux/amd64" },
      },
    ],
  });
});

void test("runtime collection refuses invalid IDs, ambiguous aliases, unmatched repos and malformed Docker output", async () => {
  for (const command of [
    docker({ ids: "short-id" }),
    docker({ ids: Array.from({ length: 65 }, () => id).join("\n") }),
    docker({ ids: "" }),
    docker({ references: [`${repository}@${digest}`, `${repository}@${digest}`] }),
    docker({ references: [`ghcr.io/other/api@${digest}`] }),
    docker({ container: { Id: id, Image: "bad" } }),
    docker({
      image: {
        Id: `sha256:${"c".repeat(64)}`,
        RepoDigests: [],
        Os: "linux",
        Architecture: "amd64",
      },
    }),
  ])
    assert.equal(
      (await collectRuntimeEvidence(command, readManifest, apps, () => now)).evidence.length,
      0,
    );
  assert.equal(
    (await collectRuntimeEvidence(docker(), readManifest, [...apps, ...apps], () => now)).evidence
      .length,
    0,
  );
});

void test("runtime collection rejects wrong content hash, index manifests, config mismatch and unavailable registry", async () => {
  assert.equal(
    (
      await collectRuntimeEvidence(
        docker(),
        () => Promise.resolve(Buffer.from("wrong")),
        apps,
        () => now,
      )
    ).evidence.length,
    0,
  );
  assert.equal(
    (
      await collectRuntimeEvidence(
        docker(),
        () => Promise.reject(new Error("offline")),
        apps,
        () => now,
      )
    ).evidence.length,
    0,
  );
  for (const value of [
    { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] },
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"c".repeat(64)}` },
    },
  ]) {
    const bytes = Buffer.from(JSON.stringify(value));
    const requested = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(
      (
        await collectRuntimeEvidence(
          docker({ references: [`${repository}@${requested}`] }),
          () => Promise.resolve(bytes),
          apps,
          () => now,
        )
      ).evidence.length,
      0,
    );
  }
});

void test("runtime reader rejects stale, future, oversized, malformed and inconsistent snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deploy-evidence-"));
  const path = join(directory, "runtime-images.json");
  const read = createRuntimeEvidenceReader(path, () => now);
  try {
    assert.deepEqual(await read(), []);
    const snapshot = await collectRuntimeEvidence(docker(), readManifest, apps, () => now);
    await writeRuntimeEvidence(path, { docker: docker(), readManifest, apps, now: () => now });
    assert.deepEqual(await read(), snapshot.evidence);
    for (const value of [
      { ...snapshot, observedAt: now - 30_001 },
      { ...snapshot, observedAt: now + 1 },
      { ...snapshot, evidence: [{ ...snapshot.evidence[0], observedAt: now - 1 }] },
      { ...snapshot, evidence: [...snapshot.evidence, ...snapshot.evidence] },
      { ...snapshot, extra: "untrusted" },
    ]) {
      await writeFile(path, JSON.stringify(value));
      assert.deepEqual(await read(), []);
    }
    await writeFile(path, "x".repeat(1_048_577));
    assert.deepEqual(await read(), []);
    await writeFile(path, "invalid json");
    assert.deepEqual(await read(), []);
    await writeFile(
      path,
      JSON.stringify({
        ...snapshot,
        evidence: [...snapshot.evidence, { ...snapshot.evidence[0], containerId: "d".repeat(64) }],
      }),
    );
    assert.deepEqual(await read(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("GHCR manifest reader authenticates anonymously, requests immutable digest and bounds bodies", async () => {
  const original = globalThis.fetch;
  try {
    const calls: string[] = [];
    globalThis.fetch = (url: string | URL | Request, options?: RequestInit) => {
      calls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      assert.equal(options?.redirect, "error");
      return Promise.resolve(
        calls.length === 1
          ? new Response(JSON.stringify({ token: "anonymous-token" }))
          : new Response(manifest),
      );
    };
    assert.deepEqual(Buffer.from(await readGhcrManifest(repository, digest)), manifest);
    assert.equal(calls[1], `https://ghcr.io/v2/unimatrixcore/unimatrix-api/manifests/${digest}`);
    await assert.rejects(readGhcrManifest("https://evil.test", digest));
    await assert.rejects(readGhcrManifest(repository, "bad"));
    globalThis.fetch = () => Promise.resolve(new Response("unavailable", { status: 503 }));
    await assert.rejects(readGhcrManifest(repository, digest));
    globalThis.fetch = () => Promise.resolve(new Response("x".repeat(1_048_577)));
    await assert.rejects(readGhcrManifest(repository, digest));
  } finally {
    globalThis.fetch = original;
  }
});

void test("runtime metadata is selected from Docker state and explicit image labels", async () => {
  const snapshot = await collectRuntimeEvidence(
    docker({
      container: {
        Id: id,
        Image: config,
        Name: "/api-generated-1",
        StartedAt: "2026-10-31T00:00:00.000Z",
        Health: "healthy",
        ImageReference: `${repository}:main-tag`,
      },
      image: {
        Id: config,
        RepoDigests: [`${repository}@${digest}`],
        Os: "linux",
        Architecture: "amd64",
        Revision: "c".repeat(40),
        CommitSubject: "Build deploys tab",
      },
    }),
    readManifest,
    apps,
    () => now,
  );
  assert.deepEqual(snapshot.evidence[0]?.metadata, {
    name: "api-generated-1",
    startedAt: Date.parse("2026-10-31T00:00:00.000Z"),
    health: "healthy",
    imageTag: "main-tag",
    commit: "c".repeat(40),
    commitSubject: "Build deploys tab",
  });
});
