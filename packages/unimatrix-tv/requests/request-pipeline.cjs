"use strict";
// Read-only request telemetry. Native Seerr remains responsible for permissions and actions.
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const clean = (v) =>
  String(v || "")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/(?:api[_-]?key|password|token)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\/(?:data|srv|app|config)\/[^\s,;]+/g, "[library path]")
    .slice(0, 300);
const stamp = () => new Date().toISOString();
function transfer(q, t) {
  const total = finite(t?.size) && t.size > 0 ? t.size : finite(q.size) ? q.size : null;
  const left = finite(q.sizeleft) ? q.sizeleft : null;
  const fraction = finite(t?.progress)
    ? t.progress
    : total && left !== null
      ? (total - left) / total
      : null;
  return {
    totalBytes: total,
    downloadedBytes:
      total && fraction !== null ? Math.round(total * Math.max(0, Math.min(1, fraction))) : null,
    percent: fraction === null ? null : Math.max(0, Math.min(100, fraction * 100)),
    speedBytes: finite(t?.dlspeed) && t.dlspeed >= 0 ? t.dlspeed : null,
    etaSeconds: finite(t?.eta) && t.eta >= 0 && t.eta < 8640000 ? t.eta : null,
    etaText: t ? null : q.timeleft || null,
    seeds: Number.isSafeInteger(t?.num_seeds) && t.num_seeds >= 0 ? t.num_seeds : null,
    peers: Number.isSafeInteger(t?.num_leechs) && t.num_leechs >= 0 ? t.num_leechs : null,
    release: clean(q.title),
    state: /import/i.test(q.trackedDownloadState || "")
      ? q.trackedDownloadState
      : t?.state || q.trackedDownloadState || q.status || "unknown",
    episodeId: q.episodeId || q.episode?.id || null,
    episodeTitle: clean(q.episode?.title),
    quality: clean(q.quality?.quality?.name),
    source: clean(q.indexer),
    episode: q.episode
      ? `S${String(q.episode.seasonNumber).padStart(2, "0")} · E${q.episode.episodeNumber}`
      : null,
  };
}
function derive(input, now = new Date()) {
  const {
    request: r,
    item,
    queue = [],
    torrents = [],
    commands = [],
    history = [],
    health = [],
    episodes,
    recovery,
    clientUnavailable = false,
  } = input;
  const mediaStatus = r.media?.[r.is4k ? "status4k" : "status"];
  const base = {
    checkedAt: now.toISOString(),
    transfers: [],
    warnings: health
      .filter((h) => ["warning", "error"].includes(h.type))
      .map((h) => clean(h.message))
      .slice(0, 5),
    lastSearchAt: item?.lastSearchTime || null,
    partialAvailable: mediaStatus === 4,
  };
  const state = (phase, label, reason, stage, tone = "neutral", extra = {}) => ({
    ...base,
    phase,
    label,
    reason,
    stage,
    tone,
    ...extra,
  });
  if (r.status === 1)
    return state(
      "approval",
      "Awaiting approval",
      "Your request is waiting for approval. No download has started.",
      0,
    );
  if (r.status === 3)
    return state(
      "declined",
      "Declined",
      "This request was declined. No download will start.",
      0,
      "warning",
    );
  if (r.status === 4)
    return state(
      "request_failed",
      "Could not send request",
      "Seerr could not send this request to the download service. An administrator can retry it from Manage request.",
      0,
      "error",
    );
  if (mediaStatus === 7)
    return state(
      "removed",
      "Removed from library",
      "This title was previously available and has been removed.",
      0,
    );
  const selected = r.seasons?.map((s) => s.seasonNumber) || [];
  if (mediaStatus === 5 && r.type !== "tv")
    return state("available", "Ready to watch", "Available on Unimatrix-TV.", 4, "success");
  if (!item)
    return state(
      "not_connected",
      "Not connected to downloads",
      "The request is approved, but there is no matching entry in the download service. Open Manage request to check it.",
      1,
      "warning",
    );
  const relevantQueue = queue.filter((q) =>
    r.type === "movie"
      ? q.movieId === item.id
      : q.seriesId === item.id &&
        (!selected.length || selected.includes(q.episode?.seasonNumber ?? q.seasonNumber)),
  );
  const episodeIds = new Set(
    (episodes || [])
      .filter((e) => !selected.length || selected.includes(e.seasonNumber))
      .map((e) => e.id),
  );
  if (episodes) {
    const relevant = episodes.filter((e) => !selected.length || selected.includes(e.seasonNumber));
    const queued = new Set(relevantQueue.map((q) => q.episodeId || q.episode?.id));
    base.episodes = {
      available: relevant.filter((e) => e.hasFile).length,
      aired: relevant.filter((e) => e.airDateUtc && new Date(e.airDateUtc) <= now).length,
      upcoming: relevant.filter((e) => !e.airDateUtc || new Date(e.airDateUtc) > now).length,
      active: relevant.filter((e) => !e.hasFile && queued.has(e.id)).length,
      missing: relevant
        .filter(
          (e) => !e.hasFile && !queued.has(e.id) && e.airDateUtc && new Date(e.airDateUtc) <= now,
        )
        .map(
          (e) =>
            `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`,
        ),
      seasons: [...new Set(relevant.map((e) => e.seasonNumber))].map((n) => ({
        number: n,
        available: relevant.filter((e) => e.seasonNumber === n && e.hasFile).length,
        aired: relevant.filter(
          (e) => e.seasonNumber === n && e.airDateUtc && new Date(e.airDateUtc) <= now,
        ).length,
      })),
    };
    const searches = relevant
      .map((e) => e.lastSearchTime)
      .filter(Boolean)
      .sort();
    base.lastSearchAt = searches.at(-1) || base.lastSearchAt;
  }
  const active = commands.filter(
    (c) =>
      /Search/.test(c.name || "") &&
      ((r.type === "movie" && (c.body?.movieIds || []).includes(item.id)) ||
        (r.type === "tv" &&
          ((c.body?.seriesId === item.id &&
            (c.body?.seasonNumber == null ||
              !selected.length ||
              selected.includes(c.body.seasonNumber))) ||
            (c.body?.episodeIds || []).some((id) => episodeIds.has(id))))),
  );
  const searching = active.find((c) => ["started", "queued"].includes(c.status));
  const recentSearch = active.sort(
    (a, b) => new Date(b.started || b.queued) - new Date(a.started || a.queued),
  )[0];
  base.lastSearchAt =
    [base.lastSearchAt, item.lastSearchTime, recentSearch?.started, recentSearch?.queued]
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  base.search = searching
    ? { state: searching.status, name: searching.name, current: clean(searching.message) }
    : recentSearch
      ? { state: recentSearch.status, name: recentSearch.name }
      : null;
  if (relevantQueue.length) {
    const groups = new Map();
    for (const q of relevantQueue) {
      const key = q.downloadId
        ? q.downloadId.toLowerCase()
        : `queue:${q.id ?? q.episodeId ?? groups.size}`;
      const group = groups.get(key) || [];
      group.push(q);
      groups.set(key, group);
    }
    const transfers = [...groups.values()].map((rows) => ({
      ...transfer(
        rows[0],
        torrents.find((t) => t.hash?.toLowerCase() === rows[0].downloadId?.toLowerCase()),
      ),
      episodes: [
        ...new Set(
          rows
            .filter((q) => q.episode)
            .map(
              (q) =>
                `S${String(q.episode.seasonNumber).padStart(2, "0")}E${String(q.episode.episodeNumber).padStart(2, "0")}`,
            ),
        ),
      ],
      blockers: [
        ...new Set(
          rows
            .flatMap((q) =>
              (q.statusMessages || []).flatMap((x) =>
                x.messages?.length ? x.messages : [x.title],
              ),
            )
            .filter(Boolean)
            .map(clean),
        ),
      ],
    }));
    const messages = relevantQueue
      .flatMap((q) =>
        (q.statusMessages || []).flatMap((x) => (x.messages?.length ? x.messages : [x.title])),
      )
      .filter(Boolean)
      .map(clean);
    const qstates = relevantQueue.map((q) => q.trackedDownloadState || q.status);
    const ts = relevantQueue
      .map((q) => torrents.find((t) => t.hash?.toLowerCase() === q.downloadId?.toLowerCase()))
      .filter(Boolean);
    const common = { transfers, queueCount: transfers.length, clientUnavailable };
    if (
      messages.length &&
      relevantQueue.some(
        (q) =>
          q.trackedDownloadStatus === "error" ||
          /importPending|importBlocked/.test(q.trackedDownloadState || ""),
      )
    )
      return state("import_blocked", "Import needs attention", messages[0], 3, "error", {
        ...common,
        blockers: messages,
      });
    if (relevantQueue.some((q) => q.status === "downloadClientUnavailable"))
      return state(
        "client_unavailable",
        "Download client unavailable",
        "The download service cannot reach the download client. Progress below is the last reported value.",
        2,
        "warning",
        common,
      );
    if (relevantQueue.some((q) => q.status === "failed"))
      return state(
        "download_error",
        "Download failed",
        messages[0] ||
          "The download service reports a failed download. Open Manage request to review it.",
        2,
        "error",
        common,
      );
    if (ts.some((t) => ["error", "missingFiles"].includes(t.state)))
      return state(
        "download_error",
        "Download needs attention",
        "The download client reports a file or disk error. An administrator needs to check the download.",
        2,
        "error",
        common,
      );
    if (
      qstates.every((s) => /imported|importing|importPending|completed/i.test(s || "")) ||
      (ts.length === relevantQueue.length && ts.every((t) => t.progress >= 1))
    )
      return state(
        "importing",
        "Importing into library",
        "Download complete. The files are being checked and added to Unimatrix-TV.",
        3,
        "active",
        common,
      );
    if (
      relevantQueue.every((q) => q.status === "paused") ||
      (ts.length === relevantQueue.length &&
        ts.every((t) => ["pausedDL", "stoppedDL"].includes(t.state)))
    )
      return state(
        "paused",
        "Download paused",
        "The download is paused in the download client. It needs to be resumed there.",
        2,
        "warning",
        common,
      );
    if (
      ts.some(
        (t) => ["downloading", "forcedDL"].includes(t.state) && t.progress < 1 && t.dlspeed > 0,
      )
    )
      return state(
        "downloading",
        "Downloading",
        "Receiving episode files; individual transfer states are shown below.",
        2,
        "active",
        common,
      );
    if (
      ts.some((t) => ["checkingDL", "checkingResumeData", "allocating", "moving"].includes(t.state))
    )
      return state(
        "preparing",
        "Preparing download",
        "The download client is checking or preparing files before continuing.",
        2,
        "active",
        common,
      );
    if (ts.some((t) => t.state === "metaDL" || t.state === "forcedMetaDL"))
      return state(
        "metadata",
        "Connecting to peers",
        "The torrent has been added. The client is waiting for peers to provide its file list.",
        2,
        "active",
        common,
      );
    if (relevantQueue.every((q) => q.status === "delay"))
      return state(
        "queued",
        "Waiting for download delay",
        "A release was found. The download service is waiting for the configured delay before choosing a release.",
        2,
        "neutral",
        common,
      );
    if (
      (ts.length === relevantQueue.length && ts.every((t) => t.state === "queuedDL")) ||
      relevantQueue.every((q) => q.status === "queued")
    )
      return state(
        "queued",
        "Queued for download",
        "A release was found. It is waiting for a free download slot.",
        2,
        "neutral",
        common,
      );
    if (
      (ts.length === relevantQueue.length && ts.every((t) => t.state === "stalledDL")) ||
      messages.some((m) => /stalled|no connections|no peers/i.test(m))
    )
      return state(
        "stalled",
        "Waiting for peers",
        "The download is not receiving data right now. It will continue when a peer can supply the missing pieces.",
        2,
        "warning",
        common,
      );
    if (relevantQueue.some((q) => q.status === "warning") && messages.length)
      return state("download_warning", "Download needs attention", messages[0], 2, "warning", {
        ...common,
        blockers: messages,
      });
    return state(
      "downloading",
      "Downloading",
      "A release was found and is downloading. It will be imported when complete.",
      2,
      "active",
      common,
    );
  }
  if (
    r.type === "tv" &&
    base.episodes?.aired > 0 &&
    base.episodes.available >= base.episodes.aired &&
    mediaStatus === 5
  )
    return state("available", "Ready to watch", "All aired episodes are available.", 4, "success");
  if (
    (r.type === "movie" && item.hasFile) ||
    (base.episodes?.aired > 0 && base.episodes.available >= base.episodes.aired)
  )
    return state(
      "library_sync",
      "Updating library",
      "The files are imported. Seerr is waiting for the library scan to confirm availability.",
      3,
      "active",
    );
  if (searching) {
    if (recovery && recovery.phase !== "exhausted" && r.is4k === false)
      return state("recovering", "Finding a new source", recovery.reason, 1, "active", {
        recovery,
      });
    return state(
      "searching",
      searching.status === "queued" ? "Search queued" : "Searching indexers",
      "The download service is checking indexers for a release that meets the quality profile.",
      1,
      "active",
    );
  }
  if (item.monitored === false)
    return state(
      "unmonitored",
      "Automatic downloads paused",
      "This title is not monitored in the download service. New releases will not be downloaded automatically.",
      1,
      "warning",
    );
  if (r.type === "movie" && item.isAvailable === false)
    return state(
      "release_wait",
      "Waiting for digital release",
      item.digitalRelease
        ? `The download service lists a digital release date of ${item.digitalRelease.slice(0, 10)}. No download has started.`
        : "The download service does not consider this title released yet. No download has started.",
      1,
    );
  if (base.episodes?.aired === 0 && base.episodes.upcoming > 0)
    return state(
      "airing_wait",
      "Waiting for episodes to air",
      "The requested episodes have not aired yet. New episodes will be checked after they air.",
      1,
    );
  if (recovery && recovery.phase !== "exhausted" && r.is4k === false)
    return state("recovering", "Finding a new source", recovery.reason, 1, "active", { recovery });
  if (recovery?.phase === "exhausted" && r.is4k === false)
    return state(
      "recovery_exhausted",
      "Retry limit reached",
      `Automatic source retries stopped after ${recovery.attempts} searches. ${recovery.reason}`,
      1,
      "warning",
      { recovery },
    );
  const newest = history.sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  if (newest?.eventType === "downloadFailed")
    return state(
      "download_failed",
      "Previous download failed",
      "The previous download failed. The title is still monitored for another matching release.",
      1,
      "warning",
    );
  if (newest?.eventType === "grabbed")
    return state(
      "untracked",
      "Download no longer tracked",
      "A release was sent to the download client, but it is no longer in the active queue. Check Manage request before assuming it completed.",
      1,
      "warning",
    );
  if (recentSearch?.status === "failed")
    return state(
      "search_failed",
      "Search failed",
      "The latest search failed in the download service. Check the service warnings and try Check sources.",
      1,
      "error",
    );
  return state(
    "waiting",
    "Waiting for a matching release",
    base.partialAvailable
      ? "Some episodes are available. The remaining requested episodes have no active download. Check sources to see what is currently available."
      : base.lastSearchAt
        ? "The last search has finished, but no download is active. Check sources to see whether releases are missing or rejected by the quality profile."
        : "No download or active search is reported yet. The title is monitored for new releases; Check sources can inspect the indexers now.",
    1,
  );
}
const memo = new Map();
async function cached(key, ttl, fn) {
  const old = memo.get(key);
  if (old && old.until > Date.now()) return old.promise;
  const entry = { until: Date.now() + ttl, promise: Promise.resolve().then(fn) };
  memo.set(key, entry);
  entry.promise.catch(() => {
    if (memo.get(key) === entry) memo.delete(key);
  });
  if (memo.size > 500) for (const [k, v] of memo) if (v.until < Date.now()) memo.delete(k);
  return entry.promise;
}
function dependencies() {
  return {
    axios: require("axios").default,
    getSettings: require("./lib/settings").getSettings,
    getRepository: require("./datasource").getRepository,
    MediaRequest: require("./entity/MediaRequest").MediaRequest,
    Permission: require("./lib/permissions").Permission,
  };
}
function clientFor(r) {
  const { axios, getSettings } = dependencies(),
    kind = r.type === "movie" ? "radarr" : "sonarr";
  const id = r.serverId ?? r.media?.[r.is4k ? "serviceId4k" : "serviceId"];
  const setting = getSettings()[kind].find((s) => s.id === id);
  if (!setting) throw new Error("Service not configured");
  const url = `${setting.useSsl ? "https" : "http"}://${setting.hostname}:${setting.port}${setting.baseUrl || ""}/api/v3`;
  return {
    kind,
    setting,
    key: `${kind}:${id}`,
    get: async (path, params) =>
      (
        await axios.get(url + path, {
          headers: { "X-Api-Key": setting.apiKey },
          params,
          timeout: 6000,
        })
      ).data,
  };
}
function telemetry(queue, file = "/run/unimatrix-telemetry/status.json", now = Date.now()) {
  if (!queue.some((q) => q.protocol === "torrent" && q.downloadId))
    return { torrents: [], clientUnavailable: false };
  try {
    const fs = require("node:fs");
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 2097152) throw new Error("Invalid telemetry");
    const data = JSON.parse(raw);
    if (
      typeof data.checkedAt !== "string" ||
      !Array.isArray(data.torrents) ||
      data.torrents.length > 1000
    )
      throw new Error("Invalid telemetry");
    const age = now - new Date(data.checkedAt);
    if (data.available !== true || !Number.isFinite(age) || age > 45000 || age < -5000)
      throw new Error("Stale telemetry");
    const hashes = new Set(
      queue
        .filter((q) => typeof q.downloadId === "string" && q.downloadId.length > 0)
        .map((q) => q.downloadId.toLowerCase()),
    );
    return {
      torrents: data.torrents.filter(
        (t) =>
          t && typeof t.hash === "string" && t.hash.length > 0 && hashes.has(t.hash.toLowerCase()),
      ),
      clientUnavailable: false,
    };
  } catch {
    return { torrents: [], clientUnavailable: true };
  }
}
// Recovery is local, sanitized telemetry; it never discovers or authorizes requests.
function recoveryFor(r, c, file = "/run/unimatrix-telemetry/recovery.json", now = Date.now()) {
  const kind = r.type === "movie" ? "radarr" : r.type === "tv" ? "sonarr" : null,
    setting = c?.setting,
    id = r.media?.externalServiceId;
  if (
    !kind ||
    r.is4k !== false ||
    c?.kind !== kind ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    setting?.id !== 0 ||
    setting?.hostname !== kind ||
    setting?.port !== (kind === "radarr" ? 7878 : 8989) ||
    setting?.is4k !== false ||
    setting?.isDefault !== true
  )
    return null;
  try {
    const fs = require("node:fs");
    const raw = fs.readFileSync(file, "utf8");
    if (raw.length > 131072) return null;
    const data = JSON.parse(raw),
      seconds = now / 1000;
    if (
      !finite(data?.generatedAt) ||
      !finite(seconds) ||
      seconds - data.generatedAt > 300 ||
      seconds - data.generatedAt < -5 ||
      !data.pending ||
      typeof data.pending !== "object" ||
      Array.isArray(data.pending)
    )
      return null;
    const key = kind + ":" + id;
    if (!Object.prototype.hasOwnProperty.call(data.pending, key)) return null;
    const value = data.pending[key];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !["removed", "removing", "exhausted"].includes(value.phase) ||
      typeof value.reason !== "string" ||
      !value.reason.trim() ||
      value.reason.length > 2000 ||
      !finite(value.at) ||
      value.at < 0 ||
      value.at > data.generatedAt + 5
    )
      return null;
    const attempts = value.searchAttempts === undefined ? 0 : value.searchAttempts,
      lastSearch = value.lastSearch ?? null;
    if (
      !Number.isSafeInteger(attempts) ||
      attempts < 0 ||
      attempts > 100 ||
      (value.phase === "exhausted" && attempts < 1) ||
      (lastSearch !== null &&
        (!finite(lastSearch) || lastSearch < 0 || lastSearch > data.generatedAt + 5))
    )
      return null;
    if (kind === "sonarr") {
      const scope = value.seasonNumbers,
        selected = r.seasons?.map((s) => s.seasonNumber);
      if (
        !Array.isArray(scope) ||
        !scope.length ||
        scope.length > 100 ||
        scope.some((n) => !Number.isSafeInteger(n) || n < 0) ||
        !Array.isArray(selected) ||
        !selected.length ||
        selected.some((n) => !Number.isSafeInteger(n) || n < 0) ||
        !selected.some((n) => scope.includes(n))
      )
        return null;
    }
    return {
      phase: value.phase,
      reason: clean(value.reason),
      attempts,
      at: new Date(value.at * 1000).toISOString(),
      lastSearchAt: lastSearch === null ? null : new Date(lastSearch * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}
async function queueFor(c) {
  const [queue, commands, health] = await Promise.all([
    c.get("/queue", { pageSize: 1000, includeEpisode: true, includeUnknownMovieItems: true }),
    c.get("/command").catch(() => []),
    c.get("/health").catch(() => []),
  ]);
  return { queue: queue.records || [], commands, health };
}
async function pipeline(r) {
  if (
    [1, 3, 4].includes(r.status) ||
    r.media?.[r.is4k ? "status4k" : "status"] === 7 ||
    (r.type !== "tv" && r.media?.[r.is4k ? "status4k" : "status"] === 5)
  )
    return derive({ request: r });
  try {
    const c = clientFor(r),
      id = r.media?.[r.is4k ? "externalServiceId4k" : "externalServiceId"];
    if (!id) return derive({ request: r });
    const [item, context] = await Promise.all([
      cached(`${c.key}:item:${id}`, 8000, () =>
        c.get("/" + (r.type === "movie" ? "movie" : "series") + "/" + id).catch((e) => {
          if (e.response?.status === 404) return null;
          throw e;
        }),
      ),
      cached(c.key + ":context", 8000, () => queueFor(c)),
    ]);
    const selected = r.seasons?.map((s) => s.seasonNumber) || [];
    const queue = context.queue.filter((q) =>
      r.type === "movie"
        ? q.movieId === id
        : q.seriesId === id &&
          (!selected.length || selected.includes(q.episode?.seasonNumber ?? q.seasonNumber)),
    );
    const { torrents, clientUnavailable } = telemetry(queue);
    const episodes =
      r.type === "tv"
        ? await cached(`${c.key}:episodes:${id}`, 15000, () =>
            c.get("/episode", { seriesId: id }),
          ).catch(() => undefined)
        : undefined;
    const history = !queue.length
      ? await cached(`${c.key}:history:${id}`, 15000, () =>
          c.get("/history/" + (r.type === "movie" ? "movie" : "series"), {
            [r.type === "movie" ? "movieId" : "seriesId"]: id,
          }),
        ).catch(() => [])
      : [];
    return derive({
      request: r,
      item,
      ...context,
      queue,
      torrents,
      episodes,
      history: Array.isArray(history) ? history : history.records || [],
      clientUnavailable,
      recovery: recoveryFor(r, c),
    });
  } catch {
    return {
      phase: "unknown",
      label: "Status unavailable",
      reason:
        "The download service could not be reached. Your request is saved; its download status is unknown. Refresh to try again.",
      stage: null,
      tone: "warning",
      checkedAt: stamp(),
      transfers: [],
      warnings: [],
    };
  }
}
async function enrich(payload) {
  const results = payload.results || [],
    output = [];
  for (let i = 0; i < results.length; i += 4)
    output.push(
      ...(await Promise.all(
        results.slice(i, i + 4).map(async (r) => ({ ...r, pipeline: await pipeline(r) })),
      )),
    );
  return { ...payload, results: output };
}
function middleware(req, res, next) {
  if (req.method !== "GET" || req.path.replace(/\/$/, "") !== "/request") return next();
  const original = res.json;
  res.json = function (payload) {
    if (res.statusCode !== 200 || !Array.isArray(payload?.results))
      return original.call(this, payload);
    res.set("Cache-Control", "private, no-store");
    enrich(payload)
      .then((data) => {
        if (!res.writableEnded && !res.headersSent) original.call(res, data);
      })
      .catch(() => {
        if (!res.writableEnded && !res.headersSent) original.call(res, payload);
      });
    return this;
  };
  next();
}
const rate = new Map();
function rejectionCategory(reason) {
  if (/release in queue/i.test(reason)) return "A preferred release is already downloading";
  if (/not wanted in profile|quality.*(?:not|reject)/i.test(reason))
    return "Does not match the requested quality";
  if (/language/i.test(reason)) return "Does not match the requested language";
  if (/custom format|release group/i.test(reason)) return "Excluded encode or release group";
  if (/size|too (?:large|small)/i.test(reason)) return "Outside the allowed file size";
  if (/seed/i.test(reason)) return "Not enough seeds";
  if (/already.*(?:import|download|exist)/i.test(reason)) return "Already in the library";
  return clean(reason);
}
function authorize(r, user, Permission) {
  return (
    !!user &&
    (r.requestedBy?.id === user.id ||
      user.hasPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], { type: "or" }))
  );
}
async function diagnostics(req, res) {
  res.set("Cache-Control", "private, no-store");
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1)
    return res.status(400).json({ message: "Invalid request." });
  const { getRepository, MediaRequest, Permission } = dependencies();
  const r = await getRepository(MediaRequest).findOne({
    where: { id },
    relations: { requestedBy: true, seasons: true, media: true },
  });
  if (!r) return res.status(404).json({ message: "Request not found." });
  if (!authorize(r, req.user, Permission))
    return res.status(403).json({ message: "You cannot view this request." });
  const publish = async (data) =>
    res.json({ ...data, recovery: (await pipeline(r)).recovery || null });
  const key = `diagnostic:${id}`,
    previous = memo.get(key);
  if (previous && previous.until > Date.now()) return publish(await previous.promise);
  const now = Date.now(),
    userKey = req.user.id,
    budget = (rate.get(userKey) || []).filter((t) => now - t < 60000);
  if (budget.length >= 3)
    return res.status(429).json({ message: "Please wait a minute before checking more sources." });
  rate.set(userKey, [...budget, now]);
  try {
    const data = await cached(key, 300000, async () => {
      const c = clientFor(r),
        external = r.media?.[r.is4k ? "externalServiceId4k" : "externalServiceId"];
      if (!external) throw new Error("Request not connected");
      const params =
        r.type === "movie"
          ? { movieId: external }
          : { seriesId: external, seasonNumber: r.seasons?.[0]?.seasonNumber };
      const { axios } = dependencies();
      const url = `${c.setting.useSsl ? "https" : "http"}://${c.setting.hostname}:${c.setting.port}${c.setting.baseUrl || ""}/api/v3/release`;
      const [response, health] = await Promise.all([
        axios.get(url, { headers: { "X-Api-Key": c.setting.apiKey }, params, timeout: 22000 }),
        c.get("/health").catch(() => []),
      ]);
      const releases = response.data;
      if (!Array.isArray(releases)) throw new Error("No release response");
      const reasons = new Map();
      for (const release of releases)
        for (const reason of new Set((release.rejections || []).map(rejectionCategory)))
          reasons.set(reason, (reasons.get(reason) || 0) + 1);
      const accepted = releases.filter((x) => x.approved === true).length;
      const partial = r.type === "tv" && r.seasons.length > 1;
      return {
        checkedAt: stamp(),
        total: releases.length,
        accepted,
        rejected: releases.length - accepted,
        scope: partial ? `Season ${r.seasons[0].seasonNumber} only` : "Requested title",
        seasonNumber: r.type === "tv" ? r.seasons?.[0]?.seasonNumber : null,
        summary:
          releases.length === 0
            ? "No releases returned by the responding indexers."
            : accepted === 0
              ? "Releases were found, but none passed the current quality and language rules."
              : `${accepted} release${accepted === 1 ? "" : "s"} passed the current rules. This check does not start a download.`,
        reasons: [...reasons]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([reason, count]) => ({ reason, count })),
        warnings: health
          .filter((x) => ["warning", "error"].includes(x.type))
          .map((x) => clean(x.message))
          .slice(0, 5),
        releases: releases
          .sort((a, b) => Number(b.approved) - Number(a.approved))
          .slice(0, 10)
          .map((x) => ({
            title: clean(x.title),
            source: clean(x.indexer),
            quality: clean(x.quality?.quality?.name),
            approved: x.approved === true,
            reasons: (x.rejections || []).map(clean),
          })),
      };
    });
    await publish(data);
  } catch {
    res.status(503).json({
      message:
        "The source check could not finish. An indexer or download service may be unavailable. No download was started.",
    });
  }
}
function install(server) {
  const { checkUser, isAuthenticated } = require("./middleware/auth");
  server.get(
    "/api/v1/unimatrix/requests/:id/diagnostics",
    checkUser,
    isAuthenticated(),
    (req, res, next) => diagnostics(req, res).catch(next),
  );
}
module.exports = {
  derive,
  transfer,
  enrich,
  pipeline,
  middleware,
  install,
  authorize,
  clean,
  rejectionCategory,
  telemetry,
  recoveryFor,
};
