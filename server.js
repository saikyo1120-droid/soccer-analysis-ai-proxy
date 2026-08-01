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

// Stage C: 対話エンジン(議論モード)関連。実体は server/rag/ ・ server/discuss/ ・
// server/llm/ にあり、ここではモジュールとして読み込むだけ(利用箇所は下の方の
// 「Stage C」セクションを参照)。
const { createKnowledgeSource } = require("./rag/knowledgeSource");
const { planInformationNeeds } = require("./discuss/planner");
const { generateLLM, currentProviderName } = require("./llm");

// Stage E: Knowledge Engine / Memory Engine / Reasoning Engine(Hypothesis
// Generator + Evidence Ranking)。実体は server/knowledge/・server/memory/・
// server/reasoning/ にある(利用箇所は下の方の「Stage E」セクションを参照)。
const { createKnowledgeStore } = require("./knowledge/knowledgeStore");
const { createRelationshipIndex } = require("./knowledge/relationshipIndex");
const { createMemoryStore } = require("./memory/memoryStore");
const { buildEvidencePool } = require("./reasoning/evidencePool");
const { assembleReasoning, formatReasoningForPrompt } = require("./reasoning/reasoningEngine");

// 毎日学習エンジン(Learning Engine)。実体は server/learning/dailyJob.js。
// 依存(callApiFootball/resolveTeamId/Upstashアクセス関数)は、このファイル自身が
// 定義した後にまとめて注入する(利用箇所は下の方の「Stage D」セクションを参照)。
const { runDailyLearning, getGrowthLog, getRecentFactsForTeam } = require("./learning/dailyJob");

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

// ---- AI予測の的中率を「本物の記録」として残すためのUpstash Redis接続設定 ----
// なぜ必要か: このファイルの少し下にある「インメモリキャッシュ」はサーバーメモリ上に
// あるだけなので、Renderの無料プランでは再起動・再デプロイ・スリープ復帰のたびに
// 消えてしまいます。「AIの予測正答率」は消えてはいけない実績データなので、無料で
// 使える外部の永続ストレージ(Upstash Redis)にJSON形式で記録します。
// 未設定でもアプリ全体は普通に動作します(記録機能だけが無効になり、ホーム画面には
// 「記録を開始していません」という正直な表示になります)。
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const UPSTASH_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

const API_HOST = "v3.football.api-sports.io";
const API_BASE = `https://${API_HOST}`;

// index.html がどこに置かれているかは、デプロイ方法によって2パターンある:
//   (a) このファイル(server.js)と同じフォルダに index.html を置く
//       (例: GitHubリポジトリの直下に server.js と index.html を一緒に置く構成)
//   (b) このファイルを "server/" のようなサブフォルダに置き、index.html は
//       1つ上のフォルダに置く(ローカル開発時のフォルダ構成)
// 実際にindex.htmlが存在する方を自動的に選ぶことで、どちらの配置でも
// 「トップページが404になる」という事態を避ける。
function resolveStaticRoot() {
  const candidates = [__dirname, path.join(__dirname, "..")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0]; // index.htmlがどちらにも無い場合(APIプロキシ専用デプロイ)。今まで通り404になるだけで、APIエンドポイントの動作には影響しない
}
const STATIC_ROOT = resolveStaticRoot();

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

