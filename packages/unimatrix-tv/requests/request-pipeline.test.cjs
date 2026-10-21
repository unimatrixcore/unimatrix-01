const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  derive,
  transfer,
  authorize,
  clean,
  rejectionCategory,
  telemetry,
} = require("./request-pipeline.cjs");
const now = new Date("2026-10-13T00:00:00Z");
const request = { id: 3, type: "movie", status: 2, is4k: false, media: { status: 3 }, seasons: [] };
const item = {
  id: 3,
  hasFile: false,
  monitored: true,
  isAvailable: true,
  lastSearchTime: "2026-10-12T23:21:30Z",
};
const queue = [
  {
    movieId: 3,
    status: "downloading",
    trackedDownloadState: "downloading",
    downloadId: "ABCD",
    size: 1000,
    sizeleft: 700,
    quality: { quality: { name: "WEB-1080p" } },
    indexer: "Test",
    statusMessages: [],
  },
];
const torrent = {
  hash: "abcd",
  state: "downloading",
  size: 1000,
  progress: 0.4,
  dlspeed: 500,
  eta: 10,
  num_seeds: 4,
  num_leechs: 2,
};
const state = (extra = {}) => derive({ request, item, ...extra }, now);
for (const [name, extra, phase] of [
  ["approval", { request: { ...request, status: 1 } }, "approval"],
  ["declined", { request: { ...request, status: 3 } }, "declined"],
  ["send failed", { request: { ...request, status: 4 } }, "request_failed"],
  ["ready", { request: { ...request, media: { status: 5 } } }, "available"],
  ["removed", { request: { ...request, media: { status: 7 } } }, "removed"],
  ["missing manager", { item: null }, "not_connected"],
  ["imported", { item: { ...item, hasFile: true } }, "library_sync"],
  [
    "searching",
    { commands: [{ name: "MoviesSearch", status: "started", body: { movieIds: [3] } }] },
    "searching",
  ],
  [
    "search queued",
    { commands: [{ name: "MoviesSearch", status: "queued", body: { movieIds: [3] } }] },
    "searching",
  ],
  [
    "other movie search",
    { commands: [{ name: "MoviesSearch", status: "started", body: { movieIds: [9] } }] },
    "waiting",
  ],
  ["unmonitored", { item: { ...item, monitored: false } }, "unmonitored"],
  [
    "unreleased",
    { item: { ...item, isAvailable: false, digitalRelease: "2026-11-17" } },
    "release_wait",
  ],
  [
    "download failed",
    { history: [{ eventType: "downloadFailed", date: "2026-10-12" }] },
    "download_failed",
  ],
  ["untracked", { history: [{ eventType: "grabbed", date: "2026-10-12" }] }, "untracked"],
  ["waiting", {}, "waiting"],
  ["actual download", { queue, torrents: [torrent] }, "downloading"],
  ["paused", { queue, torrents: [{ ...torrent, state: "stoppedDL" }] }, "paused"],
  ["stalled", { queue, torrents: [{ ...torrent, state: "stalledDL" }] }, "stalled"],
  ["queued", { queue, torrents: [{ ...torrent, state: "queuedDL" }] }, "queued"],
  ["metadata", { queue, torrents: [{ ...torrent, state: "metaDL" }] }, "metadata"],
  ["checking", { queue, torrents: [{ ...torrent, state: "checkingDL" }] }, "preparing"],
  ["disk error", { queue, torrents: [{ ...torrent, state: "missingFiles" }] }, "download_error"],
  ["complete", { queue, torrents: [{ ...torrent, progress: 1 }] }, "importing"],
  [
    "import blocked",
    {
      queue: [
        {
          ...queue[0],
          trackedDownloadState: "importPending",
          statusMessages: [{ title: "Unable to import", messages: ["No eligible video file"] }],
        },
      ],
    },
    "import_blocked",
  ],
  ["queue fallback", { queue, clientUnavailable: true }, "downloading"],
  ["ignore other movie", { queue: [{ ...queue[0], movieId: 9 }] }, "waiting"],
  [
    "TV future",
    {
      request: { ...request, type: "tv", seasons: [{ seasonNumber: 1 }] },
      episodes: [{ seasonNumber: 1, airDateUtc: "2027-01-01", hasFile: false }],
    },
    "airing_wait",
  ],
  [
    "TV requested scope imported",
    {
      request: { ...request, type: "tv", seasons: [{ seasonNumber: 2 }] },
      episodes: [
        { seasonNumber: 1, airDateUtc: "2026-01-01", hasFile: false },
        { seasonNumber: 2, airDateUtc: "2026-01-01", hasFile: true },
      ],
    },
    "library_sync",
  ],
  [
    "TV ignores other season queue",
    {
      request: { ...request, type: "tv", seasons: [{ seasonNumber: 2 }] },
      queue: [{ ...queue[0], seriesId: 3, episode: { seasonNumber: 1 } }],
    },
    "waiting",
  ],
])
  test(name, () => assert.equal(state(extra).phase, phase));
