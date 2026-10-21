# Unimatrix-TV verification and follow-up

## Verification

The package tests cover initial-document loading, native navigation and recycled cards,
account-scoped favorite writes, card-menu focus and dismissal, synopsis dialogs, season
selection, available-episode filtering, request diagnostics, and bounded download recovery.
Server tests exercise asset delivery and authentication boundaries. Deployment tests cover
compatibility checks and rollback. Run the root verification command with the ASP.NET
runtime configured through `UTV_DOTNET_RUNTIME` when it is unavailable on the host.

Earlier live checks covered Jellyfin and Requests at desktop, 1080×1920 and 390×844,
including request audio/profile selection, search/history, private-library permissions,
series navigation and hover geometry. These checks do not verify the latest episode-card
layout, card menus or synopsis integration. Final browser verification of those changes
is pending because the in-app browser was unavailable during branch closeout.

## Runtime constraints

- The presentation layer depends on the installed Jellyfin web DOM. Pinned upstream CSS
  and compatibility-checked Seerr document assets do not establish compatibility with
  future server versions.
- The full-screen loading gate runs once per document. Later navigation must preserve
  native playback, account changes and available-media filtering.
- Requests diagnostics retain native authentication, request ownership and manager/season
  scoping. Synthetic DOM tests cannot establish React search/history behavior after an
  upstream Seerr upgrade.
- Recovery is bounded by per-title/episode retry budgets and persisted cooldowns. A live
  stalled-torrent replacement was not exercised during closeout; fake Arr/qBittorrent
  cases cover failure and recovery without deleting a production download.
- The active media/download root is the 4 TB HDD, bind-mounted at `/srv/streaming/data`.
  Container mounts, original file sizes and consolidated library imports were verified
  during migration. The original SSD directory is retained for rollback.
- Footage remains a private library. Its navigation entry is excluded by the adapter;
  home-shelf exclusions and library permissions are server configuration, not a browser
  authorization boundary.

## Remaining checks

- [ ] Live-test the final card menu, synopsis dialog and episode-card layout on desktop,
      portrait and mobile, including keyboard focus, edge placement and browser history.
- [ ] Complete the broader Apple TV interaction comparison. The current implementation
      covers observed card-menu, synopsis and season-rail patterns; it is not a verified
      component-for-component clone.
- [ ] Confirm sustained Westworld caption sync after seeks and resume at zero offset.
      S02E10 source captions aligned with audio at early/middle/late checkpoints; the
      external SRT preserves those timings. Native subtitle delivery returned valid
      cues, and playback selected the external track. Progressive client playback drift
      remains unconfirmed, so no blanket offset or framerate retiming is justified.
- [ ] Review completion of the separate, bounded Westworld audio/subtitle audit before
      reporting the remaining episodes corrected. Subtitle files and protected reports
      live on the media server and are not part of this source change.
- [ ] Finish the remaining disk-usage inventory.
