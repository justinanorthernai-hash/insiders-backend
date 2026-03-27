import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { mockGames, mockOdds, sportMap, supportedSports } from "./data.js";

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  const rawEnv = fs.readFileSync(envPath, "utf8");
  for (const line of rawEnv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const PORT = Number(process.env.PORT || 4000);
const PROVIDER = process.env.SPORTS_API_PROVIDER || "espn";
const ODDS_PROVIDER = process.env.ODDS_PROVIDER || (process.env.SPORTSGAMEODDS_API_KEY ? "sportsgameodds" : "espn");
const SPORTSGAMEODDS_API_KEY = process.env.SPORTSGAMEODDS_API_KEY || "";
const GAMES_CACHE_TTL_MS = 5 * 1000;
const ODDS_CACHE_TTL_MS = 5 * 1000;
const NHL_GAMES_CACHE_TTL_MS = 5 * 1000;
const NHL_ODDS_CACHE_TTL_MS = 20 * 1000;
const gamesCache = new Map();
const oddsCache = new Map();
const sgoEventsCache = new Map();
const PACIFIC_TIMEZONE = "America/Los_Angeles";

function formatEspnDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getEspnConfig(sport) {
  return sportMap[sport] || null;
}

function getSgoLeagueId(sport) {
  const normalized = String(sport || "").toUpperCase();
  if (normalized === "NBA" || normalized === "NFL" || normalized === "NHL") {
    return normalized;
  }
  return null;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "InsidersBackend/1.0",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`Provider request failed with ${response.status}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.espn.com/",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });

  if (!response.ok) {
    throw new Error(`Provider request failed with ${response.status}`);
  }

  return response.text();
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

function getCached(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCached(cache, key, value) {
  const entry = {
    value,
    cachedAt: Date.now()
  };
  cache.set(key, entry);
  return entry;
}

function formatIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPacificTime(value) {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: PACIFIC_TIMEZONE
  });
}

function getGamesTtlMs(sport) {
  return String(sport || "").toUpperCase() === "NHL" ? NHL_GAMES_CACHE_TTL_MS : GAMES_CACHE_TTL_MS;
}

function getOddsTtlMs(sport) {
  return String(sport || "").toUpperCase() === "NHL" ? NHL_ODDS_CACHE_TTL_MS : ODDS_CACHE_TTL_MS;
}

function normalizeMockGame(game) {
  return {
    id: game.id,
    sport: game.sport,
    event: game.event,
    commenceTime: game.commenceTime,
    displayTime: formatPacificTime(game.commenceTime),
    status: game.status,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam
  };
}

function normalizeEspnGame(sport, event) {
  const competition = event.competitions?.[0];
  const home = competition?.competitors?.find((entry) => entry.homeAway === "home");
  const away = competition?.competitors?.find((entry) => entry.homeAway === "away");
  const probability = competition?.situation?.lastPlay?.probability || null;
  const statusState = competition?.status?.type?.state || event.status?.type?.state || "pre";
  const status =
    statusState === "post" ? "final" :
    statusState === "in" ? "live" :
    "scheduled";

  return {
    id: event.id,
    sport,
    event: event.name || `${away?.team?.displayName || away?.team?.name || "Away"} vs ${home?.team?.displayName || home?.team?.name || "Home"}`,
    commenceTime: event.date,
    displayTime: formatPacificTime(event.date),
    status,
    statusDetail: competition?.status?.type?.shortDetail || competition?.status?.type?.detail || "",
    homeTeam: home?.team?.displayName || home?.team?.name || "",
    awayTeam: away?.team?.displayName || away?.team?.name || "",
    homeScore: home?.score || "0",
    awayScore: away?.score || "0",
    homeWinPct:
      probability && typeof probability.homeWinPercentage === "number"
        ? Math.round(probability.homeWinPercentage * 100)
        : null,
    awayWinPct:
      probability && typeof probability.awayWinPercentage === "number"
        ? Math.round(probability.awayWinPercentage * 100)
        : null,
    homeLogo: home?.team?.logo || home?.team?.logos?.[0]?.href || "",
    awayLogo: away?.team?.logo || away?.team?.logos?.[0]?.href || ""
  };
}

function isUpcomingOrLive(game) {
  if (game.status === "live" || game.status === "scheduled") {
    return true;
  }
  return new Date(game.commenceTime).getTime() >= Date.now();
}

function toAmericanOdd(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    return (
      toAmericanOdd(value.displayValue) ||
      toAmericanOdd(value.american) ||
      toAmericanOdd(value.price) ||
      toAmericanOdd(value.value) ||
      toAmericanOdd(value.current) ||
      null
    );
  }
  if (typeof value === "number") {
    return value > 0 ? `+${value}` : `${value}`;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^[+-]/.test(text)) return text;
  if (/^\d+(\.\d+)?$/.test(text)) return `+${text}`;
  return text;
}

function toPointLabel(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return String(value);
  return numeric > 0 ? `+${numeric}` : `${numeric}`;
}

function normalizeTeamKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getTeamMatchKeys(value) {
  const fullName = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!fullName) return [];

  const parts = fullName.split(/\s+/).filter(Boolean);
  const keys = new Set();
  keys.add(normalizeTeamKey(fullName));
  if (parts.length) {
    keys.add(normalizeTeamKey(parts[parts.length - 1]));
  }
  if (parts.length >= 2) {
    keys.add(normalizeTeamKey(parts.slice(-2).join(" ")));
  }
  return [...keys].filter(Boolean);
}

function firstAvailableSgoBook(market) {
  if (!market || typeof market !== "object") return null;
  const books = market.byBookmaker || {};
  const preferred =
    books.draftkings ||
    books.espnbet ||
    books.fanduel ||
    books.betmgm ||
    books.caesars ||
    null;

  if (preferred?.available !== false) {
    return preferred;
  }

  for (const value of Object.values(books)) {
    if (value?.available !== false) {
      return value;
    }
  }

  return preferred;
}

function getSgoBookmakerName(market) {
  const books = market?.byBookmaker || {};
  if (books.draftkings) return "Draft Kings";
  if (books.espnbet) return "ESPN BET";
  if (books.fanduel) return "FanDuel";
  if (books.betmgm) return "BetMGM";
  if (books.caesars) return "Caesars";
  return "SportsGameOdds";
}

function normalizeSgoOddsEvent(event, competition) {
  const home = competition?.competitors?.find((entry) => entry.homeAway === "home");
  const away = competition?.competitors?.find((entry) => entry.homeAway === "away");
  const homeName = home?.team?.displayName || home?.team?.name || event?.teams?.home?.names?.long || "Home";
  const awayName = away?.team?.displayName || away?.team?.name || event?.teams?.away?.names?.long || "Away";
  const odds = event?.odds || {};

  const awayMl = odds["points-away-game-ml-away"];
  const homeMl = odds["points-home-game-ml-home"];
  const awaySpread = odds["points-away-game-sp-away"];
  const homeSpread = odds["points-home-game-sp-home"];
  const overTotal = odds["points-all-game-ou-over"];
  const underTotal = odds["points-all-game-ou-under"];
  const providerName =
    getSgoBookmakerName(awayMl) ||
    getSgoBookmakerName(awaySpread) ||
    getSgoBookmakerName(overTotal);

  const h2hOutcomes = {};
  const awayMlBook = firstAvailableSgoBook(awayMl);
  const homeMlBook = firstAvailableSgoBook(homeMl);
  maybePushOutcome(h2hOutcomes, awayName, toAmericanOdd(awayMlBook?.odds ?? awayMl?.bookOdds));
  maybePushOutcome(h2hOutcomes, homeName, toAmericanOdd(homeMlBook?.odds ?? homeMl?.bookOdds));

  const spreadsOutcomes = {};
  const awaySpreadBook = firstAvailableSgoBook(awaySpread);
  const homeSpreadBook = firstAvailableSgoBook(homeSpread);
  const awaySpreadLine = awaySpreadBook?.spread ?? awaySpread?.bookSpread;
  const homeSpreadLine = homeSpreadBook?.spread ?? homeSpread?.bookSpread;
  const awaySpreadOdds = toAmericanOdd(awaySpreadBook?.odds ?? awaySpread?.bookOdds);
  const homeSpreadOdds = toAmericanOdd(homeSpreadBook?.odds ?? homeSpread?.bookOdds);
  maybePushOutcome(
    spreadsOutcomes,
    awayName,
    awaySpreadLine !== null && awaySpreadLine !== undefined
      ? `${awaySpreadLine} ${awaySpreadOdds || ""}`.trim()
      : null
  );
  maybePushOutcome(
    spreadsOutcomes,
    homeName,
    homeSpreadLine !== null && homeSpreadLine !== undefined
      ? `${homeSpreadLine} ${homeSpreadOdds || ""}`.trim()
      : null
  );

  const totalsOutcomes = {};
  const overBook = firstAvailableSgoBook(overTotal);
  const underBook = firstAvailableSgoBook(underTotal);
  const totalLine = firstDefinedValue(
    overBook?.overUnder,
    underBook?.overUnder,
    overTotal?.bookOverUnder,
    underTotal?.bookOverUnder
  );
  maybePushOutcome(
    totalsOutcomes,
    "Over",
    totalLine !== null && totalLine !== undefined
      ? `${totalLine} ${toAmericanOdd(overBook?.odds ?? overTotal?.bookOdds) || ""}`.trim()
      : null
  );
  maybePushOutcome(
    totalsOutcomes,
    "Under",
    totalLine !== null && totalLine !== undefined
      ? `${totalLine} ${toAmericanOdd(underBook?.odds ?? underTotal?.bookOdds) || ""}`.trim()
      : null
  );

  return {
    h2h: Object.keys(h2hOutcomes).length ? [{ bookmaker: providerName, outcomes: h2hOutcomes }] : [],
    spreads: Object.keys(spreadsOutcomes).length ? [{ bookmaker: providerName, outcomes: spreadsOutcomes }] : [],
    totals: Object.keys(totalsOutcomes).length ? [{ bookmaker: providerName, outcomes: totalsOutcomes }] : []
  };
}

function findMatchingSgoEvent(events, competition) {
  if (!competition) return null;

  const home = competition.competitors?.find((entry) => entry.homeAway === "home");
  const away = competition.competitors?.find((entry) => entry.homeAway === "away");
  const homeKeys = getTeamMatchKeys(home?.team?.displayName || home?.team?.name);
  const awayKeys = getTeamMatchKeys(away?.team?.displayName || away?.team?.name);
  const eventTime = new Date(competition.date || competition.startDate || 0).getTime();

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const event of events || []) {
    const eventHomeKeys = getTeamMatchKeys(event?.teams?.home?.names?.long);
    const eventAwayKeys = getTeamMatchKeys(event?.teams?.away?.names?.long);
    const homeMatches = homeKeys.some((key) => eventHomeKeys.includes(key));
    const awayMatches = awayKeys.some((key) => eventAwayKeys.includes(key));
    if (!homeMatches || !awayMatches) {
      continue;
    }

    const sgoTime = new Date(event?.status?.startsAt || 0).getTime();
    const timeDiff = Math.abs(sgoTime - eventTime);
    if (timeDiff < bestScore) {
      best = event;
      bestScore = timeDiff;
    }
  }

  return best;
}

async function fetchSgoEventsForWindow(sport, date) {
  const leagueId = getSgoLeagueId(sport);
  if (!leagueId || !SPORTSGAMEODDS_API_KEY) {
    return [];
  }

  const target = new Date(date);
  const startsAfter = formatIsoDate(addDays(target, -1));
  const startsBefore = formatIsoDate(addDays(target, 2));
  const cacheKey = `${leagueId}:${startsAfter}:${startsBefore}`;
  const cached = getCached(sgoEventsCache, cacheKey, getOddsTtlMs(sport));
  if (cached) {
    return cached.value;
  }

  const endpoint = new URL("https://api.sportsgameodds.com/v2/events");
  endpoint.searchParams.set("leagueID", leagueId);
  endpoint.searchParams.set("oddsAvailable", "true");
  endpoint.searchParams.set("startsAfter", startsAfter);
  endpoint.searchParams.set("startsBefore", startsBefore);
  endpoint.searchParams.set("limit", "100");
  endpoint.searchParams.set("_ts", String(Date.now()));

  const payload = await fetchJson(endpoint.toString(), {
    "X-API-Key": SPORTSGAMEODDS_API_KEY
  });

  const events = Array.isArray(payload?.data) ? payload.data : [];
  setCached(sgoEventsCache, cacheKey, events);
  return events;
}

async function getSgoOddsForCompetition(sport, competition) {
  if (!competition) {
    return null;
  }

  const events = await fetchSgoEventsForWindow(sport, new Date(competition.date || Date.now()));
  const matchedEvent = findMatchingSgoEvent(events, competition);
  return matchedEvent ? normalizeSgoOddsEvent(matchedEvent, competition) : null;
}

function maybePushOutcome(outcomes, key, value) {
  if (value !== null && value !== undefined && value !== "") {
    outcomes[key] = value;
  }
}

function hasAnyOddsData(data) {
  return Boolean(
    data &&
      (
        (Array.isArray(data.h2h) && data.h2h.length) ||
        (Array.isArray(data.spreads) && data.spreads.length) ||
        (Array.isArray(data.totals) && data.totals.length)
      )
  );
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") {
      return value;
    }
  }
  return null;
}

function pickBestOddsSnapshot(item) {
  return {
    awayMoneyline: firstDefinedValue(
      item?.moneyline?.away?.live?.odds,
      item?.moneyline?.away?.close?.odds,
      item?.moneyline?.away?.open?.odds,
      item?.awayTeamOdds?.moneyLine
    ),
    homeMoneyline: firstDefinedValue(
      item?.moneyline?.home?.live?.odds,
      item?.moneyline?.home?.close?.odds,
      item?.moneyline?.home?.open?.odds,
      item?.homeTeamOdds?.moneyLine
    ),
    awaySpreadLine: firstDefinedValue(
      item?.pointSpread?.away?.live?.line,
      item?.pointSpread?.away?.close?.line,
      item?.pointSpread?.away?.open?.line
    ),
    awaySpreadOdds: firstDefinedValue(
      item?.pointSpread?.away?.live?.odds,
      item?.pointSpread?.away?.close?.odds,
      item?.pointSpread?.away?.open?.odds,
      item?.awayTeamOdds?.spreadOdds
    ),
    homeSpreadLine: firstDefinedValue(
      item?.pointSpread?.home?.live?.line,
      item?.pointSpread?.home?.close?.line,
      item?.pointSpread?.home?.open?.line
    ),
    homeSpreadOdds: firstDefinedValue(
      item?.pointSpread?.home?.live?.odds,
      item?.pointSpread?.home?.close?.odds,
      item?.pointSpread?.home?.open?.odds,
      item?.homeTeamOdds?.spreadOdds
    ),
    totalOverLine: firstDefinedValue(
      item?.total?.over?.live?.line,
      item?.total?.over?.close?.line,
      item?.total?.over?.open?.line
    ),
    totalOverOdds: firstDefinedValue(
      item?.total?.over?.live?.odds,
      item?.total?.over?.close?.odds,
      item?.total?.over?.open?.odds,
      item?.overOdds
    ),
    totalUnderLine: firstDefinedValue(
      item?.total?.under?.live?.line,
      item?.total?.under?.close?.line,
      item?.total?.under?.open?.line
    ),
    totalUnderOdds: firstDefinedValue(
      item?.total?.under?.live?.odds,
      item?.total?.under?.close?.odds,
      item?.total?.under?.open?.odds,
      item?.underOdds
    )
  };
}

function normalizeEspnPickcenterOddsItem(item, competition) {
  const home = competition?.competitors?.find((entry) => entry.homeAway === "home");
  const away = competition?.competitors?.find((entry) => entry.homeAway === "away");
  const homeName = home?.team?.displayName || home?.team?.name || "Home";
  const awayName = away?.team?.displayName || away?.team?.name || "Away";
  const providerName = item?.provider?.name || item?.provider?.displayName || "ESPN";
  const snapshot = pickBestOddsSnapshot(item);

  const h2hOutcomes = {};
  maybePushOutcome(h2hOutcomes, awayName, toAmericanOdd(snapshot.awayMoneyline));
  maybePushOutcome(h2hOutcomes, homeName, toAmericanOdd(snapshot.homeMoneyline));

  const spreadsOutcomes = {};
  if (snapshot.awaySpreadLine !== null || snapshot.homeSpreadLine !== null) {
    maybePushOutcome(
      spreadsOutcomes,
      awayName,
      `${snapshot.awaySpreadLine || ""} ${toAmericanOdd(snapshot.awaySpreadOdds) || ""}`.trim()
    );
    maybePushOutcome(
      spreadsOutcomes,
      homeName,
      `${snapshot.homeSpreadLine || ""} ${toAmericanOdd(snapshot.homeSpreadOdds) || ""}`.trim()
    );
  }

  const totalsOutcomes = {};
  const totalOverLine = snapshot.totalOverLine ? String(snapshot.totalOverLine).replace(/^[oO]/, "") : null;
  const totalUnderLine = snapshot.totalUnderLine ? String(snapshot.totalUnderLine).replace(/^[uU]/, "") : null;
  const totalLine = firstDefinedValue(totalOverLine, totalUnderLine);
  if (totalLine !== null) {
    maybePushOutcome(totalsOutcomes, "Over", `${totalLine} ${toAmericanOdd(snapshot.totalOverOdds) || ""}`.trim());
    maybePushOutcome(totalsOutcomes, "Under", `${totalLine} ${toAmericanOdd(snapshot.totalUnderOdds) || ""}`.trim());
  }

  return {
    h2h: Object.keys(h2hOutcomes).length
      ? [{ bookmaker: providerName, outcomes: h2hOutcomes }]
      : [],
    spreads: Object.keys(spreadsOutcomes).length
      ? [{ bookmaker: providerName, outcomes: spreadsOutcomes }]
      : [],
    totals: Object.keys(totalsOutcomes).length
      ? [{ bookmaker: providerName, outcomes: totalsOutcomes }]
      : []
  };
}

function normalizeHtmlText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/&#x2F;/gi, "/");
}

function extractOddsLikeValues(text) {
  return String(text || "").match(/[ou][0-9]+(?:\.[0-9]+)?\s[+-][0-9]+|[+-][0-9]+(?:\.[0-9]+)?\s[+-][0-9]+/gi) || [];
}

function parseLineAndPrice(text) {
  const trimmed = String(text || "").trim();
  const parts = trimmed.split(/\s+/);
  if (!parts.length) return null;
  return {
    line: parts[0] || null,
    odds: parts[1] || null
  };
}

function parseEspnRenderedLiveOdds(html, competition) {
  const away = competition?.competitors?.find((entry) => entry.homeAway === "away");
  const home = competition?.competitors?.find((entry) => entry.homeAway === "home");
  const awayName = away?.team?.displayName || away?.team?.name;
  const homeName = home?.team?.displayName || home?.team?.name;
  if (!awayName || !homeName) return null;

  const text = normalizeHtmlText(html);
  const sectionMatch = text.match(/Game Odds\s+Odds by[\s\S]*?See More Live Odds/);
  const section = sectionMatch?.[0] || "";
  if (!section) return null;

  const splitRegex = new RegExp(`${escapeRegExp(awayName)}([\\s\\S]*?)${escapeRegExp(homeName)}([\\s\\S]*?)See More Live Odds`, "i");
  const teamSections = section.match(splitRegex);
  if (!teamSections) return null;

  const awaySegment = teamSections[1] || "";
  const homeSegment = teamSections[2] || "";
  const awayValues = extractOddsLikeValues(awaySegment);
  const homeValues = extractOddsLikeValues(homeSegment);
  const awaySpread = parseLineAndPrice(awayValues.at(-2));
  const awayTotal = parseLineAndPrice(awayValues.at(-1));
  const homeSpread = parseLineAndPrice(homeValues.at(-2));
  const homeTotal = parseLineAndPrice(homeValues.at(-1));
  const awayMlOff = /Odds suspended/i.test(awaySegment);
  const homeMlOff = /Odds suspended/i.test(homeSegment);

  if (!awaySpread && !homeSpread && !awayTotal && !homeTotal && !awayMlOff && !homeMlOff) {
    return null;
  }

  const providerName = "Draft Kings";
  const h2hOutcomes = {};
  maybePushOutcome(h2hOutcomes, awayName, awayMlOff ? "OFF" : null);
  maybePushOutcome(h2hOutcomes, homeName, homeMlOff ? "OFF" : null);

  const spreadsOutcomes = {};
  maybePushOutcome(spreadsOutcomes, awayName, awaySpread ? `${awaySpread.line} ${awaySpread.odds || ""}`.trim() : null);
  maybePushOutcome(spreadsOutcomes, homeName, homeSpread ? `${homeSpread.line} ${homeSpread.odds || ""}`.trim() : null);

  const totalsOutcomes = {};
  if (awayTotal?.line) {
    maybePushOutcome(
      totalsOutcomes,
      String(awayTotal.line).toUpperCase().startsWith("U") ? "Under" : "Over",
      `${String(awayTotal.line).replace(/^[ou]/i, "")} ${awayTotal.odds || ""}`.trim()
    );
  }
  if (homeTotal?.line) {
    maybePushOutcome(
      totalsOutcomes,
      String(homeTotal.line).toUpperCase().startsWith("U") ? "Under" : "Over",
      `${String(homeTotal.line).replace(/^[ou]/i, "")} ${homeTotal.odds || ""}`.trim()
    );
  }

  return {
    h2h: Object.keys(h2hOutcomes).length ? [{ bookmaker: providerName, outcomes: h2hOutcomes }] : [],
    spreads: Object.keys(spreadsOutcomes).length ? [{ bookmaker: providerName, outcomes: spreadsOutcomes }] : [],
    totals: Object.keys(totalsOutcomes).length ? [{ bookmaker: providerName, outcomes: totalsOutcomes }] : []
  };
}

function parseEspnVisibleOddsLinks(html, competition) {
  const away = competition?.competitors?.find((entry) => entry.homeAway === "away");
  const home = competition?.competitors?.find((entry) => entry.homeAway === "home");
  const awayName = away?.team?.displayName || away?.team?.name;
  const homeName = home?.team?.displayName || home?.team?.name;
  if (!awayName || !homeName) return null;

  const text = normalizeHtmlText(html);
  if (!/Game Odds/i.test(text)) return null;

  const linkMatches = [...String(html || "").matchAll(/<a[^>]+href="https:\/\/sportsbook\.draftkings\.com\/gateway[^"]*"[^>]*>(.*?)<\/a>/gi)];
  const values = linkMatches
    .map((match) => decodeHtmlEntities(match[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (!values.length) return null;

  const spreads = values.filter((value) => /^[+-]\d+(?:\.\d+)?\s[+-]\d+$/i.test(value));
  const totals = values.filter((value) => /^[ou]\d+(?:\.\d+)?\s[+-]\d+$/i.test(value));
  const moneylines = values.filter((value) => /^[+-]\d{3,}$/.test(value));

  if (spreads.length < 2 && totals.length < 2 && moneylines.length < 2) return null;

  const providerName = "Draft Kings";
  const h2hOutcomes = {};
  maybePushOutcome(h2hOutcomes, awayName, moneylines[0] || null);
  maybePushOutcome(h2hOutcomes, homeName, moneylines[1] || null);

  const spreadsOutcomes = {};
  maybePushOutcome(spreadsOutcomes, awayName, spreads[0] || null);
  maybePushOutcome(spreadsOutcomes, homeName, spreads[1] || null);

  const totalsOutcomes = {};
  if (totals[0]) {
    const parsed = parseLineAndPrice(totals[0]);
    maybePushOutcome(
      totalsOutcomes,
      String(parsed?.line).toUpperCase().startsWith("U") ? "Under" : "Over",
      `${String(parsed?.line || "").replace(/^[ou]/i, "")} ${parsed?.odds || ""}`.trim()
    );
  }
  if (totals[1]) {
    const parsed = parseLineAndPrice(totals[1]);
    maybePushOutcome(
      totalsOutcomes,
      String(parsed?.line).toUpperCase().startsWith("U") ? "Under" : "Over",
      `${String(parsed?.line || "").replace(/^[ou]/i, "")} ${parsed?.odds || ""}`.trim()
    );
  }

  return {
    h2h: Object.keys(h2hOutcomes).length ? [{ bookmaker: providerName, outcomes: h2hOutcomes }] : [],
    spreads: Object.keys(spreadsOutcomes).length ? [{ bookmaker: providerName, outcomes: spreadsOutcomes }] : [],
    totals: Object.keys(totalsOutcomes).length ? [{ bookmaker: providerName, outcomes: totalsOutcomes }] : []
  };
}

async function getRenderedLiveOddsDebug(gameId, sport) {
  const { config, event, competition } = await findEspnEventAndCompetition(sport, gameId);
  if (!config || !event || !competition?.id) {
    return null;
  }

  const renderedHtml = await fetchEspnRenderedGamePage(gameId, config.espnLeague);
  const parsedVisible =
    parseEspnVisibleOddsLinks(renderedHtml, competition) ||
    parseEspnRenderedLiveOdds(renderedHtml, competition);

  return {
    status: competition?.status?.type?.detail || competition?.status?.type?.shortDetail || null,
    visible: parsedVisible,
    fetchedAt: Date.now()
  };
}

function normalizeEspnOddsItem(item, competition) {
  const home = competition?.competitors?.find((entry) => entry.homeAway === "home");
  const away = competition?.competitors?.find((entry) => entry.homeAway === "away");
  const homeName = home?.team?.displayName || home?.team?.name || "Home";
  const awayName = away?.team?.displayName || away?.team?.name || "Away";
  const providerName = item.provider?.name || item.provider?.displayName || item.provider?.id || "ESPN";
  const nestedAwayMoneyline =
    item?.moneyline?.away?.close?.odds ??
    item?.moneyline?.away?.live?.odds ??
    item?.moneyline?.away?.open?.odds;
  const nestedHomeMoneyline =
    item?.moneyline?.home?.close?.odds ??
    item?.moneyline?.home?.live?.odds ??
    item?.moneyline?.home?.open?.odds;
  const nestedAwaySpreadLine =
    item?.pointSpread?.away?.close?.line ??
    item?.pointSpread?.away?.live?.line ??
    item?.pointSpread?.away?.open?.line;
  const nestedAwaySpreadOdds =
    item?.pointSpread?.away?.close?.odds ??
    item?.pointSpread?.away?.live?.odds ??
    item?.pointSpread?.away?.open?.odds;
  const nestedHomeSpreadLine =
    item?.pointSpread?.home?.close?.line ??
    item?.pointSpread?.home?.live?.line ??
    item?.pointSpread?.home?.open?.line;
  const nestedHomeSpreadOdds =
    item?.pointSpread?.home?.close?.odds ??
    item?.pointSpread?.home?.live?.odds ??
    item?.pointSpread?.home?.open?.odds;
  const nestedOverLine =
    item?.total?.over?.close?.line ??
    item?.total?.over?.live?.line ??
    item?.total?.over?.open?.line;
  const nestedOverOdds =
    item?.total?.over?.close?.odds ??
    item?.total?.over?.live?.odds ??
    item?.total?.over?.open?.odds;
  const nestedUnderLine =
    item?.total?.under?.close?.line ??
    item?.total?.under?.live?.line ??
    item?.total?.under?.open?.line;
  const nestedUnderOdds =
    item?.total?.under?.close?.odds ??
    item?.total?.under?.live?.odds ??
    item?.total?.under?.open?.odds;

  const h2hOutcomes = {};
  maybePushOutcome(
    h2hOutcomes,
    awayName,
    toAmericanOdd(
      item.awayTeamOdds?.current?.moneyLine?.alternateDisplayValue ??
      item.awayTeamOdds?.current?.moneyLine?.american ??
      item.awayTeamOdds?.open?.moneyLine?.alternateDisplayValue ??
      item.awayTeamOdds?.open?.moneyLine?.american ??
      item.awayTeamOdds?.moneyLine ??
      item.awayMoneyLine ??
      item.awayMoneyline ??
      nestedAwayMoneyline
    )
  );
  maybePushOutcome(
    h2hOutcomes,
    homeName,
    toAmericanOdd(
      item.homeTeamOdds?.current?.moneyLine?.alternateDisplayValue ??
      item.homeTeamOdds?.current?.moneyLine?.american ??
      item.homeTeamOdds?.open?.moneyLine?.alternateDisplayValue ??
      item.homeTeamOdds?.open?.moneyLine?.american ??
      item.homeTeamOdds?.moneyLine ??
      item.homeMoneyLine ??
      item.homeMoneyline ??
      nestedHomeMoneyline
    )
  );

  const spreadValue = item.spread ?? item.details?.spread;
  const awaySpreadOdds = toAmericanOdd(
    item.awayTeamOdds?.current?.spread?.alternateDisplayValue ??
    item.awayTeamOdds?.current?.spread?.american ??
    item.awayTeamOdds?.spreadOdds ??
    item.spreadOdds ??
    nestedAwaySpreadOdds
  );
  const homeSpreadOdds = toAmericanOdd(
    item.homeTeamOdds?.current?.spread?.alternateDisplayValue ??
    item.homeTeamOdds?.current?.spread?.american ??
    item.homeTeamOdds?.spreadOdds ??
    item.spreadOdds ??
    nestedHomeSpreadOdds
  );
  const spreadsOutcomes = {};
  if (
    nestedAwaySpreadLine !== null ||
    nestedHomeSpreadLine !== null
  ) {
    maybePushOutcome(
      spreadsOutcomes,
      awayName,
      `${nestedAwaySpreadLine || ""} ${awaySpreadOdds || ""}`.trim()
    );
    maybePushOutcome(
      spreadsOutcomes,
      homeName,
      `${nestedHomeSpreadLine || ""} ${homeSpreadOdds || ""}`.trim()
    );
  } else if (spreadValue !== null && spreadValue !== undefined && spreadValue !== "") {
    const numericSpread = Number(spreadValue);
    const awayIsFavorite = Boolean(item.awayTeamOdds?.favorite);
    const homeIsFavorite = Boolean(item.homeTeamOdds?.favorite);

    let awayPoint = numericSpread;
    let homePoint = -numericSpread;

    if (awayIsFavorite && numericSpread > 0) {
      awayPoint = -numericSpread;
      homePoint = numericSpread;
    } else if (homeIsFavorite && numericSpread < 0) {
      awayPoint = Math.abs(numericSpread);
      homePoint = numericSpread;
    } else if (homeIsFavorite && numericSpread > 0) {
      awayPoint = numericSpread;
      homePoint = -numericSpread;
    } else if (awayIsFavorite && numericSpread < 0) {
      awayPoint = numericSpread;
      homePoint = Math.abs(numericSpread);
    }

    maybePushOutcome(spreadsOutcomes, awayName, `${toPointLabel(awayPoint)} ${awaySpreadOdds || ""}`.trim());
    maybePushOutcome(spreadsOutcomes, homeName, `${toPointLabel(homePoint)} ${homeSpreadOdds || ""}`.trim());
  }

  const totalsOutcomes = {};
  const totalLine =
    item.overUnder ??
    item.totalLine ??
    item.overUnderLine ??
    firstDefinedValue(
      nestedOverLine ? String(nestedOverLine).replace(/^[oO]/, "") : null,
      nestedUnderLine ? String(nestedUnderLine).replace(/^[uU]/, "") : null
    );
  if (nestedOverLine || nestedUnderLine) {
    maybePushOutcome(
      totalsOutcomes,
      "Over",
      `${String(nestedOverLine || totalLine || "").replace(/^[oO]/, "")} ${toAmericanOdd(nestedOverOdds) || ""}`.trim()
    );
    maybePushOutcome(
      totalsOutcomes,
      "Under",
      `${String(nestedUnderLine || totalLine || "").replace(/^[uU]/, "")} ${toAmericanOdd(nestedUnderOdds) || ""}`.trim()
    );
  } else if (totalLine !== null && totalLine !== undefined && totalLine !== "") {
    maybePushOutcome(totalsOutcomes, "Over", `${totalLine} ${toAmericanOdd(item.overOdds) || ""}`.trim());
    maybePushOutcome(totalsOutcomes, "Under", `${totalLine} ${toAmericanOdd(item.underOdds) || ""}`.trim());
  }

  return {
    h2h: Object.keys(h2hOutcomes).length
      ? [{ bookmaker: providerName, outcomes: h2hOutcomes }]
      : [],
    spreads: Object.keys(spreadsOutcomes).length
      ? [{ bookmaker: providerName, outcomes: spreadsOutcomes }]
      : [],
    totals: Object.keys(totalsOutcomes).length
      ? [{ bookmaker: providerName, outcomes: totalsOutcomes }]
      : []
  };
}

async function fetchEspnOddsCollection(eventId, competitionId, espnSport, espnLeague) {
  const endpoint = `https://sports.core.api.espn.com/v2/sports/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${competitionId}/odds`;
  const url = new URL(endpoint);
  url.searchParams.set("_ts", String(Date.now()));
  const payload = await fetchJson(url.toString());
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const firstItem = items[0];

  if (firstItem?.$ref) {
    return fetchJson(firstItem.$ref);
  }

  if (payload?.$ref) {
    return fetchJson(payload.$ref);
  }

  return firstItem || payload || null;
}

async function findEspnEventAndCompetition(sport, gameId) {
  const config = getEspnConfig(sport);
  if (!config) return { config: null, event: null, competition: null };

  let event = null;
  let competition = null;
  for (let offset = -7; offset <= 7; offset += 1) {
    const payload = await fetchEspnScoreboardForDate(config, addDays(new Date(), offset));
    event = (payload?.events || []).find((entry) => entry.id === gameId) || null;
    competition = event?.competitions?.[0] || null;
    if (event && competition?.id) break;
  }

  return { config, event, competition };
}

async function fetchEspnScoreboardForDate(config, date) {
  const endpoint = new URL(`https://site.api.espn.com/apis/site/v2/sports/${config.espnSport}/${config.espnLeague}/scoreboard`);
  endpoint.searchParams.set("dates", formatEspnDate(date));
  endpoint.searchParams.set("_ts", String(Date.now()));
  return fetchJson(endpoint.toString());
}

async function fetchEspnCdnGamePayload(config, gameId, view = "game") {
  const league = config?.espnLeague;
  if (!league) {
    throw new Error("Missing ESPN league config");
  }

  const endpoint = new URL(`https://cdn.espn.com/core/${league}/${view}`);
  endpoint.searchParams.set("xhr", "1");
  endpoint.searchParams.set("gameId", gameId);
  return fetchJson(endpoint.toString());
}

async function fetchEspnRenderedGamePage(gameId, league = "nba") {
  return fetchText(`https://www.espn.com/${league}/game?gameId=${gameId}`);
}

async function getGamesForSport(sport) {
  const cacheKey = sport;
  const cached = getCached(gamesCache, cacheKey, getGamesTtlMs(sport));
  if (cached) {
    return { data: cached.value, cachedAt: cached.cachedAt, cached: true };
  }

  let data;
  if (PROVIDER !== "espn") {
    data = (mockGames[sport] || []).map(normalizeMockGame);
  } else {
    const config = getEspnConfig(sport);
    if (!config) {
      data = [];
    } else {
      const todayPayload = await fetchEspnScoreboardForDate(config, new Date());
      const todayEvents = Array.isArray(todayPayload?.events) ? todayPayload.events : [];
      const todayGames = todayEvents.map((event) => normalizeEspnGame(sport, event));
      const activeTodayGames = todayGames.filter(isUpcomingOrLive);

      if (activeTodayGames.length) {
        data = activeTodayGames;
      } else {
        data = [];
        for (let offset = 1; offset <= 7; offset += 1) {
          const nextPayload = await fetchEspnScoreboardForDate(config, addDays(new Date(), offset));
          const nextEvents = Array.isArray(nextPayload?.events) ? nextPayload.events : [];
          if (nextEvents.length) {
            data = nextEvents.map((event) => normalizeEspnGame(sport, event));
            break;
          }
        }
      }
    }
  }

  const entry = setCached(gamesCache, cacheKey, data);
  return { data: entry.value, cachedAt: entry.cachedAt, cached: false };
}

async function getOddsForGame(gameId, sport) {
  const cacheKey = `${sport}:${gameId}`;
  const oddsTtlMs = getOddsTtlMs(sport);
  const normalizedSport = String(sport || "").toUpperCase();
  const preferRawEspnOdds = normalizedSport === "NHL";
  const useSgoLiveOnly = ODDS_PROVIDER === "sportsgameodds";
  const allowSgoPregameFallback = useSgoLiveOnly && normalizedSport !== "NHL";

  let data;
  if (PROVIDER !== "espn") {
    const cached = getCached(oddsCache, cacheKey, oddsTtlMs);
    if (cached) {
      return { data: cached.value, cachedAt: cached.cachedAt, cached: true };
    }

    data = mockOdds[gameId] || { h2h: [], spreads: [], totals: [] };
    const entry = setCached(oddsCache, cacheKey, data);
    return { data: entry.value, cachedAt: entry.cachedAt, cached: false };
  } else {
    const config = getEspnConfig(sport);
    if (!config) {
      data = { h2h: [], spreads: [], totals: [] };
    } else {
      let event = null;
      let competition = null;
      for (let offset = 0; offset <= 7; offset += 1) {
        const payload = await fetchEspnScoreboardForDate(config, addDays(new Date(), offset));
        event = (payload?.events || []).find((entry) => entry.id === gameId) || null;
        competition = event?.competitions?.[0] || null;
        if (event && competition?.id) break;
      }

      const isLiveCompetition = competition?.status?.type?.state === "in";
      if (!isLiveCompetition) {
        const cached = getCached(oddsCache, cacheKey, oddsTtlMs);
        if (cached) {
          return { data: cached.value, cachedAt: cached.cachedAt, cached: true };
        }
      }

      if (!event || !competition?.id) {
        data = { h2h: [], spreads: [], totals: [] };
      } else {
        let usedSgo = false;
        if (useSgoLiveOnly && isLiveCompetition) {
          const sgoData = await getSgoOddsForCompetition(sport, competition);
          if (hasAnyOddsData(sgoData)) {
            data = sgoData;
            usedSgo = true;
          }
        }

        if (!usedSgo) {
          let renderedLiveData = null;
          if (isLiveCompetition && !preferRawEspnOdds) {
            try {
              const renderedHtml = await fetchEspnRenderedGamePage(gameId, config.espnLeague);
              renderedLiveData =
                parseEspnVisibleOddsLinks(renderedHtml, competition) ||
                parseEspnRenderedLiveOdds(renderedHtml, competition);
            } catch {
              renderedLiveData = null;
            }
          }

          if (renderedLiveData && (renderedLiveData.spreads.length || renderedLiveData.totals.length || renderedLiveData.h2h.length)) {
            data = renderedLiveData;
          } else {
            if (preferRawEspnOdds) {
              const inlineOddsItem = competition?.odds?.[0] || null;
              let cdnPickcenterItem = null;
              try {
                const cdnPayload = await fetchEspnCdnGamePayload(config, gameId, "game");
                cdnPickcenterItem = cdnPayload?.gamepackageJSON?.pickcenter?.[0] || null;
              } catch {
                cdnPickcenterItem = null;
              }

              if (inlineOddsItem) {
                data = normalizeEspnOddsItem(inlineOddsItem, competition);
              } else if (cdnPickcenterItem) {
                data = normalizeEspnPickcenterOddsItem(cdnPickcenterItem, competition);
              } else {
                const oddsItem = await fetchEspnOddsCollection(event.id, competition.id, config.espnSport, config.espnLeague);
                data = oddsItem ? normalizeEspnOddsItem(oddsItem, competition) : { h2h: [], spreads: [], totals: [] };
              }
            } else {
              let pickcenterItem = null;
              try {
                const cdnPayload = await fetchEspnCdnGamePayload(config, gameId, "game");
                pickcenterItem = cdnPayload?.gamepackageJSON?.pickcenter?.[0] || null;
              } catch {
                pickcenterItem = null;
              }

              if (pickcenterItem) {
                data = normalizeEspnPickcenterOddsItem(pickcenterItem, competition);
              } else {
                const oddsItem = await fetchEspnOddsCollection(event.id, competition.id, config.espnSport, config.espnLeague);
                data = oddsItem ? normalizeEspnOddsItem(oddsItem, competition) : { h2h: [], spreads: [], totals: [] };
              }
            }
          }
        }

        if ((isLiveCompetition && useSgoLiveOnly) || (!isLiveCompetition && allowSgoPregameFallback)) {
          if (!hasAnyOddsData(data)) {
          const sgoFallbackData = await getSgoOddsForCompetition(sport, competition);
          if (hasAnyOddsData(sgoFallbackData)) {
            data = sgoFallbackData;
          }
          }
        }
      }

      if (isLiveCompetition) {
        return { data, cachedAt: Date.now(), cached: false };
      }
    }
  }

  if (!hasAnyOddsData(data)) {
    oddsCache.delete(cacheKey);
    return { data, cachedAt: Date.now(), cached: false };
  }

  const entry = setCached(oddsCache, cacheKey, data);
  return { data: entry.value, cachedAt: entry.cachedAt, cached: false };
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendJson(response, 404, { error: "Missing request URL" });
    return;
  }

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      provider: PROVIDER,
      oddsProvider: ODDS_PROVIDER,
      liveOddsEnabled: PROVIDER === "espn" || ODDS_PROVIDER === "sportsgameodds"
    });
    return;
  }

  if (url.pathname === "/api/sports") {
    sendJson(
      response,
      200,
      supportedSports.map((sport) => ({ id: sport, label: sport }))
    );
    return;
  }

  if (url.pathname === "/api/games") {
    const sport = url.searchParams.get("sport");
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    try {
      const { data, cachedAt, cached } = await getGamesForSport(sport);
      sendJson(response, 200, {
        data,
        meta: {
          cached,
          cachedAt,
          ttlMs: getGamesTtlMs(sport)
        }
      });
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load games from provider",
        detail: error instanceof Error ? error.message : "Unknown provider error"
      });
    }
    return;
  }

  if (url.pathname === "/api/debug/scoreboard") {
    const sport = url.searchParams.get("sport");
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    const config = getEspnConfig(sport);
    if (!config) {
      sendJson(response, 404, { error: "Unsupported sport" });
      return;
    }

    try {
      const payload = await fetchEspnScoreboardForDate(config, new Date());
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load raw ESPN scoreboard",
        detail: error instanceof Error ? error.message : "Unknown provider error"
      });
    }
    return;
  }

  const cdnDebugMatch = url.pathname.match(/^\/api\/debug\/games\/([^/]+)\/cdn$/);
  if (cdnDebugMatch) {
    const gameId = cdnDebugMatch[1];
    const sport = url.searchParams.get("sport");
    const view = url.searchParams.get("view") || "game";
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    const config = getEspnConfig(sport);
    if (!config) {
      sendJson(response, 404, { error: "Unsupported sport" });
      return;
    }

    try {
      const payload = await fetchEspnCdnGamePayload(config, gameId, view);
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load ESPN CDN payload",
        detail: error instanceof Error ? error.message : "Unknown provider error",
        view
      });
    }
    return;
  }

  const oddsMatch = url.pathname.match(/^\/api\/games\/([^/]+)\/odds$/);
  if (oddsMatch) {
    const gameId = oddsMatch[1];
    const sport = url.searchParams.get("sport");
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    try {
      const { data, cachedAt, cached } = await getOddsForGame(gameId, sport);
      sendJson(response, 200, {
        data,
        meta: {
          cached,
          cachedAt,
          ttlMs: getOddsTtlMs(sport)
        }
      });
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load odds from provider",
        detail: error instanceof Error ? error.message : "Unknown provider error"
      });
    }
    return;
  }

  const gameSummaryMatch = url.pathname.match(/^\/api\/games\/([^/]+)$/);
  if (gameSummaryMatch) {
    const gameId = gameSummaryMatch[1];
    const sport = url.searchParams.get("sport");
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    try {
      if (PROVIDER !== "espn") {
        const game = (mockGames[sport] || []).find((entry) => entry.id === gameId);
        if (!game) {
          sendJson(response, 404, { error: "Game not found" });
          return;
        }
        sendJson(response, 200, { data: normalizeMockGame(game) });
        return;
      }

      const { event } = await findEspnEventAndCompetition(sport, gameId);
      if (!event) {
        sendJson(response, 404, { error: "Game not found" });
        return;
      }

      sendJson(response, 200, { data: normalizeEspnGame(sport, event) });
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load game from provider",
        detail: error instanceof Error ? error.message : "Unknown provider error"
      });
    }
    return;
  }

  const oddsDebugMatch = url.pathname.match(/^\/api\/debug\/games\/([^/]+)\/odds$/);
  if (oddsDebugMatch) {
    const gameId = oddsDebugMatch[1];
    const sport = url.searchParams.get("sport");
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    try {
      const { config, event, competition } = await findEspnEventAndCompetition(sport, gameId);
      if (!config || !event || !competition?.id) {
        sendJson(response, 404, { error: "Game not found in upcoming ESPN scoreboards" });
        return;
      }

      const rawOdds = await fetchEspnOddsCollection(event.id, competition.id, config.espnSport, config.espnLeague);
      sendJson(response, 200, rawOdds);
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load raw ESPN odds",
        detail: error instanceof Error ? error.message : "Unknown provider error"
      });
    }
    return;
  }

  const liveRenderedOddsDebugMatch = url.pathname.match(/^\/api\/debug\/games\/([^/]+)\/visible-odds$/);
  if (liveRenderedOddsDebugMatch) {
    const gameId = liveRenderedOddsDebugMatch[1];
    const sport = url.searchParams.get("sport");
    if (!sport) {
      sendJson(response, 400, { error: "Missing sport query parameter" });
      return;
    }

    try {
      const payload = await getRenderedLiveOddsDebug(gameId, sport);
      if (!payload) {
        sendJson(response, 404, { error: "Game not found in upcoming ESPN scoreboards" });
        return;
      }
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 502, {
        error: "Unable to load rendered live odds",
        detail: error instanceof Error ? error.message : "Unknown provider error"
      });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Insiders backend listening on http://localhost:${PORT}`);
});
