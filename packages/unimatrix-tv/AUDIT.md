# Unimatrix-TV audit

- [x] Reproduce the deployed Jellyfin detail-page regression and Seerr search transition.
- [x] Add loading, route, playback, and card regressions; include the adapter in coverage.
- [x] Restore styles for the detail components and featured artwork hit target.
- [x] Complete server-plugin and deployment checks.
- [x] Complete Requests search and request-status checks.
- [x] Run repository verification, deploy, and verify desktop, 1080×1920, mobile, and playback.

## Findings

| Severity | Defect | Verification |
| --- | --- | --- |
| High | Detail components remained in JavaScript after their stylesheet was removed, rendering the brand image at its native 1037px width. | Reproduced on the deployed detail page; matching component styles restored. |
| High | Any cached video DOM disabled page adaptation after playback. | Regression tests exercise navigation back with a hidden cached video. |
| High | Boot code ran only after the native client, leaving first paint unprotected. | Early inline bootstrap and critical CSS added; deployed and verified live. |
| High | Deployment printed success after unsuccessful health checks and did not verify Requests. | Preflight checks, retry loops, asset checksum verification, and automated rollback verified. |
| Medium | A failed artwork decode failed the whole page; interrupted hero work could leave a cached shell permanently pending. | Adapter regressions cover missing artwork and interrupted navigation. |
| Medium | Card adaptation ended after initial load, leaving pagination and recycled cards stale. | Behavioral pagination/recycling tests added. |
| Medium | Card image container height collapsed to 0px due to relative positioning override, causing blank poster cards. | Corrected `.cardImageContainer` absolute positioning and verified live in browser. |
| Medium | The coverage report excluded the main adapter. | Adapter included in test suite and coverage reports. |
| Medium | Seerr search loses its editable query when results render. | Fixed with editable query retention across history/search updates; 108 tests passing. |

The upstream CSS remains pinned by `assets/sources.json` and is excluded from formatting. The audit does not establish that a future Jellyfin or Seerr version is compatible with these adapters.
