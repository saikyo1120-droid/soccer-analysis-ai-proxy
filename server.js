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

async function resolvePlayerId(name, teamHint, season, birthHint) {
  const cacheKey = `resolve:${name}|${teamHint}|${season}|${birthHint || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  let results = [];
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
  const birth = String(query.get("birth") || "").trim(); // YYYY-MM-DD, used to disambiguate same-surname players
  const season = String(query.get("season") || guessSeason());
  if (!name) return { status: 400, body: { found: false, error: "name is required" } };

  const cacheKey = `season-stats:${name}|${team}|${birth}|${season}`;
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
      player = await resolvePlayerId(name, team, s, birth);
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

async function handleFixturesToday(query) {
  const leaguesParam = String(query.get("leagues") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const targetLeagues = leaguesParam.length ? leaguesParam : DEFAULT_LEAGUES;
  const today = new Date().toISOString().slice(0, 10);
  const season = guessSeason();

  const cacheKey = `fixtures:${today}:${targetLeagues.join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached };

  try {
    const results = await Promise.all(targetLeagues.map(async (leagueId) => {
      try {
        const data = await callApiFootball("/fixtures", { date: today, league: leagueId, season });
        return data.response || [];
      } catch (e) {
        return [];
      }
    }));
    const fixtures = results.flat().map((f) => ({
      id: f.fixture.id,
      date: f.fixture.date,
      status: f.fixture.status ? f.fixture.status.short : null,
      venue: f.fixture.venue ? f.fixture.venue.name : null,
      league: f.league ? f.league.name : null,
      home: { name: f.teams.home.name, logo: f.teams.home.logo, winner: f.teams.home.winner },
      away: { name: f.teams.away.name, logo: f.teams.away.logo, winner: f.teams.away.winner },
      score: f.goals ? { home: f.goals.home, away: f.goals.away } : null,
    }));
    const payload = { found: true, source: "API-Football", date: today, fetchedAt: new Date().toISOString(), fixtures };
    cacheSet(cacheKey, payload, 15 * 60 * 1000);
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
      if (pathname === "/api/debug/raw-search") {
        // Temporary diagnostic endpoint: bypasses all of our own transformation/
        // fallback logic and returns exactly what API-Football itself says for a
        // given search+league+season combo, so we can see the ground truth while
        // tracking down why resolvePlayerId isn't finding known real players.
        const name = parsed.searchParams.get("name") || "";
        const league = parsed.searchParams.get("league") || "39";
        const season = parsed.searchParams.get("season") || String(guessSeason());
        try {
          const data = await callApiFootball("/players", { search: name, league, season });
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ queried: { name, league, season }, resultsCount: (data.response || []).length, raw: data }));
        } catch (e) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ queried: { name, league, season }, error: e.message, code: e.code }));
        }
        return;
      }
      if (pathname === "/api/debug/raw-player") {
        // Temporary diagnostic endpoint: returns exactly what API-Football says for
        // /players?id=...&season=..., with NO club-vs-national-team filtering applied,
        // so we can see the real shape of the "statistics" array (how many entries,
        // what each entry's team/league name is, and whether "nationality" is present
        // on the player object) instead of guessing at it.
        const id = parsed.searchParams.get("id") || "";
        const season = parsed.searchParams.get("season") || String(guessSeason());
        try {
          const data = await callApiFootball("/players", { id, season });
          const responseCount = (data.response || []).length;
          const statsCounts = (data.response || []).map((entry) => (entry.statistics || []).length);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ queried: { id, season }, responseCount, statisticsCountPerResponseEntry: statsCounts, raw: data }));
        } catch (e) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ queried: { id, season }, error: e.message, code: e.code }));
        }
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

module.exports = { server, handlePlayerSeasonStats, handleFixturesToday, guessSeason };