test("qBit is fresher than manager progress", () => {
  const p = state({ queue, torrents: [torrent] });
  assert.equal(p.transfers[0].percent, 40);
  assert.equal(p.transfers[0].speedBytes, 500);
  assert.equal(p.transfers[0].downloadedBytes, 400);
});
test("unreachable client retains manager progress and marks degraded telemetry", () => {
  const p = state({ queue, clientUnavailable: true });
  assert.equal(p.transfers[0].percent, 30);
  assert.equal(p.transfers[0].speedBytes, null);
  assert.equal(p.clientUnavailable, true);
});
test("invalid ETA is unknown", () =>
  assert.equal(transfer(queue[0], { ...torrent, eta: 8640000 }).etaSeconds, null));
test("no fake zero percent without size", () => assert.equal(transfer({}).percent, null));
test("4K availability uses own state", () =>
  assert.equal(
    state({ request: { ...request, is4k: true, media: { status: 5, status4k: 3 } } }).phase,
    "waiting",
  ));
test("owner allowed, other ordinary user forbidden, viewer allowed", () => {
  const r = { requestedBy: { id: 2 } };
  const ordinary = (id) => ({ id, hasPermission: () => false });
  assert.equal(authorize(r, ordinary(2), {}), true);
  assert.equal(authorize(r, ordinary(4), {}), false);
  assert.equal(authorize(r, { id: 4, hasPermission: () => true }, {}), true);
});
test("scrub secrets and private paths", () =>
  assert.equal(
    clean("apiKey=secret /data/media/private.mp4 https://example.com/?token=x"),
    "[redacted] [library path] [link]",
  ));
test("mixed downloading and stalled does not claim whole series stopped", () =>
  assert.equal(
    state({
      queue: [queue[0], { ...queue[0], downloadId: "second" }],
      torrents: [torrent, { ...torrent, hash: "second", state: "stalledDL" }],
    }).phase,
    "downloading",
  ));
test("manager paused state", () =>
  assert.equal(state({ queue: [{ ...queue[0], status: "paused" }] }).phase, "paused"));
test("manager download client unreachable", () =>
  assert.equal(
    state({ queue: [{ ...queue[0], status: "downloadClientUnavailable" }] }).phase,
    "client_unavailable",
  ));
test("manager failed state", () =>
  assert.equal(state({ queue: [{ ...queue[0], status: "failed" }] }).phase, "download_error"));
test("manager stall warning", () =>
  assert.equal(
    state({
      queue: [
        {
          ...queue[0],
          status: "warning",
          statusMessages: [{ messages: ["Download stalled with no connections"] }],
        },
      ],
    }).phase,
    "stalled",
  ));