// ---- Upstash Redis REST APIへの薄いラッパー ----
// Upstashは「1コマンド1リクエスト」のシンプルなREST APIを提供している。ここでは
// 汎用の「コマンド配列をそのままPOSTする」形式(例: ["SET","key","value"])を使う。
// これにより GET/SET だけでなく、INCR(正答数などの原子的なカウンター増加)や
// RPUSH/LRANGE/LREM/LTRIM(未解決の予測一覧・直近の記録一覧)もすべて同じ関数で
// 呼び出せる。値の中身(JSON文字列)にどんな文字が含まれていても、リクエスト自体を
// JSON化して送るので壊れる心配がない。
async function upstashCmd(commandArray) {
  if (!UPSTASH_ENABLED) {
    const err = new Error("Upstash未設定(.envのUPSTASH_REDIS_REST_URL/TOKENを確認してください)");
    err.code = "NO_UPSTASH";
    throw err;
  }
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commandArray),
  });
  const json = await res.json();
  if (json && json.error) {
    const err = new Error("Upstash error: " + json.error);
    throw err;
  }
  return json ? json.result : null;
}
async function upstashGetJSON(key) {
  try {
    const raw = await upstashCmd(["GET", key]);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
async function upstashSetJSON(key, value) {
  try {
    await upstashCmd(["SET", key, JSON.stringify(value)]);
    return true;
  } catch (e) {
    return false;
  }
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

// ---- AI予測の「本物の記録」システム ----
// 目的: ホーム画面に表示する「予測正答率」が架空の数字にならないよう、実際に
// 予測を記録し、試合終了後に本当に当たったかどうかを検証して積み上げる。
// 「AIの予測」の中身は、このアプリが独自に発明した非公開の計算式ではなく、
// API-Footballが提供する実際の統計に基づく本物の予測エンドポイント
// (/predictions?fixture=...)をそのまま採用する。これにより「当たるかどうか
// 分からない自作ロジック」ではなく「実データに基づく予測」を検証できる。
// 記録はUpstash Redisに保存するため、Renderが再起動してもリセットされない。
function outcomeFromScore(homeGoals, awayGoals) {
  if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) return null;
  if (homeGoals > awayGoals) return "home";
  if (homeGoals < awayGoals) return "away";
  return "draw";
}

// 試合開始前に一度だけ、API-Footballの本物の予測(勝率%)を取得して記録する。
// 既に記録済みなら再取得・再カウントせず、そのまま既存の記録を返す(冪等性を担保)。
// 予測データが取得できない(新規昇格チームなどでAPI側にデータが無い)場合は、
// 架空の値を作らずnullを返し、その試合は正答率の集計対象にしない。
async function getOrLogPrediction(fixtureId, meta) {
  const key = `pred:${fixtureId}`;
  const existing = await upstashGetJSON(key);
  if (existing) return existing;
  if (!UPSTASH_ENABLED) return null;
  try {
    const data = await callApiFootball("/predictions", { fixture: fixtureId });
    const entry = (data.response || [])[0];
    const pct = entry && entry.predictions && entry.predictions.percent;
    if (!pct || !pct.home || !pct.draw || !pct.away) return null;
    const homePct = parseInt(pct.home, 10);
    const drawPct = parseInt(pct.draw, 10);
    const awayPct = parseInt(pct.away, 10);
    if (!Number.isFinite(homePct) || !Number.isFinite(drawPct) || !Number.isFinite(awayPct)) return null;

    let predictedWinner = "draw";
    if (homePct >= drawPct && homePct >= awayPct) predictedWinner = "home";
    else if (awayPct >= drawPct && awayPct >= homePct) predictedWinner = "away";

    const record = {
      fixtureId, league: meta.league || null, home: meta.homeName || null, away: meta.awayName || null,
      kickoff: meta.kickoff || null, homePct, drawPct, awayPct, predictedWinner,
      loggedAt: new Date().toISOString(), resolved: false, actualWinner: null, correct: null, resolvedAt: null,
    };
    await upstashSetJSON(key, record);
    await upstashCmd(["RPUSH", "pred:pending", String(fixtureId)]).catch(() => {});
    await upstashCmd(["INCR", "pred:total"]).catch(() => {});
    await upstashCmd(["SET", "pred:since", record.loggedAt, "NX"]).catch(() => {});
    return record;
  } catch (e) {
    return null; // API側で予測データが無い/エラー時は、架空の予測を作らず記録しない
  }
}

// 試合終了後、記録しておいた予測と実際の結果を突き合わせて的中/不的中を確定する。
// 既に解決済み、またはそもそも記録が無い(=AIが予測していなかった)試合は何もしない。
async function resolvePrediction(fixtureId, homeGoals, awayGoals) {
  if (!UPSTASH_ENABLED) return null;
  const key = `pred:${fixtureId}`;
  const record = await upstashGetJSON(key);
  if (!record || record.resolved) return null;
  const actualWinner = outcomeFromScore(homeGoals, awayGoals);
  if (!actualWinner) return null;

  const correct = actualWinner === record.predictedWinner;
  record.resolved = true;
  record.actualWinner = actualWinner;
  record.correct = correct;
  record.resolvedAt = new Date().toISOString();

  await upstashSetJSON(key, record);
  await upstashCmd(["LREM", "pred:pending", "0", String(fixtureId)]).catch(() => {});
  await upstashCmd(["INCR", "pred:resolved"]).catch(() => {});
  if (correct) await upstashCmd(["INCR", "pred:correct"]).catch(() => {});
  await upstashCmd(["RPUSH", "pred:recent", JSON.stringify(record)]).catch(() => {});
  await upstashCmd(["LTRIM", "pred:recent", "-20", "-1"]).catch(() => {});
  return record;
}

// ホーム画面に表示する「AI予測の実績」の集計値を返す。Upstash未設定の場合は
// 正直に「記録なし」を返す(架空の数字は絶対に出さない)。
async function handleAccuracyStats() {
  if (!UPSTASH_ENABLED) {
    return { status: 200, body: { configured: false, total: 0, resolved: 0, correct: 0, accuracyPct: null, since: null, recent: [] } };
  }
  try {
    const [totalRaw, resolvedRaw, correctRaw, since, recentRaw] = await Promise.all([
      upstashCmd(["GET", "pred:total"]),
      upstashCmd(["GET", "pred:resolved"]),
      upstashCmd(["GET", "pred:correct"]),
      upstashCmd(["GET", "pred:since"]),
      upstashCmd(["LRANGE", "pred:recent", "-10", "-1"]),
    ]);
    const total = parseInt(totalRaw, 10) || 0;
    const resolved = parseInt(resolvedRaw, 10) || 0;
    const correct = parseInt(correctRaw, 10) || 0;
    const accuracyPct = resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null;
    const recent = (recentRaw || [])
      .map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter(Boolean)
      .reverse();
    return { status: 200, body: { configured: true, total, resolved, correct, accuracyPct, since: since || null, recent } };
  } catch (e) {
    return { status: 200, body: { configured: true, error: e.message, total: 0, resolved: 0, correct: 0, accuracyPct: null, since: null, recent: [] } };
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

    // 「ながら解決」: 今日の試合一覧を取得したついでに、記録済みだが未解決のまま
    // だったAI予測を解決できないか確認する。一覧に既にスコアと試合状況が含まれて
    // いるため、追加のAPIリクエストを一切消費せずに済む(無料プランの上限に優しい)。
    if (UPSTASH_ENABLED) {
      try {
        const pendingIds = await upstashCmd(["LRANGE", "pred:pending", "0", "-1"]);
        if (pendingIds && pendingIds.length) {
          const pendingSet = new Set(pendingIds.map(String));
          for (const f of fixtures) {
            if (pendingSet.has(String(f.id)) && FINISHED_STATUSES.has(f.status) && f.score) {
              await resolvePrediction(f.id, f.score.home, f.score.away);
            }
          }
        }
      } catch (e) {
        // ベストエフォート: この掃除処理が失敗しても「今日の試合」表示自体は続行する
      }
    }

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
      // We DO, however, log AI-Football's real prediction percentages here so
      // that once this match finishes we can honestly verify whether the AI's
      // prediction was correct (see "AI予測の「本物の記録」システム" above).
      const aiPrediction = await getOrLogPrediction(entry.fixture.id, {
        league: entry.league ? entry.league.name : null,
        homeName: entry.teams.home.name,
        awayName: entry.teams.away.name,
        kickoff: entry.fixture.date,
      });
      const payload = {
        ...base,
        phase: "upcoming",
        aiPrediction: aiPrediction
          ? {
              homePct: aiPrediction.homePct,
              drawPct: aiPrediction.drawPct,
              awayPct: aiPrediction.awayPct,
              predictedWinner: aiPrediction.predictedWinner,
              loggedAt: aiPrediction.loggedAt,
            }
          : null,
      };
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

    // If we logged a real prediction for this fixture while it was still upcoming,
    // resolve it now against the real final score (honest win/draw/loss check).
    // If it was already resolved (e.g. via the "今日の試合"一覧 sweep) or was never
    // logged at all, this just returns the existing/absent record — no double counting.
    const scoreForResolve = entry.goals || {};
    await resolvePrediction(entry.fixture.id, scoreForResolve.home, scoreForResolve.away);
    const predictionRecord = await upstashGetJSON(`pred:${entry.fixture.id}`);

    const payload = {
      ...base,
      phase: "finished",
      homePlayers,
      awayPlayers,
      events,
      motmHome: homePlayers[0] || null,
      motmAway: awayPlayers[0] || null,
      aiPredictionResult: predictionRecord && predictionRecord.resolved
        ? {
            predictedWinner: predictionRecord.predictedWinner,
            actualWinner: predictionRecord.actualWinner,
            correct: predictionRecord.correct,
            homePct: predictionRecord.homePct,
            drawPct: predictionRecord.drawPct,
            awayPct: predictionRecord.awayPct,
          }
        : null,
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

// ---- ユーザーがサイトを訪れなくても学習が進むための「自動収集」エンドポイント ----
// なぜ必要か: これまでの予測の記録・解決は「誰かが実際にそのページを開いた時」に
// しか動かない(ユーザーのアクセスがトリガー)。しかし「ログインしなくても自動で
// 記録が貯まってほしい」という要望に応えるには、誰も見ていなくても定期的に
// 「今日の未記録の試合を記録する」「終わっているはずの試合を確認して確定する」を
// 実行してくれる仕組みが要る。このエンドポイントを外部の無料cronサービス(または
// このセッションのスケジュール機能)から定期的に叩いてもらうことで、Renderの
// サーバー自体に常駐タイマーを置かなくても実現できる(無料プランはアイドル時に
// スリープするため、こうして外部から定期的にアクセスされること自体がスリープ
// 復帰のきっかけにもなり好都合)。
// API-Footballの無料枠(1日100リクエスト)を使い切らないよう、1回の実行あたりの
// 新規記録・解決チェック件数には上限を設けている。
const AUTO_COLLECT_LOG_CAP = 3; // 1回の実行で新規に記録する試合数の上限
const AUTO_COLLECT_RESOLVE_CAP = 8; // 1回の実行で解決を試みる保留中予測の上限
const AUTO_COLLECT_RESOLVE_MIN_AGE_MS = 2 * 60 * 60 * 1000; // キックオフから2時間経っていない試合は「まだ終わっていない可能性が高い」としてスキップ

async function handleAutoCollectPredictions() {
  if (!UPSTASH_ENABLED) {
    return { status: 200, body: { ok: true, upstashConfigured: false, logged: 0, resolved: 0, note: "Upstash未設定のため何もしていません" } };
  }

  let logged = 0;
  let resolved = 0;
  const notes = [];

  // フェーズ1: 保留中(まだ結果が確定していない)の予測を、実際の試合結果と突き合わせる。
  // 「今日の試合」一覧のスイープでは対応できない“前日以前にキックオフした試合”もここで拾える。
  try {
    const pendingIds = (await upstashCmd(["LRANGE", "pred:pending", "0", "-1"])) || [];
    let checked = 0;
    for (const idStr of pendingIds) {
      if (checked >= AUTO_COLLECT_RESOLVE_CAP) { notes.push(`resolve cap reached (${AUTO_COLLECT_RESOLVE_CAP})`); break; }
      const record = await upstashGetJSON(`pred:${idStr}`);
      if (!record || record.resolved) continue;
      if (record.kickoff && (Date.now() - new Date(record.kickoff).getTime()) < AUTO_COLLECT_RESOLVE_MIN_AGE_MS) continue; // まだ試合中の可能性が高いので今回はスキップ
      checked++;
      try {
        const data = await callApiFootball("/fixtures", { id: idStr });
        const entry = (data.response || [])[0];
        if (!entry) continue;
        const statusShort = entry.fixture.status ? entry.fixture.status.short : null;
        if (FINISHED_STATUSES.has(statusShort) && entry.goals) {
          const r = await resolvePrediction(idStr, entry.goals.home, entry.goals.away);
          if (r) resolved++;
        }
      } catch (e) {
        notes.push(`resolve check failed for fixture ${idStr}: ${e.message}`);
      }
    }
  } catch (e) {
    notes.push("resolve phase error: " + e.message);
  }

  // フェーズ2: 今日の試合一覧から、まだ記録していない今後の試合を少数だけ新規に記録する。
  // handleFixturesToday()を再利用することで、キャッシュ・除外リーグ(ユース/女子など)の
  // ロジックを重複させない。
  try {
    const todayResult = await handleFixturesToday(new URLSearchParams());
    const fixtures = (todayResult.body && todayResult.body.fixtures) || [];
    const upcoming = fixtures.filter((f) => f.status === "NS");
    let attempted = 0;
    for (const f of upcoming) {
      if (attempted >= AUTO_COLLECT_LOG_CAP) { notes.push(`log cap reached (${AUTO_COLLECT_LOG_CAP})`); break; }
      const existing = await upstashGetJSON(`pred:${f.id}`);
      if (existing) continue; // 既に記録済み
      attempted++;
      const rec = await getOrLogPrediction(f.id, {
        league: f.league || null,
        homeName: f.home ? f.home.name : null,
        awayName: f.away ? f.away.name : null,
        kickoff: f.date,
      });
      if (rec) logged++;
    }
  } catch (e) {
    notes.push("log phase error: " + e.message);
  }

  return { status: 200, body: { ok: true, upstashConfigured: true, logged, resolved, notes } };
}

// ---- 試合分析AI: 予測ロジックAPI化(Stage B) ----
// これまでフロントエンド(index.html)の中でその場で計算していた「試合分析AI」の
// 予測ロジック(予想スコア・AI確信度・ボール支配率予想・勝因/弱点分析・試合の流れ・
// ターニングポイント/MVP予想・攻撃方向予想・危険エリア・予想布陣/フォーメーション)を、
// このサーバー側の関数として1対1で移植したもの。
//
// 設計方針:
//   - 「何を予測するか(AIの判断)」はサーバーで計算する。
//   - 「どう見せるか(SVGの描画・CSS変数を使った配色など)」はフロントエンドに残す。
//   これにより、この先モデルを本物の機械学習に差し替える際も、フロントエンドの
//   見た目やレンダリング処理には一切手を入れずに済む(判断ロジックの入れ替えだけで完結する)。
//
// データの持ち方について: 選手データ(PLAYERS)自体は今回まだフロントエンド側に
// 残しており(Stage C「データ蓄積」で本格的に扱う範囲)、リクエストごとに必要な
// 選手データをフロントエンドから送ってもらう形にしている。これにより、この
// エンドポイントの入出力インターフェースを変えずに、将来「選手データもサーバー側
// DBから取得する」という変更を裏側だけで行えるようにしてある。
const ATTR_LABELS_SRV = { attack: "攻撃力", shooting: "シュート", dribbling: "ドリブル", passing: "パス", tactical: "戦術理解", speed: "スピード", physical: "フィジカル", defense: "守備" };
const ATTR_KEYS_SRV = Object.keys(ATTR_LABELS_SRV);

function positionGroupSrv(pos) {
  if (!pos || pos === "-") return "不明";
  const first = String(pos).split(/[\/\s]/)[0].toUpperCase();
  if (first.indexOf("GK") !== -1) return "GK";
  if (["CB", "RB", "LB", "SB", "WB", "DF"].some((t) => first.indexOf(t) !== -1)) return "DF";
  if (["RW", "LW", "CF", "ST", "FW", "SS"].some((t) => first.indexOf(t) !== -1)) return "FW";
  if (["DM", "CM", "AM", "MF"].some((t) => first.indexOf(t) !== -1)) return "MF";
  return "その他";
}

function teamAvgSrv(players, attr) {
  if (!players.length) return 62;
  return players.reduce((s, p) => s + (attr === "overall" ? p.overall : (p.attrs ? p.attrs[attr] : 0)), 0) / players.length;
}

function computeAttrAveragesSrv(players) {
  const out = {};
  ATTR_KEYS_SRV.forEach((k) => { out[k] = teamAvgSrv(players, k); });
  return out;
}

function pickLikelyXISrv(players) {
  const buckets = { GK: [], DF: [], MF: [], FW: [] };
  players.forEach((p) => { const g = positionGroupSrv(p.position); if (buckets[g]) buckets[g].push(p); });
  Object.keys(buckets).forEach((g) => buckets[g].sort((a, b) => b.overall - a.overall));
  const counts = { GK: 1, DF: 4, MF: 4, FW: 2 };
  const xi = [];
  Object.keys(counts).forEach((g) => xi.push(...buckets[g].slice(0, counts[g])));
  return xi.length ? xi : players.slice().sort((a, b) => b.overall - a.overall).slice(0, Math.min(11, players.length));
}

function formationStringSrv(xi) {
  return `${xi.filter((p) => positionGroupSrv(p.position) === "DF").length}-${xi.filter((p) => positionGroupSrv(p.position) === "MF").length}-${xi.filter((p) => positionGroupSrv(p.position) === "FW").length}`;
}

function pickStandoutPlayerSrv(players) {
  if (!players || !players.length) return null;
  return players.slice().sort((a, b) => b.overall - a.overall)[0];
}

function fmtSrv(n, digits) {
  return Number(n).toFixed(digits != null ? digits : 1);
}

function buildWinLossFactorsSrv(homeLabel, awayLabel, homeAvg, awayAvg, homeOverall, awayOverall) {
  const homeWins = homeOverall >= awayOverall;
  const winner = homeWins ? homeLabel : awayLabel;
  const loser = homeWins ? awayLabel : homeLabel;
  const winnerAvg = homeWins ? homeAvg : awayAvg;
  const loserAvg = homeWins ? awayAvg : homeAvg;
  const winKey = ATTR_KEYS_SRV.slice().sort((a, b) => (winnerAvg[b] - loserAvg[b]) - (winnerAvg[a] - loserAvg[a]))[0];
  const loseKey = ATTR_KEYS_SRV.slice().sort((a, b) => loserAvg[a] - loserAvg[b])[0];
  const winFactor = `${winner}は${ATTR_LABELS_SRV[winKey]}で相手を上回っており(平均${fmtSrv(winnerAvg[winKey])} 対 ${fmtSrv(loserAvg[winKey])})、ここが試合を優位に進める鍵になるとAIは予想しています。`;
  const loseFactor = `${loser}は${ATTR_LABELS_SRV[loseKey]}がチーム内で相対的に弱く(平均${fmtSrv(loserAvg[loseKey])})、ここを突かれると苦しい展開になり得ます。`;
  return { winFactor, loseFactor, winner, loser };
}

function buildTurningPointAndMvpSrv(homeLabel, awayLabel, homeP, awayP, winnerLabel) {
  const winnerPlayers = winnerLabel === homeLabel ? homeP : awayP;
  const standout = pickStandoutPlayerSrv(winnerPlayers) || pickStandoutPlayerSrv(homeP.concat(awayP));
  const minute = 8 + Math.floor(Math.random() * 82);
  const half = minute <= 45 ? "前半" : "後半";
  const turningPoint = standout
    ? `${half}${minute}分前後、${standout.nameJa}が試合の流れを引き寄せる場面を作ると予想されます。`
    : `試合中盤にどちらかのチームがギアを上げるタイミングが訪れると予想されます。`;
  return { turningPoint, mvp: standout ? { key: standout.key, nameJa: standout.nameJa, emoji: standout.emoji, overall: standout.overall } : null };
}

function buildAttackDirectionDecisionSrv(homeAvg, awayAvg) {
  const dirFor = (avg) => (avg.speed + avg.dribbling > avg.passing + avg.tactical) ? "サイドを起点にした攻撃" : "中央からの組み立て";
  return { homeDir: dirFor(homeAvg), awayDir: dirFor(awayAvg) };
}

function buildMatchFlowDecisionSrv(diff) {
  const phaseCount = 5;
  const lean = Math.max(-1, Math.min(1, diff / 30));
  const segments = [];
  for (let i = 0; i < phaseCount; i++) segments.push(((lean + (Math.random() - 0.5) * 1.1) >= 0 ? "home" : "away"));
  return segments;
}

function buildDangerZonesDecisionSrv(players) {
  const attackers = players.slice().sort((a, b) => ((b.attrs ? b.attrs.shooting : 0) + (b.attrs ? b.attrs.dribbling : 0)) - ((a.attrs ? a.attrs.shooting : 0) + (a.attrs ? a.attrs.dribbling : 0))).slice(0, 3);
  const agg = {};
  attackers.forEach((p) => (p.zones || []).forEach(([zoneLabel, n]) => { agg[zoneLabel] = Math.max(agg[zoneLabel] || 0, n); }));
  return Object.entries(agg).map(([zoneLabel, n]) => ({ zoneLabel, n }));
}

function poissonishSrv(lambda) {
  let n = 0, p = Math.exp(-lambda), cum = p, r = Math.random();
  while (cum < r && n < 8) { n++; p *= lambda / n; cum += p; }
  return n;
}

// 選手データ(1人分)の最低限のバリデーション。number/string型が壊れていると
// 以降の計算がNaN/例外になり得るため、ここで弾いておく。
function isValidPredictPlayer(p) {
  if (!p || typeof p !== "object") return false;
  if (typeof p.overall !== "number" || !Number.isFinite(p.overall)) return false;
  if (!p.attrs || typeof p.attrs !== "object") return false;
  if (!ATTR_KEYS_SRV.every((k) => typeof p.attrs[k] === "number" && Number.isFinite(p.attrs[k]))) return false;
  return true;
}

const MAX_PREDICT_PLAYERS_PER_SIDE = 60; // 悪用防止(登録選手数の実際の最大は40台なので十分な余裕を持たせた上限)

async function handlePredictMatch(body) {
  if (!body || typeof body !== "object") return { status: 400, body: { ok: false, error: "invalid JSON body" } };
  const { homeLabel, awayLabel, homePlayers, awayPlayers } = body;
  if (typeof homeLabel !== "string" || typeof awayLabel !== "string") {
    return { status: 400, body: { ok: false, error: "homeLabel and awayLabel (string) are required" } };
  }
  if (!Array.isArray(homePlayers) || !Array.isArray(awayPlayers)) {
    return { status: 400, body: { ok: false, error: "homePlayers and awayPlayers must be arrays" } };
  }
  if (homePlayers.length > MAX_PREDICT_PLAYERS_PER_SIDE || awayPlayers.length > MAX_PREDICT_PLAYERS_PER_SIDE) {
    return { status: 400, body: { ok: false, error: `too many players per side (max ${MAX_PREDICT_PLAYERS_PER_SIDE})` } };
  }
  const homeP = homePlayers.filter(isValidPredictPlayer);
  const awayP = awayPlayers.filter(isValidPredictPlayer);
  if (homeP.length !== homePlayers.length || awayP.length !== awayPlayers.length) {
    return { status: 400, body: { ok: false, error: "one or more player entries are malformed (missing/invalid overall or attrs)" } };
  }

  const homeOverall = teamAvgSrv(homeP, "overall"), awayOverall = teamAvgSrv(awayP, "overall");
  const homeAvg = computeAttrAveragesSrv(homeP), awayAvg = computeAttrAveragesSrv(awayP);
  const diff = homeOverall - awayOverall;

  // 予想スコア(ポワソン分布ベース、毎回ランダム再生成 = 「分析する」を押すたびに新しいAI予測)
  const homeLambda = Math.max(0.4, 1.35 + diff / 28);
  const awayLambda = Math.max(0.4, 1.15 - diff / 28);
  const homeGoals = poissonishSrv(homeLambda), awayGoals = poissonishSrv(awayLambda);
  const confidence = Math.round(50 + Math.min(38, Math.abs(diff) * 2.6));

  // ボール支配率予想(パス・戦術理解の平均差から算出)
  const homePossPctRaw = 50 + (homeAvg.passing + homeAvg.tactical - awayAvg.passing - awayAvg.tactical) / 6;
  const possessionHomePct = Math.max(30, Math.min(70, Math.round(homePossPctRaw)));

  // スタイル分析テキスト
  const homeStyle = homeAvg.passing + homeAvg.tactical > homeAvg.speed + homeAvg.shooting ? "ボール保持を軸にした組み立て" : "スピードと決定力を活かした縦への速さ";
  const awayStyle = awayAvg.passing + awayAvg.tactical > awayAvg.speed + awayAvg.shooting ? "ボール保持を軸にした組み立て" : "スピードと決定力を活かした縦への速さ";
  const styleText = `${homeLabel}は${homeStyle}が持ち味、対する${awayLabel}は${awayStyle}が持ち味とAIは分析しています。${Math.abs(diff) < 2 ? "登録選手の平均能力値はほぼ互角で、拮抗した展開が予想されます。" : (diff > 0 ? homeLabel + "がやや優勢という分析です。" : awayLabel + "がやや優勢という分析です。")}`;

  const { winFactor, loseFactor } = buildWinLossFactorsSrv(homeLabel, awayLabel, homeAvg, awayAvg, homeOverall, awayOverall);
  const matchFlowSegments = buildMatchFlowDecisionSrv(diff);
  const winnerLabelForTp = homeOverall >= awayOverall ? homeLabel : awayLabel;
  const { turningPoint, mvp } = buildTurningPointAndMvpSrv(homeLabel, awayLabel, homeP, awayP, winnerLabelForTp);
  const { homeDir, awayDir } = buildAttackDirectionDecisionSrv(homeAvg, awayAvg);
  const homeDangerZones = buildDangerZonesDecisionSrv(homeP.length ? homeP : []);
  const awayDangerZones = buildDangerZonesDecisionSrv(awayP.length ? awayP : []);

  const homeXIFull = pickLikelyXISrv(homeP), awayXIFull = pickLikelyXISrv(awayP);
  const toXIEntry = (p) => ({ key: p.key, nameJa: p.nameJa, emoji: p.emoji, overall: p.overall, position: p.position });
  const homeXI = homeXIFull.map(toXIEntry), awayXI = awayXIFull.map(toXIEntry);
  const homeFormation = formationStringSrv(homeXIFull), awayFormation = formationStringSrv(awayXIFull);

  return {
    status: 200,
    body: {
      ok: true,
      homeGoals, awayGoals, confidence, possessionHomePct,
      homeOverall, awayOverall,
      styleText, winFactor, loseFactor,
      matchFlowSegments, turningPoint, mvp,
      attackDirection: { homeText: homeDir, awayText: awayDir },
      homeXI, awayXI, homeFormation, awayFormation,
      dangerZones: { home: homeDangerZones, away: awayDangerZones },
    },
  };
}

// ============================================================
// Stage C: 対話エンジン(議論モード) ― RAG + LLM推論
// ============================================================
// 全体の流れ: 質問 →(フロントエンド側で議論トリガーを検出)→ Planner(この質問に
// 必要な情報を決定)→ RAG(知識ベース=API-Footballの実データから事実だけ取得)→
// LLM推論(取得した事実だけを根拠に考察)→ ①事実②統計③根拠④考察⑤結論⑥信頼度
// の6部構成で返す。
//
// 設計方針:
//  - 単純な質問(選手データ・順位・試合結果など)はこのAPIを一切使わず、これまで
//    通りフロントエンドのルールベースで即答する(コスト最適化)。このAPIは
//    フロントエンドが「議論トリガー」を検出したときだけ呼ばれる。
//  - ①事実②統計はRAGで取得した実データをサーバー側でそのまま整形する(LLMには
//    生成させない)。LLMが担当するのは③根拠④考察⑤結論とフォローアップ質問だけ。
//    これにより、LLMが数字や固有名詞を作ってしまうリスクを最小化する。
//  - ⑥信頼度はLLMの自己申告ではなく、実際にRAGで取得できたデータの充足率から
//    機械的に算出する(信頼度自体がハルシネーションしないように)。
//  - 監督コメント・采配評価は、現状のデータソース(API-Football)では取得できない
//    ため、常に「取得できていない」ことを明示する(信頼度の理由欄にも反映)。

// ---- 毎日学習エンジン(Learning Engine)への依存注入 ----
// server/learning/dailyJob.js 自身はこのファイル(server.js)をrequireしない設計
// なので、必要な関数(API-Football呼び出し・Upstashアクセス)をここでまとめて渡す。
const learningDeps = {
  callApiFootball, resolveTeamId,
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
};

// ---- Stage E: Knowledge Engine / Memory Engine / Knowledge Graph への依存注入 ----
// これらもUpstash Redisだけを永続化先とするため、既存のupstashCmd/GetJSON/SetJSON
// をそのまま注入する(新しいデータベースを別途用意する必要はない)。Upstash未設定の
// 環境では、すべて「正直に何もしない」フォールバックとして動作する(既存パターンを踏襲)。
const knowledgeStore = createKnowledgeStore({
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
});
const relationshipIndex = createRelationshipIndex({
  upstashEnabled: UPSTASH_ENABLED, upstashGetJSON, upstashSetJSON,
});
const memoryStore = createMemoryStore({
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
});

const knowledgeSource = createKnowledgeSource({
  callApiFootball, resolveTeamId, guessSeason,
  getRecentFacts: (teamNameEnglish) => getRecentFactsForTeam(learningDeps, teamNameEnglish),
  getActiveKnowledge: (teamNameEnglish) => knowledgeStore.getActiveKnowledge(teamNameEnglish),
  setRelation: (...args) => relationshipIndex.setRelation(...args),
});

// LLM呼び出しは実費が発生するため、暴走・悪用でコストが青天井にならないよう
// 1日あたりの呼び出し上限を設ける(既定値は少なめ。.envで調整可能)。
const MAX_LLM_CALLS_PER_DAY = parseInt(process.env.MAX_LLM_CALLS_PER_DAY, 10) || 50;
let llmDailyBudget = { day: null, count: 0 };
function tryConsumeLlmBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (llmDailyBudget.day !== today) llmDailyBudget = { day: today, count: 0 };
  if (llmDailyBudget.count >= MAX_LLM_CALLS_PER_DAY) return false;
  llmDailyBudget.count += 1;
  return true;
}

function formatClubFacts(knowledge, needs) {
  const facts = [];
  const needSet = new Set(needs);
  if (needSet.has("recentForm")) {
    if (knowledge.recentForm.length) {
      const w = knowledge.recentForm.filter((m) => m.result === "勝ち").length;
      const d = knowledge.recentForm.filter((m) => m.result === "分け").length;
      const l = knowledge.recentForm.filter((m) => m.result === "負け").length;
      facts.push(`直近${knowledge.recentForm.length}試合: ${w}勝${d}分${l}敗`);
      knowledge.recentForm.slice(0, 5).forEach((m) => {
        const dateStr = m.date ? new Date(m.date).toISOString().slice(0, 10) : "";
        facts.push(`${dateStr} ${m.competition || ""} ${m.opponent}(${m.homeAway}) ${m.goalsFor}-${m.goalsAgainst} ${m.result}`);
      });
    } else if (knowledge.errors.includes("recent_form_failed")) {
      facts.push("直近の試合結果は取得できませんでした。");
    }
  }
  if (needSet.has("coach")) {
    facts.push(knowledge.coachName ? `現在の監督: ${knowledge.coachName}` : "監督名を取得できませんでした。");
  }
  if (needSet.has("formation")) {
    facts.push(knowledge.formation ? `直近試合の基本フォーメーション: ${knowledge.formation}` : "フォーメーション情報は取得できませんでした。");
  }
  if (needSet.has("injuries")) {
    if (knowledge.errors.includes("injuries_failed")) {
      facts.push("負傷者情報は取得できませんでした。");
    } else if (knowledge.injuries.length) {
      facts.push(`負傷・出場停止: ${knowledge.injuries.map((i) => `${i.playerName}(${i.reason || i.type || "詳細不明"})`).join("、")}`);
    } else {
      facts.push("現在報告されている負傷・出場停止者は見当たりません。");
    }
  }
  if (needSet.has("transfers")) {
    if (knowledge.errors.includes("transfers_failed")) {
      facts.push("移籍情報は取得できませんでした。");
    } else if (knowledge.transfers.length) {
      facts.push(`直近の移籍: ${knowledge.transfers.map((t) => `${t.playerName}(${t.direction}・${t.counterpart || ""})`).join("、")}`);
    } else {
      facts.push("直近180日以内の目立った移籍情報は見当たりません。");
    }
  }
  // 毎日学習エンジンが日々蓄積している「変化」の事実(Redisに保存済みのもの)。
  // 質問の種類に関わらず、あれば根拠として渡す(API-Football呼び出しを追加で
  // 発生させないため、needsに含まれるかどうかに関係なく無料で使える)。
  if (knowledge.learnedFacts && knowledge.learnedFacts.length) {
    knowledge.learnedFacts.slice(0, 5).forEach((f) => facts.push(`[学習エンジン ${f.date}] ${f.statement}`));
  }
  return facts;
}

function formatClubStats(knowledge, needs) {
  const stats = {};
  if (needs.includes("recentForm") && knowledge.goalsForTrend && knowledge.goalsForTrend.length) {
    stats.goalsForTrend = knowledge.goalsForTrend;
    stats.goalsAgainstTrend = knowledge.goalsAgainstTrend;
    stats.avgGoalsFor = Number((knowledge.goalsForTrend.reduce((a, b) => a + b, 0) / knowledge.goalsForTrend.length).toFixed(2));
    stats.avgGoalsAgainst = Number((knowledge.goalsAgainstTrend.reduce((a, b) => a + b, 0) / knowledge.goalsAgainstTrend.length).toFixed(2));
  }
  return stats;
}

// 信頼度(⑥)はLLMに聞くのではなく、実際にRAGで取得できたデータの充足率から
// 機械的に算出する。理由をつけて返すことで「AIっぽさ」ではなく根拠のある評価にする。
function computeClubConfidence(knowledge, needs) {
  if (knowledge.errors.includes("team_not_found")) {
    return { stars: 1, reasonJa: "クラブの実データを特定できなかったため、一般的な知識のみに基づく考察です。" };
  }
  const checks = [];
  if (needs.includes("recentForm")) checks.push({ ok: knowledge.recentForm.length > 0, label: "直近の試合結果" });
  if (needs.includes("coach")) checks.push({ ok: !!knowledge.coachName, label: "監督名" });
  if (needs.includes("formation")) checks.push({ ok: !!knowledge.formation, label: "フォーメーション" });
  if (needs.includes("injuries")) checks.push({ ok: !knowledge.errors.includes("injuries_failed"), label: "負傷者情報" });
  if (needs.includes("transfers")) checks.push({ ok: !knowledge.errors.includes("transfers_failed"), label: "移籍情報" });
  const okLabels = checks.filter((c) => c.ok).map((c) => c.label);
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);
  const ratio = checks.length ? okLabels.length / checks.length : 0;
  const stars = Math.max(1, Math.min(5, Math.round(ratio * 5) || 1));
  let reasonJa = missing.length === 0
    ? `${okLabels.join("・")}が一致して取得できているため。`
    : `${missing.join("・")}が取得できておらず、推測に基づく部分があります(取得できたのは: ${okLabels.join("・") || "なし"})。`;
  if (needs.includes("coach")) reasonJa += ` また、${knowledge.managerQuoteUnavailableReason}`;
  return { stars, reasonJa };
}

function buildDiscussSystemPrompt() {
  return [
    "あなたはサッカーの分析官です。以下に与えられた「事実」だけを根拠として、利用者の質問に答えてください。",
    "事実に無い具体的な数字・固有名詞(スコア・日付・移籍額・選手名など)を新たに作ってはいけません。",
    "与えられた事実が乏しい場合は、それを正直に述べた上で、一般的なサッカーの見方として考察してください。",
    "事実と自分の意見は明確に書き分けてください(「〜という結果が出ています」と「私は〜と考えます」のように)。",
    "利用者が意見や感想を述べている場合は、頭ごなしに否定せず、まずその視点を受け止めてください。",
    "必ず次の形式で、日本語で出力してください。見出し以外の余計な文章は含めないでください。",
    "",
    "###根拠###",
    "(与えられた事実のうち、この考察で特に重視した点を1〜3文で)",
    "",
    "###考察###",
    "(複数の要因を統合したあなた自身の見解を3〜6文程度で。意見であることが分かる書き方をしてください)",
    "",
    "###結論###",
    "(まとめと、今後の見通しを1〜3文で)",
    "",
    "###フォローアップ###",
    "(議論を続けるための質問を1〜2個、1行に1つずつ)",
  ].join("\n");
}

function parseDiscussLlmOutput(rawText) {
  const text = String(rawText || "");
  const grab = (label, nextLabels) => {
    const startIdx = text.indexOf(`###${label}###`);
    if (startIdx === -1) return "";
    let end = text.length;
    for (const n of nextLabels) {
      const idx = text.indexOf(`###${n}###`, startIdx + 1);
      if (idx !== -1 && idx < end) end = idx;
    }
    return text.slice(startIdx + label.length + 6, end).trim();
  };
  const evidence = grab("根拠", ["考察", "結論", "フォローアップ"]);
  const consideration = grab("考察", ["結論", "フォローアップ"]);
  const conclusion = grab("結論", ["フォローアップ"]);
  const followRaw = grab("フォローアップ", []);
  const parsedOk = !!(evidence || consideration || conclusion);
  if (!parsedOk) {
    // LLMが指定フォーマットに従わなかった場合の保険: 空欄のまま返すより、
    // 生成された文章をそのまま考察欄に入れて表示できるようにする。
    return { evidence: "", consideration: text.trim().slice(0, 1200), conclusion: "", followUpQuestions: [], parsedOk: false };
  }
  const followUpQuestions = followRaw.split("\n").map((s) => s.replace(/^[・\-\d.、\s]+/, "").trim()).filter(Boolean).slice(0, 2);
  return { evidence, consideration, conclusion, followUpQuestions, parsedOk: true };
}

async function handleDiscuss(body) {
  if (!body || typeof body !== "object") return { status: 400, body: { ok: false, error: "invalid JSON body" } };
  const question = String(body.question || "").trim();
  if (!question) return { status: 400, body: { ok: false, error: "question is required" } };
  if (question.length > 500) return { status: 400, body: { ok: false, error: "question is too long (max 500 chars)" } };

  const subject = (body.subject && typeof body.subject === "object") ? body.subject : { type: null };
  const plan = planInformationNeeds(question, subject);

  let facts = [];
  let stats = {};
  let confidence;
  const knowledgeMeta = { needs: plan.needs, plannerReasoning: plan.reasoning, comparisonAxes: plan.comparisonAxes || [] };

  // Stage E: Reasoning Engine(Hypothesis Generator + Evidence Ranking)と
  // Memory Engine(前回の結論)。クラブに関する質問で、実データが取得できた
  // 場合にのみ組み立てる(選手・一般質問は構造化された根拠プールを持たないため
  // 対象外。将来的に拡張する余地があることをREADMEで開示する)。
  let reasoningBundle = null;
  let memorySubjectKey = null;
  let previousConclusion = null;

  if (subject.type === "club") {
    if (!subject.labelEn) {
      facts.push(`「${subject.labelJa || "対象クラブ"}」の英語名が特定できなかったため、実データの取得を省略しました。`);
      confidence = { stars: 1, reasonJa: "クラブを実データ上で特定できなかったため、一般的な知識のみに基づく考察です。" };
    } else {
      const knowledge = await knowledgeSource.gatherClubKnowledge(subject.labelEn, plan.needs);
      facts = formatClubFacts(knowledge, plan.needs);
      stats = formatClubStats(knowledge, plan.needs);
      confidence = computeClubConfidence(knowledge, plan.needs);
      knowledgeMeta.dataErrors = knowledge.errors;

      const evidencePool = buildEvidencePool(knowledge, subject.labelEn);
      reasoningBundle = assembleReasoning(evidencePool, { teamJa: subject.labelJa, teamEn: subject.labelEn });
      knowledgeMeta.reasoning = {
        hypothesesConsidered: reasoningBundle.hypotheses.map((h) => ({ label: h.label, score: h.score, evidenceCount: h.evidence.length })),
        selectedLabel: reasoningBundle.selected ? reasoningBundle.selected.label : null,
        selfCheck: reasoningBundle.selfCheck,
      };

      memorySubjectKey = `team:${subject.labelEn}:leadingFactor`;
      try {
        previousConclusion = await memoryStore.getLastConclusion(memorySubjectKey);
      } catch (e) { /* Memory Engine未設定・エラー時は「前回の結論なし」として続行する */ }
      if (previousConclusion) knowledgeMeta.reasoning.previousConclusion = previousConclusion.statement;
    }
  } else if (subject.type === "player") {
    const hint = (body.playerHint && typeof body.playerHint === "object") ? body.playerHint : {};
    const q = new URLSearchParams({ name: hint.name || "", team: hint.team || "", teamEn: hint.teamEn || "", birth: hint.birth || "" });
    const { body: statsBody } = await handlePlayerSeasonStats(q);
    if (statsBody.found) {
      const s = statsBody.stats || {};
      const playerName = (statsBody.player && statsBody.player.name) || hint.name || "対象選手";
      facts.push(`${playerName}の${statsBody.season}シーズン実成績: 出場${s.appearances ?? "不明"}試合・${s.goals ?? "不明"}得点・${s.assists ?? "不明"}アシスト・平均レーティング${s.avgRating ?? "不明"}`);
      stats = { appearances: s.appearances, goals: s.goals, assists: s.assists, avgRating: s.avgRating };
      confidence = { stars: 4, reasonJa: "今シーズンの実成績データが取得できているため。ただし直近の調子や怪我の詳細までは反映されていません。" };
    } else {
      facts.push(`${hint.name || "対象選手"}の実成績データは見つかりませんでした(${statsBody.reason || "不明"})。`);
      confidence = { stars: 1, reasonJa: "実成績データを取得できなかったため、一般的な知識のみに基づく考察です。" };
    }
  } else {
    facts.push("特定のクラブ・選手データには基づかない、一般的なサッカーの知識に基づく考察です。");
    confidence = { stars: 2, reasonJa: "特定の実データによる裏付けができないため、確信度は控えめにしています。" };
  }

  if (!tryConsumeLlmBudget()) {
    return {
      status: 200,
      body: { ok: false, reason: "llm_budget_exceeded", message: "本日はAI考察の利用上限に達しました。しばらくしてから再度お試しください。" },
    };
  }

  const reasoningPromptBlock = reasoningBundle ? formatReasoningForPrompt(reasoningBundle, previousConclusion) : "";
  const userPrompt = [
    `利用者の質問: 「${question}」`,
    "",
    "取得できた事実:",
    facts.length ? facts.map((f) => `- ${f}`).join("\n") : "(取得できた事実はありません)",
    ...(reasoningPromptBlock ? ["", reasoningPromptBlock] : []),
  ].join("\n");

  let llmOut;
  try {
    const { text } = await generateLLM({ systemPrompt: buildDiscussSystemPrompt(), userPrompt, maxTokens: 700 });
    llmOut = parseDiscussLlmOutput(text);
  } catch (e) {
    return {
      status: 200,
      body: {
        ok: false,
        reason: e.code || "llm_error",
        message: e.code === "NO_KEY"
          ? "LLMのAPIキーが設定されていないため、考察機能はまだ利用できません(.envを確認してください)。"
          : "AIの考察生成に失敗しました。しばらくしてから再度お試しください。",
      },
    };
  }

  // ---- Stage E: Memory Engineへの結論の保存 + Knowledge Engineへの分析の昇格 ----
  // 「AIは昨日こう考えていたが、今日はこう考える」を成立させるための書き込み。
  // Redisへの書き込みのみでLLM呼び出しを追加しないため、失敗しても回答は返す
  // (ベストエフォート。既存のUpstash利用パターンと同じ方針)。
  if (reasoningBundle && reasoningBundle.selected && memorySubjectKey) {
    try {
      const nowIso = new Date().toISOString();
      const selected = reasoningBundle.selected;
      const changeReason = selected.evidence.length
        ? `新しい根拠(${selected.evidence.slice(0, 3).map((e) => e.statement).join(" / ")})に基づき判断が更新されました。`
        : "根拠が変化したため判断が更新されました。";
      const memoryResult = await memoryStore.saveConclusion(
        memorySubjectKey,
        { statement: selected.statement, confidence: selected.score, reasoning: reasoningBundle.selfCheck.verdict, computedAt: nowIso },
        changeReason
      );
      knowledgeMeta.reasoning.memory = { saved: memoryResult.saved, changed: memoryResult.changed, revision: memoryResult.revision };

      // 根拠が実際にあった仮説だけを「AI自身の分析」としてKnowledge Engineに
      // 昇格させる(根拠0件の仮説を知識として保存すると、でっち上げた知識に
      // なってしまうため保存しない)。
      if (selected.score > 0) {
        await knowledgeStore.saveKnowledgeItem({
          teamEn: subject.labelEn, category: selected.id, type: "analysis",
          statement: selected.statement, computedAt: nowIso,
        });
      }
    } catch (e) { /* ベストエフォート: Memory/Knowledge Engineへの保存失敗は回答自体に影響させない */ }
  }

  return {
    status: 200,
    body: {
      ok: true,
      facts,
      stats,
      evidence: llmOut.evidence,
      consideration: llmOut.consideration,
      conclusion: llmOut.conclusion,
      confidence,
      followUpQuestions: llmOut.followUpQuestions,
      meta: { ...knowledgeMeta, llmProvider: currentProviderName(), parsedOk: llmOut.parsedOk },
    },
  };
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

// POST本文(JSON)を読み取るためのヘルパー(npmパッケージ不使用のため自前実装)。
// 想定外に巨大なリクエストでメモリを圧迫されないよう、上限バイト数を超えたら
// 読み取りを中断してエラーにする。
const MAX_POST_BODY_BYTES = 2 * 1024 * 1024; // 2MB(選手データ数十人分でも十分すぎる余裕)
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_POST_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (received === 0) { resolve(null); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  if (pathname.startsWith("/api/")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
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
      if (pathname === "/api/accuracy-stats") {
        const { status, body } = await handleAccuracyStats();
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/predict-match") {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Allow": "POST" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed, use POST" }));
          return;
        }
        let parsedBody;
        try {
          parsedBody = await readJsonBody(req);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const { status, body } = await handlePredictMatch(parsedBody);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/discuss") {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Allow": "POST" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed, use POST" }));
          return;
        }
        let parsedBody;
        try {
          parsedBody = await readJsonBody(req);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        const { status, body } = await handleDiscuss(parsedBody);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/predictions/auto-collect") {
        // このエンドポイントは(誰かが見ていなくても)API-Footballへの実リクエストを
        // 能動的に発生させるため、他の読み取り専用エンドポイントより悪用の影響が
        // 大きい(無料枠1日100リクエストを外部から連打されて使い切られる恐れがある)。
        // AUTO_COLLECT_SECRETを設定した場合のみ、一致する?key=を要求する
        // (未設定なら従来通り誰でも呼べる。定期実行の仕組みを外部cronサービスに
        // 設定する際は、必ずこのシークレットも一緒に渡すことを推奨)。
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        const { status, body } = await handleAutoCollectPredictions();
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/learning/run-daily") {
        // 毎日学習エンジンの実行エンドポイント。API-Footballへの実リクエストを
        // 複数発生させる能動的なバッチ処理のため、auto-collectと同じ考え方で
        // AUTO_COLLECT_SECRETを流用して保護する(新しいシークレットを追加で
        // 設定する手間を増やさないため。定期実行はGitHub Actions等の外部
        // スケジューラからこのURLを1日1回呼び出す想定)。
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        const result = await runDailyLearning(learningDeps);
        res.writeHead(result.ok === false ? 200 : 200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }
      if (pathname === "/api/growth-log") {
        // ホーム画面の「昨日学んだこと」ウィジェット用。Upstash未設定・未実行の
        // 場合も、架空の数字を返さず正直な状態を返す(既存のhandleAccuracyStats
        // と同じ方針)。
        const result = await getGrowthLog(learningDeps);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
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
  console.log(`AI予測の記録(Upstash Redis): ${UPSTASH_ENABLED ? "あり" : "なし(.envのUPSTASH_REDIS_REST_URL/TOKENを設定してください)"}`);
});

module.exports = {
  server,
  handlePlayerSeasonStats,
  handleFixturesToday,
  handleFixtureAnalysis,
  handleAccuracyStats,
  handleAutoCollectPredictions,
  handlePredictMatch,
  handleDiscuss,
  getOrLogPrediction,
  resolvePrediction,
  outcomeFromScore,
  guessSeason,
  runDailyLearning,
  getGrowthLog,
  learningDeps,
  knowledgeStore,
  memoryStore,
  relationshipIndex,
};
