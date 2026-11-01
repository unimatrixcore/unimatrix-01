# Deployment client

Use `createDeployClient` from a Node service with a deploy-owned service token: `read` for observations,
`manage` for `redeploy`. The client validates requests and responses against `@unimatrix/shared` contracts. Keep that token and the internal
responses on the server; browser responses must apply their own authorization and disclosure policy.

HTTPS requires `caCertificatePem`, containing the deploy service's certificate. It replaces the
system trust store for the request, and hostname verification remains enabled. Plain HTTP is
available for local development; production callers must require HTTPS in their boot configuration.

Requests refuse redirects, stop after five seconds by default, and cap response bodies at 1 MiB.
Failures expose only `DeployClientError`, without upstream bodies, native error causes or tokens.
Redeploy refusals preserve only status 404 or 409. Redeploy calls never retry automatically; reuse
the same request UUID to retrieve the durable record after an uncertain response.