test("human rejection categories", () =>
  assert.equal(
    rejectionCategory("Release in queue is of equal or higher preference: WEBRip-1080p"),
    "A preferred release is already downloading",
  ));
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
for (const [name, payload, expected] of [
  [
    "collector only returns the request hash",
    {
      available: true,
      checkedAt: now.toISOString(),
      torrents: [torrent, { ...torrent, hash: "private-other" }],
    },
    1,
  ],
  [
    "collector failure falls back to manager",
    { available: false, checkedAt: now.toISOString(), torrents: [torrent] },
    0,
  ],
  [
    "stale collector data is unknown",
    { available: true, checkedAt: "2026-10-12T23:00:00Z", torrents: [torrent] },
    0,
  ],
  [
    "invalid collector timestamp is unknown",
    { available: true, checkedAt: "invalid", torrents: [torrent] },
    0,
  ],
])
  test(name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utv-telemetry-")),
      file = path.join(dir, "status.json");
    try {
      fs.writeFileSync(file, JSON.stringify(payload));
      const result = telemetry([{ ...queue[0], protocol: "torrent" }], file, now.valueOf());
      assert.equal(result.torrents.length, expected);
      assert.equal(result.clientUnavailable, expected === 0);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
const { recoveryFor, enrich, middleware } = require("./request-pipeline.cjs");
const seconds = now.valueOf() / 1000;
const primary = {
  kind: "radarr",
  setting: { id: 0, hostname: "radarr", port: 7878, isDefault: true, is4k: false },
};
const scopedRequest = {
  ...request,
  serverId: 0,
  media: { status: 3, externalServiceId: 3, serviceId: 0 },
};
const pending = {
  phase: "removed",
  reason: "No download progress for 45 minutes",
  at: seconds - 60,
  lastSearch: seconds - 30,
  searchAttempts: 1,
};
const recoveryState = {
  phase: "removed",
  reason: pending.reason,
  attempts: 1,
  at: now.toISOString(),
  lastSearchAt: now.toISOString(),
};
function readRecovery(payload, r = scopedRequest, c = primary) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utv-recovery-")),
    file = path.join(dir, "recovery.json");
  try {
    fs.writeFileSync(file, JSON.stringify(payload));
    return recoveryFor(r, c, file, now.valueOf());
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}
const snapshot = (value = pending) => ({
  generatedAt: seconds,
  pending: { "radarr:3": value },
  events: [],
});
test("fresh owned recovery maps only native external ID", () => {
  assert.equal(readRecovery(snapshot()).phase, "removed");
  assert.equal(
    readRecovery(snapshot(), { ...scopedRequest, media: { externalServiceId: 4 } }),
    null,
  );
});
for (const [label, data] of [
  ["stale snapshot", { ...snapshot(), generatedAt: seconds - 301 }],
  ["future snapshot", { ...snapshot(), generatedAt: seconds + 6 }],
  ["invalid timestamp", { ...snapshot(), generatedAt: "now" }],
  ["missing pending", { generatedAt: seconds }],
  ["array pending", { generatedAt: seconds, pending: [] }],
  ["null entry", snapshot(null)],
  ["array entry", snapshot([])],
  ["unknown phase", snapshot({ ...pending, phase: "downloading" })],
  ["object reason", snapshot({ ...pending, reason: { message: "oops" } })],
  ["empty reason", snapshot({ ...pending, reason: " " })],
  ["invalid entry timestamp", snapshot({ ...pending, at: "yesterday" })],
  ["future entry timestamp", snapshot({ ...pending, at: seconds + 6 })],
  ["negative attempts", snapshot({ ...pending, searchAttempts: -1 })],
  ["string attempts", snapshot({ ...pending, searchAttempts: "1" })],
  ["null attempts", snapshot({ ...pending, searchAttempts: null })],
  ["fraction attempts", snapshot({ ...pending, searchAttempts: 1.5 })],
  ["unbounded attempts", snapshot({ ...pending, searchAttempts: 1000000 })],
  ["invalid search timestamp", snapshot({ ...pending, lastSearch: "bad" })],
  [
    "events cannot fabricate recovery",
    {
      generatedAt: seconds,
      pending: {},
      events: [{ key: "radarr:3", kind: "replaced", at: seconds }],
    },
  ],
])
  test("recovery fails closed: " + label, () => assert.equal(readRecovery(data), null));
for (const [label, r, c] of [
  ["4K request", { ...scopedRequest, is4k: true }, primary],
  ["4K manager", scopedRequest, { ...primary, setting: { ...primary.setting, is4k: true } }],
  ["wrong manager", scopedRequest, { ...primary, kind: "sonarr" }],
  ["alternate instance", scopedRequest, { ...primary, setting: { ...primary.setting, id: 1 } }],
  [
    "alternate host",
    scopedRequest,
    { ...primary, setting: { ...primary.setting, hostname: "other-radarr" } },
  ],
  [
    "nondefault instance",
    scopedRequest,
    { ...primary, setting: { ...primary.setting, isDefault: false } },
  ],
  ["string external ID", { ...scopedRequest, media: { externalServiceId: "3" } }, primary],
])
  test("recovery scope excludes " + label, () =>
    assert.equal(readRecovery(snapshot(), r, c), null),
  );
test("recovery strips secrets/paths and never exports event data", () => {
  const r = readRecovery(
    snapshot({
      ...pending,
      reason: "password=secret /data/media/private.mkv https://example.com/?token=x",
    }),
  );
  assert.equal(r.reason, "[redacted] [library path] [link]");
  assert.deepEqual(Object.keys(r).sort(), ["at", "attempts", "lastSearchAt", "phase", "reason"]);
});
const tvRequest = { ...scopedRequest, type: "tv", seasons: [{ seasonNumber: 2 }] },
  sonarr = {
    kind: "sonarr",
    setting: { id: 0, hostname: "sonarr", port: 8989, isDefault: true, is4k: false },
  };
test("TV recovery requires requested season intersection", () => {
  const data = {
    generatedAt: seconds,
    pending: { "sonarr:3": { ...pending, seasonNumbers: [2] } },
  };
  assert.equal(readRecovery(data, tvRequest, sonarr).phase, "removed");
  for (const scope of [undefined, [], [1], ["2"], [-1]])
    assert.equal(
      readRecovery(
        { generatedAt: seconds, pending: { "sonarr:3": { ...pending, seasonNumbers: scope } } },
        tvRequest,
        sonarr,
      ),
      null,
    );
});
for (const [label, extra, expected] of [
  ["pending replacement", { recovery: recoveryState }, "recovering"],
  [
    "retry exhaustion",
    { recovery: { ...recoveryState, phase: "exhausted", attempts: 8 } },
    "recovery_exhausted",
  ],
  [
    "ready wins",
    { request: { ...request, media: { status: 5 } }, recovery: recoveryState },
    "available",
  ],
  ["download wins", { queue, torrents: [torrent], recovery: recoveryState }, "downloading"],
  [
    "import wins",
    { queue, torrents: [{ ...torrent, progress: 1 }], recovery: recoveryState },
    "importing",
  ],
  [
    "library scan wins",
    { item: { ...item, hasFile: true }, recovery: recoveryState },
    "library_sync",
  ],
  [
    "paused queue wins",
    { queue, torrents: [{ ...torrent, state: "stoppedDL" }], recovery: recoveryState },
    "paused",
  ],
  [
    "native search overrides exhaustion",
    {
      commands: [{ name: "MoviesSearch", status: "started", body: { movieIds: [3] } }],
      recovery: { ...recoveryState, phase: "exhausted", attempts: 8 },
    },
    "searching",
  ],
  [
    "old grabbed event does not obscure recovery",
    { history: [{ eventType: "grabbed", date: now.toISOString() }], recovery: recoveryState },
    "recovering",
  ],
  [
    "unmonitored wins",
    { item: { ...item, monitored: false }, recovery: recoveryState },
    "unmonitored",
  ],
  [
    "release wait wins",
    { item: { ...item, isAvailable: false }, recovery: recoveryState },
    "release_wait",
  ],
  [
    "4K ignores recovery",
    {
      request: { ...request, is4k: true, media: { status: 3, status4k: 3 } },
      recovery: recoveryState,
    },
    "waiting",
  ],
])
  test("recovery phase precedence: " + label, () => assert.equal(state(extra).phase, expected));
test("enrichment keeps only native authorized results", async () => {
  const allowed = { ...request, id: 22, media: { status: 5 } };
  const native = { results: [allowed], pageInfo: { results: 1 } };
  const output = await enrich(native);
  assert.deepEqual(
    output.results.map((r) => r.id),
    [22],
  );
  assert.equal(output.results[0].pipeline.phase, "available");
  assert.deepEqual(output.pageInfo, native.pageInfo);
});
test("native unauthorized response remains unchanged", () => {
  let actual,
    called = 0;
  const res = {
    statusCode: 403,
    json: (p) => {
      actual = p;
    },
    set: () => {
      throw new Error("must not enrich error");
    },
  };
  middleware({ method: "GET", path: "/request" }, res, () => called++);
  const payload = { results: [{ id: 999 }], message: "Forbidden" };
  res.json(payload);
  assert.equal(actual, payload);
  assert.equal(called, 1);
});

test("negative and fractional peer telemetry stays unknown", () => {
  const p = transfer(queue[0], { ...torrent, dlspeed: -1, num_seeds: -10, num_leechs: 1.5 });
  assert.equal(p.speedBytes, null);
  assert.equal(p.seeds, null);
  assert.equal(p.peers, null);
});
test("malformed collector records cannot match an absent queue hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "utv-telemetry-")),
    file = path.join(dir, "status.json");
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        available: true,
        checkedAt: now.toISOString(),
        torrents: [
          { state: "downloading", dlspeed: 100 },
          { hash: 1234 },
          { hash: "abcd", dlspeed: 100 },
        ],
      }),
    );
    const result = telemetry(
      [{ ...queue[0], protocol: "torrent" }, { movieId: 9 }],
      file,
      now.valueOf(),
    );
    assert.equal(result.torrents.length, 1);
    assert.equal(result.torrents[0].hash, "abcd");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
