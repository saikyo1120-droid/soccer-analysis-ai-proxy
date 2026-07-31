/**
 * soccer-analysis-ai-proxy (依存ライブラリ一切なし版)
 * ------------------------------------------------
 * 「世界一分かりやすいサッカー分析AI」を有料API(API-Football / api-sports.io)に
 * 接続するための、最小限のバックエンドプロキシです。
 *
 * なぜこれが必要か:
 *   このプロトタイプはこれまで単一のHTMLファイルだけで動いていました。しかし
 *   API-FootballのAPIキーをHTML/JSに直接書いてしまうと、ページのソースを見れば
 *   誰でもキーを盗み見・悪用できてしまいます。このサーバーはキーを.env(サーバー側
 *   のみ)に保持し、フロントエンドからは「/api/...」という自前のエンドポイントだけを
 *   呼ばせることで、キーを一切外部に露出させずに実データを取得できるようにします。
 *
 * npm install が不要な理由:
 *   express や dotenv を使わず、Node.js に標準搭載されている http / fs / url だけで
 *   書いています。Node.js(18以上)さえ入っていれば、他に何もインストールせず
 *   そのまま `node server.js` で起動できます。
 *
 * 使い方:
 *   1) .env.example を .env にコピーし、API_FOOTBALL_KEY を設定
 *   2) node server.js
 *   3) ブラウザで http://localhost:8787/ を開く(index.html も自動で配信されます)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ---- .env を自前で読み込む(dotenvパッケージ不使用) ----
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.API_FOOTBALL_KEY || "";
const VIA_RAPIDAPI = String(process.env.API_FOOTBALL_VIA_RAPIDAPI || "false") === "true";
const DEFAULT_LEAGUES = (process.env.DEFAULT_LEAGUES || "39,140,78,135,61")
  .split(",").map((s) => s.trim()).filter(Boolean);

const API_HOST = "v3.football.api-sports.io";
const API_BASE = `https://${API_HOST}`;
const STATIC_ROOT = path.join(__dirname, ".."); // index.html が置かれているフォルダ

// ---- ごく簡易なインメモリキャッシュ(TTL付き) ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { cache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// ---- ごく簡易なレート制限(IPごと・1分あたり30リクエストまで) ----
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = 30;
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < windowMs);
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  return fresh.length > limit;
}

async function callApiFootball(endpoint, params) {
  if (!API_KEY) {
    const err = new Error("API_FOOTBALL_KEY が設定されていません(.envを確認してください)");
    err.code = "NO_KEY";
    throw err;
  }
  const url = new URL(API_BASE + endpoint);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  const headers = VIA_RAPIDAPI
    ? { "X-RapidAPI-Key": API_KEY, "X-RapidAPI-Host": API_HOST }
    : { "x-apisports-key": API_KEY };

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const err = new Error(`API-Football HTTP ${res.status}`);
    err.code = "HTTP_ERROR";
    throw err;
  }
  const json = await res.json();
  const errCount = Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors || {}).length;
  if (errCount) {
    const err = new Error("API-Football error: " + JSON.stringify(json.errors));
    err.code = "API_ERROR";
    throw err;
  }
  return json;
}

function guessSeason() {
  const d = new Date();
  const m = d.getMonth() + 1; // 欧州シーズンは7月開始想定
  return m >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}

// API-Football's /players endpoint rejects a bare `search` param: it requires
// `league` or `team` (a numeric ID, not a name) to be supplied alongside it
// ("The League or Team field is required with the Search field."). Since our
// registered players' club names are in Japanese and we don't maintain a
// name->numeric-team-ID mapping, the practical fix is to loop the search across
// a set of known league IDs instead. This covers the vast majority of a typical
// roster (top-5 European leagues); leagues outside this list (MLS, Saudi Pro
// League, etc.) can be added via the SEARCH_LEAGUES env var (comma-separated
// league IDs) if a player isn't being found.
const SEARCH_LEAGUES = (process.env.SEARCH_LEAGUES || (DEFAULT_LEAGUES.join(",") + ",253,307"))
  .split(",").map((s) => s.trim()).filter(Boolean);

// API-Football's player "name" field is typically a short form like "B. Saka"
// (built from lastname, sometimes with a first-initial), not the full "Bukayo
// Saka" we have registered — confirmed via /api/debug/raw-search in production:
// searching the full name returned 0 results, but searching "Saka" alone found
// him immediately. So we search by surname (the last whitespace-separated token)
// first, since that's what actually matches API-Football's indexing, and fall
// back to the full name afterward in case some player IS indexed that way.
function searchTermVariants(name) {
  const trimmed = (name || "").trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const variants = [];
  if (parts.length > 1) variants.push(parts[parts.length - 1]); // surname
  variants.push(trimmed); // full name, as a fallback
  return variants;
}

// Resolves an English club/team name (e.g. "Vissel Kobe") to API-Football's
// numeric team ID via the /teams search endpoint. This lets us find a player
// on ANY club worldwide without having to pre-register that club's league ID
// in SEARCH_LEAGUES — we just ask API-Football "which team is this" directly.
// Cached for 30 days since a team's ID never changes.
async function resolveTeamId(teamNameEnglish) {
  const name = (teamNameEnglish || "").trim();
  if (!name) return null;
  const cacheKey = `team-id:${name.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;
  try {
    const data = await callApiFootball("/teams", { search: name });
    const list = data.response || [];
    if (!list.length) { cacheSet(cacheKey, null, 24 * 60 * 60 * 1000); return null; }
    const exact = list.find((r) => (r.team && r.team.name || "").toLowerCase() === name.toLowerCase());
    const id = (exact || list[0]).team.id;
    cacheSet(cacheKey, id, 30 * 24 * 60 * 60 * 1000);
    return id;
  } catch (e) {
    return null;
  }
}

async function resolvePlayerId(name, teamHint, season, birthHint, teamEnglishHint) {
  const cacheKey = `resolve:${name}|${teamHint}|${season}|${birthHint || ""}|${teamEnglishHint || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  let results = [];

  // Preferred path: if we know the club's English name (set when a player is
  // registered), resolve it straight to a team ID and search within that team.
  // This works for ANY club in ANY league/country — no need to maintain a list
  // of known league IDs at all — so it's the most future-proof way to find a
  // player, especially for leagues we haven't specifically added support for.
  if (teamEnglishHint) {
    const teamId = await resolveTeamId(teamEnglishHint);
    if (teamId) {
      outerTeam:
      for (const term of searchTermVariants(name)) {
        try {
          const data = await callApiFootball("/players", { search: term, team: teamId, season });
          results = data.response || [];
          if (results.length) break outerTeam;
        } catch (e) {
          // try the next name variant
        }
      }
    }
  }

  // Fallback path: loop across our known major-league IDs (also used when no
  // English club name was supplied, e.g. for players registered before this
  // feature existed).
  if (!results.length) {
    outer:
    for (const term of searchTermVariants(name)) {
      for (const leagueId of SEARCH_LEAGUES) {
        try {
          const data = await callApiFootball("/players", { search: term, league: leagueId, season });
          results = data.response || [];
          if (results.length) break outer;
        } catch (e) {
          // this league/season combo errored (e.g. league id not valid for this season) — try the next one
        }
      }
    }
  }
  if (!results.length) {
    cacheSet(cacheKey, null, 60 * 60 * 1000);
    return null;
  }
  let picked = results[0];
  // Surname-based search can legitimately return several unrelated players (e.g.
  // searching "Saka" also matched "Wan-Bissaka", since it's a substring match).
  // A birthdate is a near-unique fingerprint, so prefer that when we have one —
  // it's far more reliable than comparing a Japanese club name string against
  // API-Football's English team names, which almost never share a substring.
  if (birthHint) {
    const match = results.find((r) => r.player && r.player.birth && r.player.birth.date === birthHint);
    if (match) picked = match;
  } else if (teamHint) {
    const hintLower = teamHint.toLowerCase();
    const match = results.find((r) =>
      (r.statistics || []).some((s) => (s.team && s.team.name || "").toLowerCase().includes(hintLower) ||
        hintLower.includes((s.team && s.team.name || "").toLowerCase()))
    );
    if (match) picked = match;
  }
  const resolved = { id: picked.player.id, name: picked.player.name, photo: picked.player.photo };
  cacheSet(cacheKey, resolved, 30 * 24 * 60 * 60 * 1000);
  return resolved;
}

async function handlePlayerSeasonStats(query) {
  const name = String(query.get("name") || "").trim();
  const team = String(query.get("team") || "").trim();
  const teamEn = String(query.get("teamEn") || "").trim(); // English club name, e.g. "Vissel Kobe" — used to look the club up directly via /teams, so we don't need that club's league ID pre-registered
  const birth = String(query.get("birth") || "").trim(); // YYYY-MM-DD, used to disambiguate same-surname players
  const season = String(query.get("season") || guessSeason());
  if (!name) return { status: 400, body: { found: false, error: "name is required" } };

  const cacheKey = `season-stats:${name}|${team}|${teamEn}|${birth}|${season}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached };

  // Try the requested season, then fall back to the previous season(s). This matters
  // a lot in the off-season (roughly June-August in Europe): the brand-new season has
  // 0 official appearances for almost everyone yet, so without this fallback the tool
  // would report "no data" for most players for weeks at a time even though last
  // season's real stats are readily available and far more useful to show.
  const seasonBase = parseInt(season, 10) || guessSeason();
  const candidateSeasons = [seasonBase, seasonBase - 1, seasonBase - 2];

  try {
    let player = null;
    for (const s of candidateSeasons) {
      player = await resolvePlayerId(name, team, s, birth, teamEn);
      if (player) break;
    }
    if (!player) {
      const payload = { found: false, reason: "player_not_found", name, season: seasonBase };
      cacheSet(cacheKey, payload, 6 * 60 * 60 * 1000);
      return { status: 200, body: payload };
    }

    let statsBlock = null, usedSeason = null;
    for (const s of candidateSeasons) {
      const data = await callApiFootball("/players", { id: player.id, season: s });
      const entry = (data.response || [])[0];
      if (!entry || !entry.statistics || !entry.statistics.length) continue;

      // A player's statistics array can contain BOTH club-level entries (e.g. Arsenal)
      // AND national-team entries (e.g. England), one per competition they appeared in
      // that season. This app is club-centric, so we prefer club entries. We detect a
      // national-team entry by comparing its team name against the player's nationality
      // (both are plain English strings from the same API-Football response, so this
      // comparison is reliable even though the club name shown to the user is Japanese).
      // Confirmed via live production data (2026, a World Cup year): a player's club may
      // not have ANY statistics entry yet this season while the national team already has
      // several (e.g. summer friendlies/World Cup matches) - in that case clubStats ends up
      // empty. We must NOT fall back to the national-team entries here, or we'd show
      // country stats mislabeled/mixed in as if they were club form; instead we skip this
      // season entirely and let the loop try an earlier season that has real club data.
      const nationality = (entry.player && entry.player.nationality) || null;
      const clubStats = nationality
        ? entry.statistics.filter((st) => !(st.team && st.team.name === nationality))
        : entry.statistics;
      if (!clubStats.length) continue; // this season only has national-team entries - keep looking at earlier seasons

      const best = clubStats.reduce(
        (acc, cur) => ((cur.games.appearences || 0) > (acc.games.appearences || 0) ? cur : acc),
        clubStats[0]
      );
      if ((best.games.appearences || 0) > 0) { statsBlock = best; usedSeason = s; break; }
      if (!statsBlock) { statsBlock = best; usedSeason = s; } // keep as a fallback candidate, but keep looking for a season with actual appearances
    }

    if (!statsBlock) {
      const payload = { found: false, reason: "no_statistics", name, season: seasonBase };
      cacheSet(cacheKey, payload, 6 * 60 * 60 * 1000);
      return { status: 200, body: payload };
    }

    const payload = {
      found: true,
      source: "API-Football",
      season: usedSeason,
      requestedSeason: seasonBase,
      fetchedAt: new Date().toISOString(),
      player: { id: player.id, name: player.name, photo: player.photo },
      team: statsBlock.team ? statsBlock.team.name : null,
      stats: {
        appearances: statsBlock.games.appearences,
        minutes: statsBlock.games.minutes,
        avgRating: statsBlock.games.rating ? Math.round(parseFloat(statsBlock.games.rating) * 100) / 100 : null,
        goals: statsBlock.goals ? statsBlock.goals.total : null,
        assists: statsBlock.goals ? statsBlock.goals.assists : null,
        yellowCards: statsBlock.cards ? statsBlock.cards.yellow : null,
        redCards: statsBlock.cards ? statsBlock.cards.red : null,
      },
    };
    cacheSet(cacheKey, payload, 6 * 60 * 60 * 1000);
    return { status: 200, body: payload };
  } catch (e) {
    const payload = { found: false, reason: e.code || "error", error: e.message };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    return { status: 200, body: payload };
  }
}

// Leagues/competitions to hide from "today's real fixtures" even though
// API-Football includes them in an unrestricted /fixtures?date=... response —
// youth, reserve, and women's competitions clutter a fan-facing app whose
// registered players are all senior men's footballers.
const FIXTURE_NAME_DENYLIST = /\b(u1[5-9]|u2[0-3]|women|female|femenina|feminine|reserve|reserves|ii|youth|academy|futsal|beach soccer)\b/i;

async function handleFixturesToday(query) {
  // A previous version of this looped over a fixed list of 5 European top-flight
  // leagues (DEFAULT_LEAGUES). That silently returns nothing for weeks at a time
  // during Europe's summer off-season (roughly June-August), since none of those
  // 5 leagues are playing then — even though real football is happening every day
  // elsewhere (MLS, Brazil, J-League, pre-season friendlies, international
  // tournaments, etc.). API-Football's /fixtures endpoint accepts `date` on its
  // own with no league restriction required, and returns everything scheduled
  // that day worldwide — so we query it unrestricted and only apply an optional
  // narrowing filter if the caller explicitly asks for specific league IDs via
  // ?leagues=.
  const leaguesParam = String(query.get("leagues") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  const cacheKey = `fixtures:${today}:${leaguesParam.join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached };

  try {
    let all = [];
    if (leaguesParam.length) {
      // Caller explicitly narrowed to specific league IDs — honor that (loop is
      // only needed because /fixtures takes one league ID at a time).
      const season = guessSeason();
      const results = await Promise.all(leaguesParam.map(async (leagueId) => {
        try {
          const data = await callApiFootball("/fixtures", { date: today, league: leagueId, season });
          return data.response || [];
        } catch (e) {
          return [];
        }
      }));
      all = results.flat();
    } else {
      // Default: no league restriction at all — get everything scheduled today.
      const data = await callApiFootball("/fixtures", { date: today });
      all = data.response || [];
    }

    const fixtures = all
      .filter((f) => !FIXTURE_NAME_DENYLIST.test((f.league && f.league.name) || ""))
      .map((f) => ({
        id: f.fixture.id,
        date: f.fixture.date,
        status: f.fixture.status ? f.fixture.status.short : null,
        venue: f.fixture.venue ? f.fixture.venue.name : null,
        league: f.league ? f.league.name : null,
        country: f.league ? f.league.country : null,
        home: { name: f.teams.home.name, logo: f.teams.home.logo, winner: f.teams.home.winner },
        away: { name: f.teams.away.name, logo: f.teams.away.logo, winner: f.teams.away.winner },
        score: f.goals ? { home: f.goals.home, away: f.goals.away } : null,
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, 80); // a fully unrestricted worldwide day can have hundreds of matches — cap to a sane amount

    const payload = { found: true, source: "API-Football", date: today, fetchedAt: new Date().toISOString(), fixtures };
    cacheSet(cacheKey, payload, 15 * 60 * 1000);
    return { status: 200, body: payload };
  } catch (e) {
    const payload = { found: false, reason: e.code || "error", error: e.message };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    return { status: 200, body: payload };
  }
}

// Statuses API-Football uses to mark a fixture as fully finished (as opposed to
// not-yet-started, in-play, postponed, cancelled, etc.).
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);

// Real "before the match" / "after the match" analysis for a specific fixture,
// requested on demand (only when the user clicks to analyze that one match) —
// unlike the today-list, this deliberately does NOT run for every fixture eagerly,
// to keep API quota usage sane (each analysis costs 1-3 extra API-Football calls).
async function handleFixtureAnalysis(query) {
  const id = String(query.get("id") || "").trim();
  if (!id) return { status: 400, body: { found: false, error: "id is required" } };

  const cacheKey = `fixture-analysis:${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached };

  try {
    const fixtureData = await callApiFootball("/fixtures", { id });
    const entry = (fixtureData.response || [])[0];
    if (!entry) {
      const payload = { found: false, reason: "fixture_not_found", id };
      cacheSet(cacheKey, payload, 15 * 60 * 1000);
      return { status: 200, body: payload };
    }

    const statusShort = entry.fixture.status ? entry.fixture.status.short : null;
    const base = {
      found: true,
      source: "API-Football",
      fetchedAt: new Date().toISOString(),
      fixture: {
        id: entry.fixture.id,
        date: entry.fixture.date,
        status: statusShort,
        venue: entry.fixture.venue ? entry.fixture.venue.name : null,
        league: entry.league ? entry.league.name : null,
        home: { name: entry.teams.home.name, logo: entry.teams.home.logo },
        away: { name: entry.teams.away.name, logo: entry.teams.away.logo },
        score: entry.goals ? { home: entry.goals.home, away: entry.goals.away } : null,
      },
    };

    if (!FINISHED_STATUSES.has(statusShort)) {
      // Not finished yet (includes not-started, in-play, postponed, etc.) — no
      // real post-match data exists yet, so there is nothing more to fetch from
      // API-Football here. The frontend builds the pre-match preview itself
      // (using our own registered player database for either club, if we have
      // one registered) since there's no reliable real "predicted lineup" feed.
      const payload = { ...base, phase: "upcoming" };
      cacheSet(cacheKey, payload, 5 * 60 * 1000); // short TTL: status can change (kickoff, postponement, etc.)
      return { status: 200, body: payload };
    }

    // Finished match: pull REAL per-player match ratings/stats and the real goal/
    // card timeline. This is genuine professional match data, not a simulation.
    const [playersData, eventsData] = await Promise.all([
      callApiFootball("/fixtures/players", { fixture: id }).catch(() => ({ response: [] })),
      callApiFootball("/fixtures/events", { fixture: id }).catch(() => ({ response: [] })),
    ]);

    function buildTeamPlayers(teamBlock) {
      if (!teamBlock) return [];
      return (teamBlock.players || [])
        .map((p) => {
          const s = (p.statistics || [])[0] || {};
          const rating = s.games && s.games.rating ? Math.round(parseFloat(s.games.rating) * 100) / 100 : null;
          return {
            name: p.player.name,
            photo: p.player.photo,
            position: s.games ? s.games.position : null,
            minutes: s.games ? s.games.minutes : null,
            rating,
            goals: s.goals ? s.goals.total : null,
            assists: s.goals ? s.goals.assists : null,
            yellowCards: s.cards ? s.cards.yellow : null,
            redCards: s.cards ? s.cards.red : null,
          };
        })
        .filter((p) => p.minutes !== null && p.minutes > 0) // exclude unused substitutes (no real data to show)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
    const teams = playersData.response || [];
    const homeTeamBlock = teams.find((t) => t.team && t.team.name === entry.teams.home.name) || teams[0];
    const awayTeamBlock = teams.find((t) => t.team && t.team.name === entry.teams.away.name) || teams[1];
    const homePlayers = buildTeamPlayers(homeTeamBlock);
    const awayPlayers = buildTeamPlayers(awayTeamBlock);

    const events = (eventsData.response || []).map((e) => ({
      minute: e.time ? e.time.elapsed : null,
      extra: e.time ? e.time.extra : null,
      team: e.team ? e.team.name : null,
      player: e.player ? e.player.name : null,
      assist: e.assist ? e.assist.name : null,
      type: e.type,
      detail: e.detail,
    }));

    const payload = {
      ...base,
      phase: "finished",
      homePlayers,
      awayPlayers,
      events,
      motmHome: homePlayers[0] || null,
      motmAway: awayPlayers[0] || null,
    };
    // Finished-match data never changes — safe to cache for a long time.
    cacheSet(cacheKey, payload, 7 * 24 * 60 * 60 * 1000);
    return { status: 200, body: payload };
  } catch (e) {
    const payload = { found: false, reason: e.code || "error", error: e.message };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    return { status: 200, body: payload };
  }
}

// ---- 静的ファイル配信(index.htmlなど。npmパッケージなしの簡易実装) ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(STATIC_ROOT, rel));
  if (!filePath.startsWith(STATIC_ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET");
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ found: false, error: "レート制限に達しました。しばらく待ってから再試行してください。" }));
      return;
    }

    try {
      if (pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, hasKey: !!API_KEY, viaRapidApi: VIA_RAPIDAPI }));
        return;
      }
      if (pathname === "/api/player-season-stats") {
        const { status, body } = await handlePlayerSeasonStats(parsed.searchParams);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/fixtures/today") {
        const { status, body } = await handleFixturesToday(parsed.searchParams);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/fixtures/analysis") {
        const { status, body } = await handleFixtureAnalysis(parsed.searchParams);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ found: false, error: "unknown endpoint" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ found: false, error: e.message }));
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`soccer-analysis-ai-proxy: http://localhost:${PORT}/ で起動しました`);
  console.log(`APIキー設定: ${API_KEY ? "あり" : "なし(.envのAPI_FOOTBALL_KEYを設定してください)"}`);
});

module.exports = { server, handlePlayerSeasonStats, handleFixturesToday, handleFixtureAnalysis, guessSeason };
