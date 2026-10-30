# Requests compatibility

`seerr-document.js` is a compiled Next server chunk. Its module IDs belong to the image recorded by `scripts/build-requests.mjs`; copying it into another Seerr build can break rendering. Deployment must check the generated manifest's image and document compatibility before replacing the mounted chunk. Upgrades require a document built from the target image.

The request-list middleware enriches native filtered results. Diagnostics must retain native authentication and request-owner/viewer authorization. Recovery telemetry applies only to the matching primary manager and requested TV seasons; an active download or available library file takes priority.

The Node suites exercise the shipped CommonJS policies and browser script. Search tests use a synthetic native DOM; they do not verify Seerr's React query controller. Live verification of editing a query, browser back/forward, empty results, and mobile/portrait layout after installation remains pending.
