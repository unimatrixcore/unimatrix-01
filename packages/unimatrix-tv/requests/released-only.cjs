"use strict";
// Unimatrix-TV catalog policy. Authentication, requests, and library scans remain native.
function todayInPhoenix(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Phoenix",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (t) => p.find((x) => x.type === t).value;
  return value("year") + "-" + value("month") + "-" + value("day");
}
function past(value, today) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
  )
    return false;
  if (value.length > 10 && !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10),
    parsed = new Date(date + "T00:00:00Z");
  return (
    Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date && date <= today
  );
}
function isEligible(data, kind, region, today) {
  if (kind === "movie") {
    const countries = (data?.release_dates || data?.releases)?.results;
    if (!Array.isArray(countries)) return false;
    return countries.some(
      (c) =>
        c?.iso_3166_1 === region &&
        Array.isArray(c.release_dates) &&
        c.release_dates.some((r) => r?.type === 4 && past(r.release_date, today)),
    );
  }
  if (kind === "tv") {
    const first = data?.first_air_date || data?.firstAirDate;
    if (!past(first, today) || ["Planned", "In Production"].includes(data.status)) return false;
    const raw = data["watch/providers"]?.results;
    const providers =
      raw?.[region] ||
      (Array.isArray(data.watchProviders) ? data.watchProviders : []).find(
        (p) => p?.iso_3166_1 === region,
      );
    return ["flatrate", "buy", "rent", "free", "ads"].some(
      (k) =>
        Array.isArray(providers?.[k]) &&
        providers[k].some(
          (p) => p && Number.isSafeInteger(p.provider_id ?? p.id) && (p.provider_id ?? p.id) > 0,
        ),
    );
  }
  return true;
}
function kindOf(x) {
  if (!x || typeof x !== "object") return null;
  if (["movie", "tv", "person"].includes(x.mediaType || x.media_type))
    return x.mediaType || x.media_type;
  if ("title" in x || "originalTitle" in x || "original_title" in x) return "movie";
  if ("firstAirDate" in x || "first_air_date" in x || "numberOfEpisodes" in x) return "tv";
  return null;
}
async function filterPayload(payload, check) {
  const visit = async (value) => {
    if (Array.isArray(value)) {
      const flags = await Promise.all(
        value.map((x) => {
          const k = kindOf(x);
          return k && k !== "person" ? check(x, k) : true;
        }),
      );
      return Promise.all(value.filter((_, i) => flags[i]).map(visit));
    }
    if (!value || typeof value !== "object") return value;
    const copy = { ...value };
    for (const key of ["results", "parts", "knownFor", "known_for", "cast", "crew"])
      if (Array.isArray(copy[key])) copy[key] = await visit(copy[key]);
    return copy;
  };
  return visit(payload);
}
let installed = false;
function middleware(req, res, next) {
  if (!installed) installUpstreamPolicy();
  if (req.method !== "GET") return next();
  const path = req.path.replace(/\/$/, "");
  const list =
    /^\/(discover|search)(\/|$)/.test(path) ||
    /^\/(movie|tv)\/\d+\/(recommendations|similar)$/.test(path) ||
    /^\/(person|collection)\/\d+(\/.*)?$/.test(path);
  const detail = /^\/(movie|tv)\/\d+$/.exec(path);
  if (!list && !detail) return next();
  const original = res.json;
  res.json = function (payload) {
    if (res.statusCode !== 200 || !payload || typeof payload !== "object")
      return original.call(this, payload);
    const work = detail
      ? eligible(payload, detail[1]).then((ok) => ({ ...payload, digitalReleaseEligible: ok }))
      : filterPayload(payload, eligible);
    work
      .then((filtered) => {
        if (!res.headersSent && !res.writableEnded) original.call(res, filtered);
      })
      .catch(() => {
        if (!res.headersSent && !res.writableEnded) {
          res.status(503);
          original.call(res, { message: "Digital release metadata is temporarily unavailable." });
        }
      });
    return this;
  };
  next();
}
let client,
  settings,
  active = 0;
const waiting = [],
  cache = new Map();
async function limited(work) {
  if (active >= 8) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
async function eligible(item, kind) {
  const region = settings().main.streamingRegion || settings().main.discoverRegion || "US";
  const today = todayInPhoenix(),
    date = item.releaseDate || item.release_date || item.firstAirDate || item.first_air_date;
  if (kind === "tv" && typeof date === "string" && date.slice(0, 10) > today) return false;
  if (!Number.isInteger(item.id)) return false;
  const key = kind + ":" + item.id + ":" + region + ":" + today;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const entry = { expires: Date.now() + 3600000 };
  entry.promise = limited(async () => {
    try {
      const data = await client.get(
        "/" + kind + "/" + item.id,
        {
          params: { append_to_response: kind === "movie" ? "release_dates" : "watch/providers" },
          timeout: 4500,
        },
        3600,
      );
      return isEligible(data, kind, region, today);
    } catch {
      entry.expires = Date.now() + 60000;
      return false;
    }
  });
  cache.set(key, entry);
  if (cache.size > 10000) {
    for (const [k, v] of cache) {
      if (v.expires < Date.now()) cache.delete(k);
    }
    if (cache.size > 10000) cache.delete(cache.keys().next().value);
  }
  return entry.promise;
}
function installUpstreamPolicy() {
  const TMDB = require("./api/themoviedb").default;
  settings = require("./lib/settings").getSettings;
  const original = TMDB.prototype.get;
  if (typeof original !== "function")
    throw new Error("Seerr TMDB interface changed: release filter needs an update.");
  TMDB.prototype.get = function (endpoint, config, ...rest) {
    if (endpoint === "/discover/movie" || endpoint === "/discover/tv") {
      const today = todayInPhoenix(),
        region = settings().main.streamingRegion || settings().main.discoverRegion || "US";
      const params = { ...(config?.params || {}) };
      if (endpoint === "/discover/movie")
        Object.assign(params, {
          region,
          with_release_type: 4,
          "release_date.gte": "1900-01-01",
          "release_date.lte": today,
        });
      else
        Object.assign(params, {
          "first_air_date.lte":
            params["first_air_date.lte"] && params["first_air_date.lte"] < today
              ? params["first_air_date.lte"]
              : today,
          include_null_first_air_dates: false,
          watch_region: region,
          with_watch_monetization_types: "flatrate|buy|rent|free|ads",
        });
      config = { ...config, params };
    }
    return original.call(this, endpoint, config, ...rest);
  };
  client = new TMDB();
  installed = true;
}
module.exports = { middleware, isEligible, kindOf, filterPayload, todayInPhoenix };
