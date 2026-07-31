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

async function resolvePlayerId(name, teamHint, season) {
  const cacheKey = `resolve:${name}|${teamHint}|${season}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const data = await callApiFootball("/players", { search: name, season });
  const results = data.response || [];
  if (!results.length) {
    cacheSet(cacheKey, null, 60 * 60 * 1000);
    return null;
  }
  let picked = results[0];
  if (teamHint) {
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
  const season = String(query.get("season") || guessSeason());
  if (!name) return { status: 400, body: { found: false, error: "name is required" } };

  const cacheKey = `season-stats:${name}|${team}|${season}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached };

  try {
    const player = await resolvePlayerId(name, team, season);
    if (!player) {
      const payload = { found: false, reason: "player_not_found", name, season };
      cacheSet(cacheKey, payload, 6 * 60 * 60 * 1000);
      return { status: 200, body: payload };
    }
    const data = await callApiFootball("/players", { id: player.id, season });
    const entry = (data.response || [])[0];
    const statsBlock = entry && entry.statistics && entry.statistics.length
      ? entry.statistics.reduce((best, s) => ((s.games.appearences || 0) > ((best && best.games.appearences) || 0) ? s : best), null)
      : null;

    if (!statsBlock) {
      const payload = { found: false, reason: "no_statistics", name, season };
      cacheSet(cacheKey, payload, 6 * 60 * 60 * 1000);
      return { status: 200, body: payload };
    }

    const payload = {
      found: true,
      source: "API-Football",
      season,
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