test("API key colon assignments are scrubbed", () =>
  assert.equal(clean("X-Api-Key: secret password = hidden"), "X-[redacted] [redacted]"));

test("series tracks exact EpisodeSearch commands without a seriesId", () => {
  const r = { ...request, type: "tv", seasons: [{ seasonNumber: 1 }] };
  const episodes = [
    {
      id: 11,
      seasonNumber: 1,
      episodeNumber: 2,
      airDateUtc: "2020-01-01",
      hasFile: false,
      lastSearchTime: "2026-10-12T20:00:00Z",
    },
  ];
  const result = derive(
    {
      request: r,
      item,
      episodes,
      commands: [{ name: "EpisodeSearch", status: "started", body: { episodeIds: [11] } }],
    },
    now,
  );
  assert.equal(result.phase, "searching");
  assert.deepEqual(result.episodes.missing, ["S01E02"]);
  assert.equal(result.search.state, "started");
  assert.equal(
    derive(
      {
        request: r,
        item,
        episodes,
        commands: [{ name: "EpisodeSearch", status: "started", body: { episodeIds: [99] } }],
      },
      now,
    ).phase,
    "waiting",
  );
});
test("one season pack is one transfer with all covered episode identities", () => {
  const r = { ...request, type: "tv", seasons: [{ seasonNumber: 1 }] };
  const rows = [1, 2].map((n) => ({
    ...queue[0],
    id: n,
    movieId: undefined,
    seriesId: item.id,
    episodeId: n,
    title: "Example.S01.1080p",
    episode: { seasonNumber: 1, episodeNumber: n },
  }));
  const result = derive({ request: r, item, queue: rows, torrents: [torrent] }, now);
  assert.equal(result.transfers.length, 1);
  assert.equal(result.queueCount, 1);
  assert.equal(result.transfers[0].totalBytes, 1000);
  assert.deepEqual(result.transfers[0].episodes, ["S01E01", "S01E02"]);
  assert.equal(result.transfers[0].release, "Example.S01.1080p");
});
test("series states distinguish imported, queued, missing, and future episodes", () => {
  const r = { ...request, type: "tv", seasons: [] };
  const episodes = [
    { id: 1, seasonNumber: 1, episodeNumber: 1, hasFile: true, airDateUtc: "2020-01-01" },
    { id: 2, seasonNumber: 1, episodeNumber: 2, hasFile: false, airDateUtc: "2020-01-01" },
    { id: 3, seasonNumber: 1, episodeNumber: 3, hasFile: false, airDateUtc: "2030-01-01" },
  ];
  const result = derive({ request: r, item, episodes }, now);
  assert.equal(result.episodes.available, 1);
  assert.equal(result.episodes.aired, 2);
  assert.equal(result.episodes.upcoming, 1);
  assert.deepEqual(result.episodes.missing, ["S01E02"]);
  const ready = derive(
    {
      request: { ...r, media: { status: 5 } },
      item,
      episodes: episodes.map((e) => (e.id === 2 ? { ...e, hasFile: true } : e)),
    },
    now,
  );
  assert.equal(ready.phase, "available");
});
