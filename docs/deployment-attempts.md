# Deployment attempts

The deploy service retains attempts on its existing SQLite volume. Internal callers use the
contracts in `packages/shared/src/contracts/deployment-attempts.ts`: `manage` reports intent and
mutation results; `read` can retrieve bounded history. The caller identity comes from the verified
service token. Reporting never mutates Dokploy. Manual and rollback triggers fit the same record;
their execution paths remain separate work. Direct Dokploy UI operations have no recorded attempt.

An intent captures a server-observed baseline, or explicit missing evidence. CI durably claims each
tag write and queue request before sending it. Claims are exclusive: an interrupted claim is never
automatically replayed. Retry the idempotent intent or terminal report, not a Dokploy mutation.
Cancellation between a claim and a mutation can therefore leave a record that needs investigation.
A queue claim without its terminal acknowledgment or unknown-result report cannot establish landing,
even if a matching image appears; the record expires if that report never arrives.
Landing evidence must be observed at or after the persisted queue-claim timestamp. Older records
without that timestamp remain readable but cannot establish landing.

Outcomes are `incomplete`, `queued`, `landed`, `failed` or `timed-out`. Acknowledged queueing is
separate from image landing and health. Transport failures and server failures leave an unknown
request result. A changed full container ID plus an independently verified matching immutable
platform manifest can establish landing; missing baseline, overlapping requests, unchanged IDs and
different digests cannot. A 30-minute deadline expires even without a CI callback or runtime sample.
A later match retains the timeout and records late landing separately. History retains records for
30 days after their deadline, returns at most 100 per read, and refuses new intents at 10,000 retained
records rather than evicting unresolved evidence. Preserve the deploy data volume across replacement.

## Attempt logs

Internal readers select an app and attempt UUID through the static logs contract in
`packages/shared/src/contracts/deployment-attempts.ts`. The API exposes the corresponding
`/deployment/admin/attempts/logs` read only to the `deploys` admin section, with `no-store` responses.
Neither endpoint accepts a caller-supplied Dokploy ID or file path.

Recording-enabled CI queues with the exact title `unimatrix-attempt:<attempt UUID>`. Retrieval
requires a unique title match on the declared app's repository-owned compose service. It never
substitutes the latest deployment, a matching image or a time window. Duplicate matches and shared
log paths are ambiguous. An absent marker, including on older attempts or after Dokploy prunes its
history, is explicitly unassociated. Missing files, empty responses and failed source reads are
unavailable. Attempt retention does not extend Dokploy's log retention.

The output policy is `recognized-events-only`. `apps/deploy/src/dokploy/log-client.ts` maps exact
whole lines to fixed event codes; arbitrary text, paths, titles, error bodies and substrings are
withheld. These events describe source messages, not independently verified deployment outcomes.
The response contains at most 100 events from the last 100 source lines. A sentinel line makes
tail truncation explicit; unrecognized nonempty lines set `withheld`. Source responses exceeding
the byte or text bound are unavailable rather than partially parsed. This policy does not attempt
to redact arbitrary output or disclose raw logs.

Read-only checks on unimatrix-03 on 2026-10-31 observed `deployment.allByCompose` returning
deployment rows and `deployment.readLogs` returning a JSON string on the installed v0.30.10.
The installed source prunes older rows/files when creating deployments. A production deployment
with the UUID title marker has not been exercised; verify it during the controlled activation trial
below. Existing unmarked deployments cannot establish that association.

## Host-local runtime bridge

Run `apps/deploy/src/cli/runtime-evidence.ts` from a trusted checkout on the Docker host using the
pinned Node runtime and installed workspace dependencies. Its compiled entry point is
`apps/deploy/dist/cli/runtime-evidence.js`. Pass the absolute output path as its only argument.
Schedule serial executions frequently enough that the last completed snapshot stays under 30
seconds old. Put the output at `runtime-images.json` in the actual Compose-prefixed deploy-data
volume, beside `deploy.sqlite`; identify the mounted volume on the host rather than assuming its
name. The service reads that file only; it needs no Docker socket, host SSH credential or registry token.

The bridge reads selected Docker identity fields, then fetches a public GHCR manifest by its
content digest. It checks the raw bytes' SHA-256 and matches the manifest's config digest to that
specific container's image config ID. Index manifests are rejected. Competing app mappings,
stale/future snapshots and unsupported identities yield no landing evidence. Snapshots contain
image metadata only and are written atomically with service-readable permissions. Keep the volume
and writer restricted to trusted host administrators; the metadata file is a trusted evidence input.

The collector was executed read-only against unimatrix-03 on 2026-10-30. Every declared app yielded
full container and platform-manifest evidence with the config relationship verified. The check
used the actual collector with Docker commands over SSH and raw GHCR responses; it wrote no host
state. This establishes the source shape, not a scheduled bridge installation or a rollout result.

## Restricted CI ingress and activation

Keep repository variable `DEPLOY_ATTEMPTS_ENABLED` unset or `false` until these steps are complete.
Disabled mode retains the existing CI-to-Dokploy orchestration without recording attempts.

1. Deploy the recording-capable service while preserving its data volume. Install and schedule the
   host bridge on unimatrix-03. Confirm the service user can read fresh snapshots across collector
   runs and after replacing the deploy container. Avoid overlapping collector jobs.
2. Provision a dedicated HTTPS reporting origin behind a Cloudflare Access Service Auth policy.
   Permit only POST `/deployment/attempts/intent` and POST `/deployment/attempts/report` at the
   ingress; deny every other path and method before forwarding. Do not route the whole deploy
   service through a generic Domains entry. The origin connection must use pinned HTTPS to
   `deploy:3001`, with hostname verification and the deploy certificate as its trust anchor.
   Keep internal history, reconciliation, state and token operations unreachable at that origin.
3. Issue a deploy-owned `manage` token named for CI using the host-local token CLI. Store it as
   Actions secret `DEPLOY_REPORT_TOKEN`; configure the HTTPS origin as repository variable
   `DEPLOY_REPORT_URL`. Authorize the existing Actions Cloudflare service token for this reporting
   application as well. Do not print credentials, request bodies or upstream response bodies.
4. Exercise the restricted origin from a GitHub-hosted runner: verify the service identity, reject
   anonymous and read-token writes, reject unrelated routes, and persist an intent without any
   Dokploy mutation. Repeat it to confirm the stable ID; conflict its digest to confirm rejection.
5. Verify a `Publish` run's artifact against its own successful SHA-tag push output. Publication
   captures that push's digest, never a later SHA-tag lookup. Artifacts are scoped to the workflow
   run attempt; rerun all Publish and Deploy jobs together. A failed-jobs-only rerun without matching
   publication artifacts must refuse deployment.
6. Set `DEPLOY_ATTEMPTS_ENABLED=true` only after those checks. Run a controlled deployment and
   verify durable intent precedes writes, queue acknowledgment precedes observed landing, and
   restart resumes from the persisted baseline. Exercise callback loss, overlapping runs, late
   landing, a same-tag rebuild with a different digest and unchanged-ID redeployment. Keep health
   and configuration readback as separate checks.

Ingress provisioning, scheduled bridge installation, Actions publication capture and the controlled
end-to-end trial have not been performed. Local regression tests cover their request ordering and
correlation failure cases; they do not establish production reachability. Leave activation off until
the live checks above pass. Disabling activation later creates an explicit history gap for subsequent
CI deployments; it does not remove already recorded attempts or cancel queued work.
