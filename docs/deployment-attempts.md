# Deployment attempts

The deploy service retains attempts on its existing SQLite volume. Internal callers use the
contracts in `packages/shared/src/contracts/deployment-attempts.ts`: `manage` reports intent and
mutation results and executes reserved CI deployments; `read` retrieves bounded history. The caller identity comes from the verified
service token. Reporting never mutates Dokploy. Manual redeploys use the same history with an
unspecified target image and verified API user attribution; see
[manual redeploys](../apps/deploy/README.md#manual-redeploys). Direct Dokploy UI operations have no
recorded attempt.

An intent captures a server-observed baseline, or explicit missing evidence. Immediately before
execution, the service refreshes that baseline from the runtime bridge and persists it atomically
with the exclusive tag-write claim. This keeps sequential CI batches independent of intent age.
Current evidence must be unique and younger than 30 seconds; missing or stale evidence refuses
before any mutation. A claimed attempt never replaces its baseline on retry.
The same protected intent path accepts a batch through `deployAttemptBatchIntentContract`.
Its app names must be unique and its repository, run ID and run attempt must agree throughout.
Every declaration is checked before one transaction reserves the set. A conflict or an existing
attempt that has begun execution aborts the entire transaction; untouched exact retries preserve
their IDs. Install batch-capable server code before changing CI to this contract, and never
downgrade a rejected batch to separate reservations.
An unexecuted intent can expire without leaving queued work. The execution route
durably claims each service tag write and queue request before sending it. Claims are exclusive: an interrupted claim is never
automatically replayed. Retrying a retained execution or rollback request returns its record without replaying a mutation.
Cancellation between a claim and a mutation can therefore leave a record that needs investigation.
Before accepting requests at startup, the service converts interrupted `queue: started` claims to
`queue: unknown` without dispatching them again. Runtime evidence can then resolve work whose
response was lost during self-replacement. Opening the store from a host CLI does not recover
claims. A claim without an acknowledgment or unknown-result report cannot establish landing,
even if a matching image appears.
Landing evidence must be observed at or after the persisted queue-claim timestamp. Older records
without that timestamp remain readable but cannot establish landing.

Outcomes are `incomplete`, `queued`, `recreated`, `landed`, `already-current`, `failed` or `timed-out`.
CI resolves `already-current` when fresh unique evidence verifies the requested immutable image
and OCI commit are already running. It verifies the stored image tag, correcting it when needed,
and queues no deployment. The resolved record releases the app reservation and survives retries;
it does not claim container replacement, reapplied runtime configuration or a rollback target.
Missing or stale evidence cannot authorize this result. Manual redeploys and rollbacks retain their
explicit execution behavior.
Manual attempts have an unspecified requested image: a changed container ID can record recreation
and its observed image, without claiming immutable landing. Late recreation preserves timeout
and records `recreatedAt`; observed recreation resolves the manual overlap guard.
Manual work requires a verified persistent force-recreation command, including for `deploy` itself.
Configure it with the host-local `enable-recreation` command before queueing; HTTP requests only
check the policy. It reapplies stored Compose configuration without removing data volumes.
During a backend restart the console retains the request UUID and recovers its attempt through
history. A missing response is not a definite failure or permission to issue another request UUID.
Acknowledged queueing is
separate from image landing and health. Transport failures and server failures leave an unknown
request result. A changed full container ID plus an independently verified matching immutable
platform manifest can establish landing; missing baseline, overlapping requests, unchanged IDs and
different digests cannot. A 30-minute deadline expires even without a CI callback or runtime sample.
A later match retains the timeout and records late landing separately. History retains resolved
records for 30 days after their deadline and preserves unresolved
records beyond that window. Reads return at most 100 records; new intents are refused at 10,000
retained records rather than evicting unresolved evidence. Preserve the deploy data volume across replacement.

For a finished CI job that left only unused reservations, use the
[host-local cancellation command](../apps/deploy/README.md#cancel-unused-ci-reservations).
It verifies the exact run cohort and refuses started or uncertain operations atomically. Keep the
originating job and its retries stopped during recovery; cancellation does not fence a new intent
that arrives afterward.

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
The installed Git deployment path overwrites both title and description with commit metadata on
completion, so a completed CI or manual deployment can lose its UUID marker and become
unassociated. Production readback confirmed the marker was absent after completion.
The installed source prunes older rows/files when creating deployments. No durable binding beyond
the UUID title is implemented: an old unmarked attempt cannot be safely associated, and neither a
latest-row nor a time-window fallback is permitted. Verify and report log association independently
of deployment completion.

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
CI refuses deployment while disabled; it never falls back to direct Dokploy mutations.

1. Bootstrap the execution-capable deploy service outside the CI execution path while preserving its data volume. Install and schedule the
   host bridge on unimatrix-03. Confirm the service user can read fresh snapshots across collector
   runs and after replacing the deploy container. Avoid overlapping collector jobs.
2. Provision a dedicated HTTPS reporting origin behind a Cloudflare Access Service Auth policy.
   Permit only POST `/deployment/attempts/intent`, POST `/deployment/execute` and
   GET `/deployment/baselines` at the ingress; deny every other path and method, including
   rollback and reports, before forwarding. Do not route the whole deploy
   service through a generic Domains entry. The origin connection must use pinned HTTPS to
   `deploy:3001`, with hostname verification and the deploy certificate as its trust anchor.
   Keep internal history, reconciliation, state and token operations unreachable at that origin.
3. Issue a deploy-owned `manage` token named for CI using the host-local token CLI. Store it as
   Actions secret `DEPLOY_REPORT_TOKEN`; configure the HTTPS origin as repository variable
   `DEPLOY_REPORT_URL`. Authorize the existing Actions Cloudflare service token for this reporting
   application as well. Do not print credentials, request bodies or upstream response bodies.
4. Exercise the restricted origin from a GitHub-hosted runner: verify the service identity, reject
   anonymous and read-token writes, reject unrelated routes, and read baselines with the CI token.
   Confirm only fresh, unique declared image evidence with a commit is returned, and unresolved
   work withholds its app's baseline. Persist an intent without any Dokploy mutation. Repeat it to
   confirm the stable ID; conflict its digest to confirm rejection.
5. Verify a `Publish` run's artifact against its own successful SHA-tag push output. Publication
   captures that push's digest, never a later SHA-tag lookup. Artifacts are scoped to the workflow
   run attempt; rerun Plan deployment, Publish and Deploy together. A failed-jobs-only rerun without
   matching plan and publication artifacts must refuse deployment. Verify skipped services retain
   their image identities and an empty plan makes no intent or execution requests.
6. Set `DEPLOY_ATTEMPTS_ENABLED=true` only after those checks. Run a controlled deployment and
   verify durable intent precedes writes, queue acknowledgment precedes observed landing, and
   restart resumes from the persisted baseline. Verify rollback changes only the selected service
   and the next main deployment supersedes it. Exercise callback loss, overlapping runs, late
   landing, a same-tag rebuild with a different digest and unchanged-ID redeployment. Keep health
   and configuration readback as separate checks.

Affected-service planning requires the running deploy image to serve the baselines contract in
`packages/shared/src/contracts/deployment-baselines.ts` and the restricted ingress to allow its
exact GET path. Until both are installed, an unavailable baseline read selects all services,
so the first merge can bootstrap the endpoint through the existing coordinated rollout. Baseline
access through the production ingress and affected-service retention have not been exercised by
the local implementation checks. Add the narrow GET allowance and verify them from a GitHub-hosted
runner before relying on selective deployment; do not broaden access to other internal reads.

The reporting origin is `https://deploy-ci.unimatrix-01.dev`, protected by Service Auth for the
existing GitHub Actions identity. On unimatrix-03, `unimatrix-runtime-evidence.timer` runs the
reviewed collector serially and writes the deploy volume's snapshot. The
[hosted-runner preflight](https://github.com/unimatrixcore/unimatrix-01/actions/runs/41273625134)
confirmed Access denial, service authentication, rejected invalid inputs, denied unrelated routes,
stable intent IDs and conflicting-digest rejection. Its intent-only record was closed with a
simulated tag-write rejection; no deployment was queued.

The [coordinated rollout](https://github.com/unimatrixcore/unimatrix-01/actions/runs/41275979600)
and [live already-current check](https://github.com/unimatrixcore/unimatrix-01/actions/runs/41278200680)
completed, with separate runtime readback verifying image landing and healthy containers.
Revalidate manual recreation and browser reconnection after runtime or recreation-policy changes.
Keep acknowledgment, replacement evidence and lost-response recovery as separate checks.
Production rollback/supersession trials remain unverified; complete those controlled trials before
relying on those behaviors.
Disabling activation later stops subsequent CI execution; it does not remove recorded attempts or
cancel queued work.
