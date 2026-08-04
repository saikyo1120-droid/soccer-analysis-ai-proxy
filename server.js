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
const { createClubProfileEngine } = require("./knowledge/clubProfileEngine");
const { buildEvidencePool } = require("./reasoning/evidencePool");
const { assembleReasoning, formatReasoningForPrompt } = require("./reasoning/reasoningEngine");

// 毎日学習エンジン(Learning Engine)。実体は server/learning/dailyJob.js。
// 依存(callApiFootball/resolveTeamId/Upstashアクセス関数)は、このファイル自身が
// 定義した後にまとめて注入する(利用箇所は下の方の「Stage D」セクションを参照)。
const { runDailyLearning, getGrowthLog, getRecentFactsForTeam, computeFormScore } = require("./learning/dailyJob");
// 2026年8月・優先順位⑨: 「今日追加した知識0件」が正常な0件(前回から変化なし)
// なのか、異常な0件(未実行・キー未設定・予算切れ等)なのかを実データから判定する。
const { diagnoseZeroKnowledge, diagnoseZeroVerification, getRunHistory, buildEngineStatuses } = require("./learning/healthCheck");
// 2026年8月・完全自動Learning Cycle ⑧: 「本当に昨日より賢くなったのか」を数値で示す。
const { getMetricsTrend } = require("./learning/dailyMetrics");
// /debug診断ページが「毎日学習エンジンが対象にしている全クラブ」を横断して
// Knowledge Engine / Memory Engineの件数を集計するために使う一覧(新機能ではなく
// 既存のクラブ一覧を読み取り専用で再利用するだけ)。
const { REGISTERED_TEAMS } = require("./learning/registeredTeams");

// Prediction Engine v2(拡張特徴量)。/api/match-analysis(AIマッチ分析カード)が
// 「毎日学習エンジンが自動で立てる予測」とは別に、利用者が指定した任意の2クラブに
// ついて、その場で(オンデマンドで)同じロジックを使って分析するために使う。
const {
  computeGoalRateFeatures, computeFatigueFeature,
  fetchInjuryCountFeature, fetchStandingsFeature, fetchHeadToHeadFeature,
  inferLeagueIdFromFixtures, computeHomeAwaySplit, fetchCoachCareer,
  fetchLatestFormation, fetchTeamTopScorer,
} = require("./learning/features");
const {
  EXTENDED_DEFAULT_WEIGHTS, computeMatchFeatures, predictOutcomeV2,
  computeMatchProbabilities, mostLikelyScoreline, computeFactorImportance,
} = require("./learning/predictionModel");
// 選手個人の実データ統計(2026年8月・知識拡張フェーズ)。
const { computePlayerRealStats } = require("./learning/playerFeatures");
const { createPlayerProfileEngine } = require("./knowledge/playerProfileEngine");

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
// 2026年8月・本番で実際に発見されたバグの修正: 以前はキャッシュに「無い」場合も
// cacheGetがnullを返していたため、resolveTeamId/resolvePlayerIdが「本当に
// 見つからなかった」結果をcacheSet(key, null, ...)で意図的にキャッシュしても、
// 呼び出し側の`if (cached !== null) return cached;`という判定では「キャッシュに
// 無い(=null)」のか「キャッシュされた正しい結果がnullだった」のかを区別できず、
// 負のキャッシュが実質的に一度も機能していなかった(常にAPIへ再フェッチしていた)。
// 「エントリが無い」場合はundefinedを返すよう変更し、呼び出し側は`!== undefined`
// で判定することで、null自体を正しくキャッシュできるようにする。
const cache = new Map();
// /api/learning/run-daily をfire-and-forget化(下記参照)したことに伴う、
// 二重起動防止用のフラグ。
let dailyLearningRunning = false;
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { cache.delete(key); return undefined; }
  return hit.data;
}
function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// 2026年8月・本番調査で発見された不具合の修正(GitHub Actionsの手動実行が
// exit code 28(curlのタイムアウト)で7分前後失敗し続けた件): これまで
// fetch()の呼び出しには一切タイムアウトを設定していなかったため、外部API
// (サッカーデータAPI・Upstash・LLM)のどれか1つでも応答が返ってこない状態に
// 陥ると、そのリクエストは永遠に(Node/Renderがプロセスを強制終了するまで)
// 待ち続けてしまい、日次学習ジョブ全体がフリーズしてしまう構造的な弱点が
// あった。resolveTeamIdの再試行ロジック自体は正しく動作していても、個々の
// fetch呼び出しに時間の上限が無ければ「一時的な障害」を検知すること自体が
// できない。すべてのfetch呼び出しに明示的なタイムアウトを設け、外部APIが
// 応答しない場合は決められた時間で確実にエラーとして扱われるようにする
// (エラーになれば、既存の再試行・キャッシュしない、というロジックが正しく
// 機能する)。テスト・デバッグ用に環境変数で上限時間を上書きできるようにしておく
// (自動テストでは短い値に設定し、実際に何秒も待たずにタイムアウト動作を検証する)。
const API_FOOTBALL_TIMEOUT_MS = parseInt(process.env.API_FOOTBALL_TIMEOUT_MS, 10) || 20000;
const UPSTASH_TIMEOUT_MS = parseInt(process.env.UPSTASH_TIMEOUT_MS, 10) || 15000;
function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .catch((e) => {
      if (e && e.name === "AbortError") {
        const err = new Error(`リクエストがタイムアウトしました(${timeoutMs}ms): ${typeof url === "string" ? url : url.toString()}`);
        err.code = "TIMEOUT";
        throw err;
      }
      throw e;
    })
    .finally(() => clearTimeout(timer));
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
  const res = await fetchWithTimeout(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commandArray),
  }, UPSTASH_TIMEOUT_MS);
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

// ---- 2026年8月・優先順位⑪: 契約プランの自動判定 ----
// API-Footballの公式ドキュメント("HOW RATELIMIT WORKS")に記載されている
// レスポンスヘッダーから、そのAPIキーの実際の1日あたり上限と残量を読み取る。
//   x-ratelimit-requests-limit     … 契約プランの1日あたり上限(無料=100, Pro=7500 等)
//   x-ratelimit-requests-remaining … 本日の残り
// RapidAPI経由の場合はヘッダー名が異なる(x-ratelimit-requests-limit は同じだが
// 提供されないことがある)ため、取れなかった場合は正直にnullのままにする。
let lastRateLimit = { dailyLimit: null, remaining: null, observedAt: null };
function recordRateLimitHeaders(res) {
  try {
    if (!res || !res.headers || typeof res.headers.get !== "function") return;
    const limit = parseInt(res.headers.get("x-ratelimit-requests-limit"), 10);
    const remaining = parseInt(res.headers.get("x-ratelimit-requests-remaining"), 10);
    if (Number.isFinite(limit) && limit > 0) {
      lastRateLimit = {
        dailyLimit: limit,
        remaining: Number.isFinite(remaining) ? remaining : null,
        observedAt: new Date().toISOString(),
      };
    }
  } catch (e) { /* ヘッダーが読めなくても本処理は続行する(ベストエフォート) */ }
}
// 上限値から契約プラン名を推定する。API-Footballの公開価格表の数値に対応させる。
// 一致しない場合は推測でプラン名をでっち上げず、正直に「不明」と返す。
function planNameFromDailyLimit(limit) {
  if (!Number.isFinite(limit)) return null;
  if (limit <= 100) return "Free(無料)";
  if (limit <= 7500) return "Pro($19/月)";
  if (limit <= 75000) return "Ultra($29/月)";
  if (limit <= 150000) return "Mega($39/月)";
  return "Custom(カスタム)";
}
function getApiPlanInfo() {
  const detected = lastRateLimit.dailyLimit;
  return {
    detectedDailyLimit: detected,
    detectedRemaining: lastRateLimit.remaining,
    observedAt: lastRateLimit.observedAt,
    planNameJa: detected ? planNameFromDailyLimit(detected) : null,
    // 自動判定できていない場合に、なぜできていないのかを正直に伝える
    noteJa: detected
      ? "API-Footballのレスポンスヘッダーから実際の契約プランを自動判定しました。"
      : "まだAPI-Footballを1度も呼べていないため、契約プランを自動判定できていません(APIキー未設定、またはサーバー起動直後の可能性があります)。",
  };
}

// ---- 2026年8月: 日次学習ジョブの多重起動を防ぐロック ----
// プロセス内フラグ(dailyLearningRunning)は再デプロイ・スリープ復帰で失われるため、
// Upstash上に期限つきのロックを置いてプロセスをまたいで保護する。
// SET key value NX EX <秒> は「まだ無いときだけ書き込む」ため、
// これが失敗した=直近に別の実行が始まっている、と判断できる。
const DAILY_RUN_LOCK_SECONDS = Number(process.env.DAILY_RUN_LOCK_SECONDS) || 600; // 既定10分
async function tryAcquireDailyRunLock() {
  if (!UPSTASH_ENABLED) {
    // Upstashが無い環境では、従来どおりプロセス内フラグだけで保護する
    // (できないことを黙って「できたこと」にしない)。
    return { acquired: true, skipped: true, reasonJa: "Upstash未設定のため、プロセスをまたいだ多重起動の防止はできません。" };
  }
  try {
    const key = `learn:runlock:${new Date().toISOString().slice(0, 10)}`;
    const result = await upstashCmd(["SET", key, new Date().toISOString(), "NX", "EX", String(DAILY_RUN_LOCK_SECONDS)]);
    // Upstashは取得成功で "OK"、既に存在して書き込まなかった場合は null を返す
    return { acquired: result === "OK" || result === true, skipped: false };
  } catch (e) {
    // ロックの取得可否が判断できない場合は、学習が一切動かなくなる方が困るため
    // 実行を許可する(安全側=可用性優先)。
    return { acquired: true, skipped: true, reasonJa: `実行ロックを確認できませんでした(${e.message})。` };
  }
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

  const res = await fetchWithTimeout(url.toString(), { headers }, API_FOOTBALL_TIMEOUT_MS);
  // 2026年8月・優先順位⑪: API-Footballは全レスポンスに、そのAPIキーの
  // 「1日の上限」と「本日の残り」をヘッダーで返してくる。これを読んでおけば、
  // 契約プラン(無料100/日・Pro7500/日など)をアプリ自身が自動判定できるため、
  // 利用者がAPI_DAILY_BUDGETを手で設定する必要が無くなる(設定し忘れ・
  // 設定間違いによる予算超過事故を根本的に防げる)。
  recordRateLimitHeaders(res);
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
// 2026年8月・本番で実際に発生したバグの修正(team_not_found:Al-Nassr):
// 従来はAPI-Football呼び出しが「本当に該当チームが無かった(空の検索結果)」
// のか「一時的なネットワーク障害・API側のタイムアウトなどで例外が発生した」
// のかを区別せず、どちらもtry/catchでまとめてnullにして24時間キャッシュして
// いた。後者(一時的な障害)まで24時間「見つからなかった」ことにしてしまうと、
// 次にそのクラブを扱おうとする処理(毎日学習エンジン・議論エンジン等)が
// 丸1日ずっと失敗し続けることになる。この関数はその2つを明確に区別し、
// 「本当に見つからなかった場合」だけを(それでも24時間ではなく、日をまたげば
// 確実に再挑戦されるよう短めの)キャッシュ対象にし、「一時的な障害」の場合は
// 1回だけ短い間隔を空けて自動再試行したうえで、それでも失敗すればキャッシュ
// せずにnullを返す(次の呼び出しで再挑戦できるようにする)。
const TEAM_NOT_FOUND_CACHE_MS = 3 * 60 * 60 * 1000; // 3時間(以前は24時間固定だった)
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function searchTeamsWithRetry(name, attempts = 2, delayMs = 400) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await callApiFootball("/teams", { search: name });
      return { list: data.response || [], error: null };
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  return { list: [], error: lastError };
}

async function resolveTeamId(teamNameEnglish) {
  const name = (teamNameEnglish || "").trim();
  if (!name) return null;
  const cacheKey = `team-id:${name.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let list = [];
  let hadTransientError = false;

  const first = await searchTeamsWithRetry(name);
  list = first.list;
  if (!list.length && first.error) hadTransientError = true;

  // 実際に確認された不具合(team_not_found:Al-Nassr): API-Football側の表記が
  // ハイフンの有無で揺れている場合、検索文字列をそのまま渡すとヒットしない
  // ことがある。ハイフンを空白に置き換えた表記・完全に取り除いた表記でも
  // 追加で試す(既存の成功しているクラブの挙動には影響しない=最初の検索で
  // ヒットすればそのまま使うだけ)。
  if (!list.length && name.includes("-")) {
    const variants = [name.replace(/-/g, " "), name.replace(/-/g, "")];
    for (const variant of variants) {
      const retry = await searchTeamsWithRetry(variant);
      list = retry.list;
      if (list.length) { hadTransientError = false; break; }
      if (retry.error) hadTransientError = true;
    }
  }

  if (!list.length) {
    // 一時的な障害(例外)が原因で空だった場合は、キャッシュに残さず次回また
    // 挑戦できるようにする(=でっち上げの「見つからなかった」を記録しない)。
    if (!hadTransientError) cacheSet(cacheKey, null, TEAM_NOT_FOUND_CACHE_MS);
    return null;
  }
  const exact = list.find((r) => (r.team && r.team.name || "").toLowerCase() === name.toLowerCase());
  const id = (exact || list[0]).team.id;
  cacheSet(cacheKey, id, 30 * 24 * 60 * 60 * 1000);
  return id;
}

async function resolvePlayerId(name, teamHint, season, birthHint, teamEnglishHint) {
  const cacheKey = `resolve:${name}|${teamHint}|${season}|${birthHint || ""}|${teamEnglishHint || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

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

    // 2026年8月・知識拡張フェーズ: これまでは出場数・得点・アシスト・カードのみ
    // 抽出していたが、実はAPI-Footballの同じレスポンスにキーパス・パス成功率・
    // ドリブル成功率・守備指標・デュエル勝率も含まれていることが分かったため、
    // 追加のAPI呼び出し無しでそのまま抽出する(server/learning/playerFeatures.js)。
    const extendedStats = computePlayerRealStats(statsBlock) || {};
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
        // NEW(2026年8月): 実データのみ。取得できない項目はnull(捏造しない)。
        position: extendedStats.position,
        keyPasses: extendedStats.keyPasses,
        passAccuracyPct: extendedStats.passAccuracyPct,
        dribbleSuccessRatePct: extendedStats.dribbleSuccessRatePct,
        dribbleAttempts: extendedStats.dribbleAttempts,
        defensiveActions: extendedStats.defensiveActions,
        duelWinRatePct: extendedStats.duelWinRatePct,
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

// 2026年8月・優先順位⑤: 「今日の試合検索」で監督名からもチームを検索できる
// ようにするための軽量エンドポイント。今日の試合一覧に登場する全チーム(最大
// 160チーム分)の監督データを毎回先読みするとAPI予算(月間上限あり)を圧迫する
// ため、そうはせず、API-Football自身のサーバー側名前検索(/coachs?search=)を
// クエリが変わるたびオンデマンドで(フロントエンド側でデバウンスした上で)呼ぶ。
// 現所属チームが分かった監督だけを返し、実際にそのチームが今日の試合に含まれる
// かどうかの突き合わせはフロントエンド(mergeCoachMatchedFixtures)側で行う。
async function handleCoachSearch(query) {
  const name = String(query.get("name") || "").trim();
  if (!name || name.length < 2) return { status: 200, body: { found: false, coaches: [] } };

  const cacheKey = `coach-search:${name.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return { status: 200, body: cached };

  try {
    const data = await callApiFootball("/coachs", { search: name });
    const list = data.response || [];
    // API-Footballの/coachsは監督ごとにフラットな{name, photo, career:[...]}を返す
    // (server/learning/features.jsのcomputeCoachCareerで既に確認済みの実際のスキーマ。
    // ネストされた"coach"キーは無い)。career配列の中でendが無いエントリが在任中=現所属。
    const coaches = list
      .map((c) => {
        const career = Array.isArray(c.career) ? c.career : [];
        const current = career.find((entry) => entry && entry.team && !entry.end) || null;
        return {
          name: c.name || null,
          photo: c.photo || null,
          team: current && current.team ? current.team.name : null,
        };
      })
      .filter((c) => c.name && c.team); // 現所属が不明な監督は今日の試合検索には使えないため除外する
    const payload = { found: coaches.length > 0, coaches };
    cacheSet(cacheKey, payload, 60 * 60 * 1000); // 監督の異動は頻繁ではないため1時間キャッシュ
    return { status: 200, body: payload };
  } catch (e) {
    const payload = { found: false, reason: e.code || "error", error: e.message, coaches: [] };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    return { status: 200, body: payload };
  }
}

// Statuses API-Football uses to mark a fixture as fully finished (as opposed to
// not-yet-started, in-play, postponed, cancelled, etc.).
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);
// 2026年8月・優先順位④: 試合中(ライブ)のステータス一覧。フロントエンド
// (index.html)のFIXTURE_LIVE_STATUSESと意味を揃えてある。
const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);

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

    if (!FINISHED_STATUSES.has(statusShort) && !LIVE_STATUSES.has(statusShort)) {
      // Not started yet (also covers postponed/cancelled/etc.) — no real
      // in-match or post-match data exists yet, so there is nothing more to
      // fetch from API-Football here. The frontend builds the pre-match preview
      // itself (using our own registered player database for either club, if we
      // have one registered) since there's no reliable real "predicted lineup"
      // feed. We DO, however, log AI-Football's real prediction percentages here
      // so that once this match finishes we can honestly verify whether the
      // AI's prediction was correct (see "AI予測の「本物の記録」システム" above).
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

    // 試合中・終了後のどちらも、選手の実評価・実際のイベント(得点・カード等)を
    // 取得する処理は共通(API-Footballは試合中でも部分的な実データを返す)。
    // 2026年8月・優先順位④: 以前は「終了」扱いの場合のみこの実データ取得を行い、
    // 試合中は「これから」と同じ(予想のみ)扱いだった。これを改め、試合中は
    // その時点までの実際の得点・イベント・出場選手の評価を見られるようにする。
    const isFinished = FINISHED_STATUSES.has(statusShort);
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

    if (!isFinished) {
      // 試合中: あくまで「今まさに分かっている実データ」であり、最終結果では
      // ないため、AI予測の答え合わせ(resolvePrediction)はまだ行わない。
      // 状況が刻々と変わるため、キャッシュも60秒と短くする。
      const payload = {
        ...base,
        phase: "live",
        homePlayers,
        awayPlayers,
        events,
        elapsed: entry.fixture.status ? entry.fixture.status.elapsed : null,
      };
      cacheSet(cacheKey, payload, 60 * 1000);
      return { status: 200, body: payload };
    }

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
  // Knowledge Engine Layer2(固定知識の自動生成)・Layer3(AIの毎日の見解)は
  // LLMを使う。未設定(APIキー無し)の環境でも安全に動く(dailyJob.js側で
  // generateLLMが無い場合は正直にスキップし、llmSkippedReasonsに記録する)。
  generateLLM,
  // 2026年8月・優先順位⑪: 契約プランの1日あたり上限を自動判定するための関数。
  // これを渡しておくと、日次ジョブがAPI_DAILY_BUDGETの手動設定に頼らず、
  // 実際の契約プランに合わせて自動的に予算を決められる。
  getApiPlanInfo,
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

// ---- 2026年8月・知識拡張フェーズ: クラブ/選手のLayer2固定知識を「議論モードで
// 実際に質問されたとき」にもオンデマンドで生成・キャッシュできるようにする
// (これまでは毎日学習エンジンの登録11クラブ限定だった。RAG経路にも同じ
// エンジンを共有することで、"主要リーグ全クラブ・全選手"に対応する現実的な
// 方法として、質問されたクラブ・選手から知識が蓄積されていく設計にする)。
const clubProfileEngine = createClubProfileEngine({
  generateLLM, knowledgeStore, setRelation: relationshipIndex.setRelation,
});
const playerProfileEngine = createPlayerProfileEngine({
  generateLLM, knowledgeStore, setRelation: relationshipIndex.setRelation,
  // 選手は登録クラブのような固定リストが無い(オンデマンドで増えていく)ため、
  // 「累計で何人の選手について知識を持つようになったか」を/api/debug-statusで
  // 可視化できるよう、軽量なカウンターだけ別途記録する。
  onProfileGenerated: () => {
    if (UPSTASH_ENABLED) upstashCmd(["INCR", "knowledge:trackedPlayerProfiles"]).catch(() => {});
  },
});

const knowledgeSource = createKnowledgeSource({
  callApiFootball, resolveTeamId, guessSeason,
  getRecentFacts: (teamNameEnglish) => getRecentFactsForTeam(learningDeps, teamNameEnglish),
  getActiveKnowledge: (teamNameEnglish) => knowledgeStore.getActiveKnowledge(teamNameEnglish),
  setRelation: (...args) => relationshipIndex.setRelation(...args),
  ensureClubProfile: (...args) => clubProfileEngine.ensureClubProfile(...args),
  fetchCoachCareer: (...args) => fetchCoachCareer(...args),
  saveKnowledgeItem: (...args) => knowledgeStore.saveKnowledgeItem(...args),
  // 2026年8月・「議論できるAI」強化フェーズ(ご要望③): Reasoning Engineが
  // 「順位・置かれた状況」の仮説を実データで裏付けられるように、Prediction
  // Engine v2で既に使っているのと同じ実データ取得関数をそのまま注入する
  // (新しいAPI呼び出しロジックを増やさず、既存の信頼できる関数を再利用)。
  fetchStandingsFeature: (...args) => fetchStandingsFeature(...args),
  inferLeagueIdFromFixtures: (...args) => inferLeagueIdFromFixtures(...args),
});

// ============================================================
// 「AIマッチ分析」カード ― /api/match-analysis
// ============================================================
// ご要望(第一段階の最後の項目): 「試合予想では単なる勝敗ではなく、AIが試合を
// 読むようにしてください」への回答。毎日学習エンジン(dailyJob.js)が登録クラブの
// “次の試合”について自動で行っている予測ロジック(Prediction Engine v2 =
// server/learning/predictionModel.js + server/learning/features.js)を、この
// エンドポイントでは「利用者が指定した任意の2クラブ」に対して、その場
// (オンデマンド)で同じロジックを使って実行する。
//
// 正直な設計上の注意点:
//   ①この分析は毎日学習エンジンの自動予測ループ(learn:ownpred:*)とは独立している。
//     つまりこのエンドポイントを呼んでも学習データとしては記録されない(実際の
//     試合結果と突き合わせて「当たったか」を検証できるのは、あくまで毎日学習
//     エンジンが自動登録した“実際の次の試合”に対する予測だけ)。任意の2クラブの
//     組み合わせ(まだ対戦カードが組まれていない場合など)は「検証しようがない」
//     ため、この区別は意図的なもの。
//   ②怪我人・順位・過去対戦などはAPI-Footballの実データ、確率(勝率)はポワソン
//     分布に基づく計算、重要度(★)は学習済みの重み(learn:weights、無ければ既定値)
//     に基づく――すべて実データ・実計算であり、LLMは「試合展開の文章化」だけを
//     担当する(数字自体はLLMに作らせない。既存の議論モードと同じ設計方針)。
async function resolveMatchTeamLabel(nameRaw) {
  const raw = String(nameRaw || "").trim();
  const hit = REGISTERED_TEAMS.find(
    (t) => t.nameJa === raw || t.nameEn.toLowerCase() === raw.toLowerCase()
  );
  return hit ? { nameEn: hit.nameEn, nameJa: hit.nameJa } : { nameEn: raw, nameJa: raw };
}

async function gatherTeamMatchContext(teamId, nowMs) {
  const data = await callApiFootball("/fixtures", { team: teamId, last: 10 });
  const fixtures = (data && data.response) || [];
  const form = computeFormScore(fixtures, teamId);
  const goalRates = computeGoalRateFeatures(fixtures, teamId);
  const fatigue = computeFatigueFeature(fixtures, nowMs);
  return { teamId, fixtures, ...form, ...goalRates, ...fatigue };
}

function starsDisplay(stars) {
  const s = Math.max(0, Math.min(5, stars || 0));
  return "★".repeat(s) + "☆".repeat(5 - s);
}

async function handleMatchAnalysis(query, clientIp) {
  const homeRaw = (query.get("home") || "").trim();
  const awayRaw = (query.get("away") || "").trim();
  if (!homeRaw || !awayRaw) return { status: 400, body: { ok: false, error: "home and away (club name) are required" } };
  if (homeRaw.toLowerCase() === awayRaw.toLowerCase()) return { status: 400, body: { ok: false, error: "home and away must be different clubs" } };

  const [home, away] = await Promise.all([resolveMatchTeamLabel(homeRaw), resolveMatchTeamLabel(awayRaw)]);

  let homeTeamId, awayTeamId;
  try {
    [homeTeamId, awayTeamId] = await Promise.all([resolveTeamId(home.nameEn), resolveTeamId(away.nameEn)]);
  } catch (e) {
    return { status: 200, body: { ok: false, reason: "team_lookup_failed", message: e.message } };
  }
  if (!homeTeamId || !awayTeamId) {
    return {
      status: 200,
      body: {
        ok: false, reason: "team_not_found",
        message: `クラブが特定できませんでした(${!homeTeamId ? home.nameJa : away.nameJa})。クラブ名の表記をご確認ください。`,
      },
    };
  }

  const nowMs = Date.now();
  let homeForm, awayForm;
  try {
    [homeForm, awayForm] = await Promise.all([
      gatherTeamMatchContext(homeTeamId, nowMs),
      gatherTeamMatchContext(awayTeamId, nowMs),
    ]);
  } catch (e) {
    return { status: 200, body: { ok: false, reason: "fixtures_fetch_failed", message: e.message } };
  }

  const season = guessSeason();
  // 2026年8月・本番監査での修正: 以前はhomeとawayで同じ1つのleagueIdを使い
  // 回していたため、両クラブが異なるリーグ所属の場合(例: セリエAのナポリ
  // vs ラ・リーガのバルセロナ)、アウェイ側の順位が誤ったリーグで検索され
  // 「見つからない」扱いになっていた。それぞれ自分自身のfixturesから
  // 推定したリーグIDを使うよう分離する。
  const homeLeagueId = inferLeagueIdFromFixtures(homeForm.fixtures);
  const awayLeagueId = inferLeagueIdFromFixtures(awayForm.fixtures);
  const [homeInjuries, awayInjuries, homeStandings, awayStandings, h2h, homeFormationInfo, awayFormationInfo, homeTopScorerInfo, awayTopScorerInfo] = await Promise.all([
    fetchInjuryCountFeature(homeTeamId, season, callApiFootball),
    fetchInjuryCountFeature(awayTeamId, season, callApiFootball),
    fetchStandingsFeature(homeLeagueId, season, homeTeamId, callApiFootball),
    fetchStandingsFeature(awayLeagueId, season, awayTeamId, callApiFootball),
    fetchHeadToHeadFeature(homeTeamId, awayTeamId, callApiFootball),
    // 2026年8月・本番監査(⑦情報拡張)対応: 「フォーメーション相性」「勝敗を
    // 左右する選手」への追加。いずれも実データのみ(取得できなければnull)。
    fetchLatestFormation(homeForm.fixtures, homeTeamId, callApiFootball),
    fetchLatestFormation(awayForm.fixtures, awayTeamId, callApiFootball),
    fetchTeamTopScorer(homeLeagueId, season, homeTeamId, callApiFootball),
    fetchTeamTopScorer(awayLeagueId, season, awayTeamId, callApiFootball),
  ]);

  const dataNotes = [];
  if (!homeLeagueId) dataNotes.push(`${home.nameJa}のリーグIDを特定できなかったため、順位・得点ランキングデータは考慮されていません。`);
  if (!awayLeagueId) dataNotes.push(`${away.nameJa}のリーグIDを特定できなかったため、順位・得点ランキングデータは考慮されていません。`);
  if (homeInjuries.error) dataNotes.push(`${home.nameJa}の負傷者情報の取得に失敗しました。`);
  if (awayInjuries.error) dataNotes.push(`${away.nameJa}の負傷者情報の取得に失敗しました。`);
  if (h2h.sampleSize === 0) dataNotes.push("過去の直接対戦データが見つかりませんでした。");
  if (!homeFormationInfo.formation) dataNotes.push(`${home.nameJa}の直近フォーメーション情報は取得できませんでした。`);
  if (!awayFormationInfo.formation) dataNotes.push(`${away.nameJa}の直近フォーメーション情報は取得できませんでした。`);

  const homeCtx = {
    formScore: homeForm.currentFormScore, avgGoalsFor: homeForm.avgGoalsFor, avgGoalsAgainst: homeForm.avgGoalsAgainst,
    injuryCount: homeInjuries.injuryCount, pointsPerGame: homeStandings.played ? (homeStandings.points / homeStandings.played) : null,
    matchesLast7Days: homeForm.matchesLast7Days,
  };
  const awayCtx = {
    formScore: awayForm.currentFormScore, avgGoalsFor: awayForm.avgGoalsFor, avgGoalsAgainst: awayForm.avgGoalsAgainst,
    injuryCount: awayInjuries.injuryCount, pointsPerGame: awayStandings.played ? (awayStandings.points / awayStandings.played) : null,
    matchesLast7Days: awayForm.matchesLast7Days,
  };
  const features = computeMatchFeatures(homeCtx, awayCtx, h2h);

  let weights = EXTENDED_DEFAULT_WEIGHTS;
  if (UPSTASH_ENABLED) {
    try {
      const stored = await upstashGetJSON("learn:weights");
      if (stored) weights = { ...EXTENDED_DEFAULT_WEIGHTS, ...stored };
    } catch (e) { /* ベストエフォート: 取得失敗時は既定重みを使う */ }
  }

  const { homeLambda, awayLambda, predictedWinner } = predictOutcomeV2(features, weights);
  const winProbability = computeMatchProbabilities(homeLambda, awayLambda);
  const predictedScoreline = mostLikelyScoreline(homeLambda, awayLambda);
  const importanceRaw = computeFactorImportance(features, weights);
  const totalContribution = importanceRaw.reduce((s, i) => s + i.contribution, 0) || 1;
  const keyFactors = importanceRaw.map((i) => ({
    key: i.key, labelJa: i.labelJa, stars: i.stars, starsDisplay: starsDisplay(i.stars),
    weightPct: Math.round((i.contribution / totalContribution) * 1000) / 10,
  }));
  const topFactor = keyFactors.find((f) => f.stars > 0) || null;

  const winnerLabelJa = predictedWinner === "home" ? home.nameJa : predictedWinner === "away" ? away.nameJa : null;
  const confidenceStars = Math.max(1, Math.min(5, Math.round(Math.max(winProbability.homeWinPct, winProbability.drawPct, winProbability.awayWinPct) / 20)));

  // ---- 決定論的な(LLMを使わない)フォールバック用の試合展開予想・逆シナリオ ----
  // 実データ(疲労・怪我人・順位・過去対戦)から機械的に文章を組み立てる。
  // LLM未設定/予算超過の場合でも「試合を読む」機能自体は動く(正直な設計)。
  function buildDeterministicNarrative() {
    const parts = [];
    if (topFactor) parts.push(`AIが最も重視したのは「${topFactor.labelJa}」です(寄与度${topFactor.weightPct}%)。`);
    if (homeForm.matchesLast7Days >= 3) parts.push(`${home.nameJa}は直近7日間で${homeForm.matchesLast7Days}試合とやや過密日程です。`);
    if (awayForm.matchesLast7Days >= 3) parts.push(`${away.nameJa}は直近7日間で${awayForm.matchesLast7Days}試合とやや過密日程です。`);
    const homeInjuredNames = (homeInjuries.injuredPlayers || []).slice(0, 3).join("・");
    const awayInjuredNames = (awayInjuries.injuredPlayers || []).slice(0, 3).join("・");
    if (homeInjuries.injuryCount) parts.push(`${home.nameJa}には現在${homeInjuries.injuryCount}名の負傷・出場停止者がいます${homeInjuredNames ? `(${homeInjuredNames}等)` : ""}。`);
    if (awayInjuries.injuryCount) parts.push(`${away.nameJa}には現在${awayInjuries.injuryCount}名の負傷・出場停止者がいます${awayInjuredNames ? `(${awayInjuredNames}等)` : ""}。`);
    if (homeFormationInfo.formation && awayFormationInfo.formation) parts.push(`直近の採用フォーメーションは${home.nameJa}が${homeFormationInfo.formation}、${away.nameJa}が${awayFormationInfo.formation}です。`);
    if (homeTopScorerInfo.player) parts.push(`${home.nameJa}は${homeTopScorerInfo.player.name}(今季${homeTopScorerInfo.player.goals}得点)の得点力に注目です。`);
    if (awayTopScorerInfo.player) parts.push(`${away.nameJa}は${awayTopScorerInfo.player.name}(今季${awayTopScorerInfo.player.goals}得点)の得点力に注目です。`);
    parts.push(winnerLabelJa ? `総合的に見て${winnerLabelJa}がやや優位という予想です。` : "両者の実力は拮抗しており、僅差の展開が予想されます。");
    return parts.join(" ");
  }
  function buildDeterministicReverseScenario() {
    const underdog = predictedWinner === "home" ? away.nameJa : predictedWinner === "home" ? null : predictedWinner === "away" ? home.nameJa : null;
    if (!underdog) return "両者拮抗のため、わずかなミス・セットプレー・退場者の有無などで試合展開が大きく変わり得ます。";
    return `もし${underdog}が試合序盤を無失点で乗り切れれば、${h2h.sampleSize ? "過去の対戦成績も踏まえ、" : ""}終盤にかけて流れが変わる可能性があります。`;
  }
  // 2026年8月・「議論できるAI」強化フェーズ(ご要望⑥・⑦戦術相性): フォーメーション
  // 単体の並記だけでは「相性」の判断になっていなかった(正直なギャップ)。
  // 両フォーメーションが揃っている場合のみ、素朴な戦術知識(サイドの数的優位・
  // 中盤の枚数差)から相性の見立てを機械的に組み立てる。これはAPI-Footballの
  // 実データそのものではなく「AIの見解」であるため、必ずその旨を明示する。
  function buildDeterministicTacticalCompatibility() {
    const hf = homeFormationInfo.formation;
    const af = awayFormationInfo.formation;
    if (!hf || !af) return "両クラブの直近フォーメーションが揃わなかったため、戦術相性の見立ては省略します。";
    const wingCount = (f) => { const parts = String(f).split("-").map((n) => parseInt(n, 10)); return parts.length >= 3 ? (parts[1] || 0) : 0; };
    const midCount = (f) => { const parts = String(f).split("-").map((n) => parseInt(n, 10)); return parts.length >= 3 ? parts.slice(1, parts.length - 1).reduce((s, n) => s + n, 0) : 0; };
    const backCount = (f) => { const parts = String(f).split("-").map((n) => parseInt(n, 10)); return parts[0] || 0; };
    const hMid = midCount(hf), aMid = midCount(af);
    const hBack = backCount(hf), aBack = backCount(af);
    if (hMid !== aMid) {
      const stronger = hMid > aMid ? home.nameJa : away.nameJa;
      const weaker = hMid > aMid ? away.nameJa : home.nameJa;
      return `${home.nameJa}(${hf}) vs ${away.nameJa}(${af}): 中盤の人数は${stronger}が上回っており(${Math.max(hMid, aMid)}人 対 ${Math.min(hMid, aMid)}人)、${weaker}は中盤でボールを奪われやすくなる可能性があります(AI見解・フォーメーション上の一般論に基づく簡易的な見立てです)。`;
    }
    if (hBack !== aBack) {
      return `${home.nameJa}(${hf}) vs ${away.nameJa}(${af}): 最終ラインの人数が異なるため(${hBack}枚 対 ${aBack}枚)、少ない方は裏のスペースを使われるリスクがあります(AI見解・簡易的な見立てです)。`;
    }
    return `${home.nameJa}(${hf}) vs ${away.nameJa}(${af}): 両者とも似た構造のフォーメーションのため、個々の選手の質やコンディションが試合の分かれ目になりそうです(AI見解・簡易的な見立てです)。`;
  }
  // ⑩この試合最大の見どころ: 実データの中から最も「話題性」が高そうな1点を
  // 機械的に選ぶ(でっち上げず、実際に取得できたデータの中から選ぶだけ)。
  function buildDeterministicBiggestHighlight() {
    const candidates = [];
    if (h2h.sampleSize >= 3) candidates.push({ score: h2h.sampleSize, text: `過去${h2h.sampleSize}試合の直接対戦成績(${home.nameJa}${h2h.homeSideWins}勝-${h2h.draws}分-${h2h.awaySideWins}勝${away.nameJa})が、今回もどちらに転ぶか。` });
    if (homeTopScorerInfo.player && awayTopScorerInfo.player) candidates.push({ score: 5, text: `両チームの得点源、${homeTopScorerInfo.player.name}(今季${homeTopScorerInfo.player.goals}得点)と${awayTopScorerInfo.player.name}(今季${awayTopScorerInfo.player.goals}得点)、どちらが仕事をするか。` });
    if ((homeInjuries.injuryCount || 0) + (awayInjuries.injuryCount || 0) >= 3) candidates.push({ score: 4, text: `両クラブ合わせて${(homeInjuries.injuryCount || 0) + (awayInjuries.injuryCount || 0)}名の負傷・出場停止者を抱える中、主力不在の穴をどう埋めるか。` });
    if (homeStandings.position && awayStandings.position) candidates.push({ score: 3, text: `${homeStandings.position}位の${home.nameJa}と${awayStandings.position}位の${away.nameJa}、順位差を覆せるか。` });
    if (!candidates.length) return topFactor ? `AIが最も重視した「${topFactor.labelJa}」の差が、実際の試合でどう出るか。` : "両者拮抗のカードで、僅かな差がどちらに転ぶか。";
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }

  let narrative = { text: buildDeterministicNarrative(), source: "deterministic" };
  let reverseScenario = { text: buildDeterministicReverseScenario(), source: "deterministic" };
  let tacticalCompatibility = { text: buildDeterministicTacticalCompatibility(), source: "deterministic" };
  let biggestHighlight = { text: buildDeterministicBiggestHighlight(), source: "deterministic" };

  if (typeof generateLLM === "function" && tryConsumeLlmBudgetForIp(clientIp) && tryConsumeLlmBudget()) {
    try {
      const systemPrompt = [
        "あなたはサッカーの試合展開を予想するアナリストAIです。",
        "与えられた実データ・計算済みの数値だけを根拠にしてください。数字を新しく作らないでください。",
        "出力は次のJSON形式のみ: {\"narrative\": \"...\", \"reverseScenario\": \"...\", \"tacticalCompatibility\": \"...\", \"biggestHighlight\": \"...\"}",
        "narrativeは試合展開の予想を100〜160文字程度の日本語で。reverseScenarioは予想が外れる場合の代替シナリオを80〜140文字程度の日本語で。",
        "tacticalCompatibilityは両者のフォーメーション・戦術面の相性についての見立てを80〜140文字程度の日本語で(あなたの見解であることが伝わる書き方をしてください)。",
        "biggestHighlightはこの試合で最も注目すべき1点を60〜100文字程度の日本語で、断定的に1つだけ挙げてください。",
      ].join("\n");
      const userPrompt = [
        `${home.nameJa}(ホーム) vs ${away.nameJa}(アウェイ)`,
        `AI勝率: ${home.nameJa}${winProbability.homeWinPct}% / 引き分け${winProbability.drawPct}% / ${away.nameJa}${winProbability.awayWinPct}%`,
        `予想スコア: ${predictedScoreline}`,
        `重要度が高い要素: ${keyFactors.filter((f) => f.stars > 0).map((f) => `${f.labelJa}(${f.starsDisplay})`).join("、") || "(まだ強く学習された要素はありません)"}`,
        `${home.nameJa}: 直近7日${homeForm.matchesLast7Days}試合、負傷者${homeInjuries.injuryCount ?? "不明"}名${(homeInjuries.injuredPlayers || []).length ? `(${homeInjuries.injuredPlayers.slice(0, 3).join("・")}等)` : ""}、順位${homeStandings.position ?? "不明"}位、フォーメーション${homeFormationInfo.formation || "不明"}、注目選手${homeTopScorerInfo.player ? `${homeTopScorerInfo.player.name}(今季${homeTopScorerInfo.player.goals}得点)` : "特になし"}`,
        `${away.nameJa}: 直近7日${awayForm.matchesLast7Days}試合、負傷者${awayInjuries.injuryCount ?? "不明"}名${(awayInjuries.injuredPlayers || []).length ? `(${awayInjuries.injuredPlayers.slice(0, 3).join("・")}等)` : ""}、順位${awayStandings.position ?? "不明"}位、フォーメーション${awayFormationInfo.formation || "不明"}、注目選手${awayTopScorerInfo.player ? `${awayTopScorerInfo.player.name}(今季${awayTopScorerInfo.player.goals}得点)` : "特になし"}`,
        `過去対戦: ${h2h.sampleSize}試合中 ${home.nameJa}側${h2h.homeSideWins}勝 ${away.nameJa}側${h2h.awaySideWins}勝 ${h2h.draws}分`,
      ].join("\n");
      const { text } = await generateLLM({ systemPrompt, userPrompt, maxTokens: 500 });
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed.narrative) narrative = { text: String(parsed.narrative).slice(0, 400), source: "ai_generated" };
        if (parsed.reverseScenario) reverseScenario = { text: String(parsed.reverseScenario).slice(0, 400), source: "ai_generated" };
        if (parsed.tacticalCompatibility) tacticalCompatibility = { text: String(parsed.tacticalCompatibility).slice(0, 400), source: "ai_generated" };
        if (parsed.biggestHighlight) biggestHighlight = { text: String(parsed.biggestHighlight).slice(0, 300), source: "ai_generated" };
      }
    } catch (e) {
      console.error("[match-analysis] generateLLM failed, falling back to deterministic narrative:", e.code || "(no code)", "-", e.message);
      // フォールバック(上で既に決定論的な文章をセット済み)のまま続行する。
    }
  }

  // 2026年8月・本番監査で発見・修正: 以前は「予想勝者」(勝率の内訳から判定)と
  // 「最も可能性の高い1点刻みのスコア」(ポワソン分布の格子上の最頻値)を
  // 単純に組み合わせていたため、「1-1でナポリの勝利」のような自己矛盾した
  // 文章になることがあった(ポワソン分布モデルの性質上、優勢な側がいても
  // 単独最頻値スコアが引き分けスコアになることは普通に起こる)。実際に発生を
  // 確認したため、スコアが引き分け目の場合は「優勢だが接戦」という正直な
  // 表現に分ける。
  const [scoreHomeGoals, scoreAwayGoals] = predictedScoreline.split("-").map((n) => parseInt(n, 10));
  const scorelineIsDraw = scoreHomeGoals === scoreAwayGoals;
  const conclusion = winnerLabelJa
    ? (scorelineIsDraw
        ? `AIは${winnerLabelJa}がやや優勢と予想しますが、最も可能性が高い正確なスコアは${predictedScoreline}の接戦です。`
        : `AIは${predictedScoreline}で${winnerLabelJa}の勝利と予想します。`)
    : `AIは${predictedScoreline}の引き分けに近い、拮抗した試合と予想します。`;

  // 2026年8月・本番監査(⑦情報拡張)対応: 「怪我人の影響」「フォーメーション
  // 相性」「勝敗を左右する選手」。すべて実データのみ(取得できない場合は
  // 正直にnull/空配列を返し、AIが作った文章では埋めない)。
  const injuries = {
    home: { count: homeInjuries.injuryCount ?? null, injured: homeInjuries.injuredPlayers || [], suspended: homeInjuries.suspendedPlayers || [] },
    away: { count: awayInjuries.injuryCount ?? null, injured: awayInjuries.injuredPlayers || [], suspended: awayInjuries.suspendedPlayers || [] },
  };
  const formation = {
    home: homeFormationInfo.formation || null,
    away: awayFormationInfo.formation || null,
    note: (homeFormationInfo.formation && awayFormationInfo.formation)
      ? `直近の実試合で採用したフォーメーション(${home.nameJa}: ${homeFormationInfo.formation} ・ ${away.nameJa}: ${awayFormationInfo.formation})です。次の試合の先発フォーメーションは試合直前まで確定しないため、参考値としてご覧ください。`
      : "直近試合のフォーメーションを一部取得できませんでした。",
  };
  const keyPlayers = {
    home: homeTopScorerInfo.player ? { ...homeTopScorerInfo.player, note: "今シーズンの得点ランキング上位選手(実データ)" } : null,
    away: awayTopScorerInfo.player ? { ...awayTopScorerInfo.player, note: "今シーズンの得点ランキング上位選手(実データ)" } : null,
  };

  return {
    status: 200,
    body: {
      ok: true,
      home, away,
      winProbability: { ...winProbability, confidenceStars, confidenceStarsDisplay: starsDisplay(confidenceStars) },
      predictedScoreline,
      keyFactors,
      mostImportantFactor: topFactor ? topFactor.labelJa : "(まだ強く学習された要素はありません)",
      narrative, reverseScenario, conclusion,
      // 2026年8月・「議論できるAI」強化フェーズ(ご要望⑥): ⑦戦術相性の明示的な
      // 見立てと、⑩この試合最大の見どころ。11項目のうち、④鍵になる時間帯だけは
      // 現時点で正直に未実装(README「AIマッチ分析の11項目」参照: /fixtures/events
      // をこのオンデマンドAPI呼び出し内で全クラブ分取得するとAPI-Football無料枠
      // (1日100リクエスト)を容易に超えるため、理由と代替案を明記した上で見送り)。
      tacticalCompatibility, biggestHighlight,
      injuries, formation, keyPlayers,
      featuresUsed: features,
      weightsInfo: { version: weights.version || 0, updatedAt: weights.updatedAt || null },
      dataNotes,
      note: "この分析は毎日学習エンジンの自動予測ループとは独立した、都度(オンデマンド)分析です。実際の試合結果との答え合わせ・学習は毎日学習エンジンが自動登録した予測に対してのみ行われます。",
      generatedAt: new Date().toISOString(),
    },
  };
}

// ---- 開発者向け自己診断ページ(/debug.html)用のデータ集計 ----
// 目的: 「コード上は実装されている」ではなく「本番で実際に動いているか」を、
// 実際にRedis/API-Footballへ接続確認しに行った上で開発者(Sai)自身が一目で
// 確認できるようにする。一般利用者向けの新しいAI機能ではなく、既存の各エンジンの
// 状態を読み取り専用で可視化するだけの運用ツール。
// AUTO_COLLECT_SECRETが設定されている場合、そのキー一致を要求する(内部の
// 学習件数・知識件数などをむやみに一般公開しないため。既存のrun-daily/
// auto-collectエンドポイントと同じ保護パターン)。
/**
 * 2026年8月・優先順位⑨「Learning Engineを総点検してください」。
 *
 * ご要望の「GitHub Actions / cron / Render / Upstash / Prediction / Learning /
 * Knowledge / Memory / Hypothesis すべてログを確認し、毎日正常に動くことを
 * 実証してください」に対する回答となるエンドポイント。
 *
 * 私(AI)からはGitHub ActionsやRenderの管理画面へ直接ログインできないため、
 * 「私が確認しました」で終わらせずに、アプリ自身が毎日の実行ログを実データとして
 * 読み出し、Saiさん自身がいつでも確認できる形にしています。
 * 過去N日分の実行履歴(learn:growthlog:YYYY-MM-DD)がそのまま
 * 「毎日動いている/動いていない」の証拠になります(欠けている日は推測で
 * 埋めず、正直に「実行記録なし」と表示します)。
 *
 * このエンドポイントは一般利用者にも見せる前提です(AIの健全性を隠さない方針)が、
 * debug-statusのような内部件数の詳細までは返しません。
 */
async function handleLearningHealth(searchParams) {
  const generatedAt = new Date().toISOString();
  const days = Math.max(1, Math.min(60, parseInt((searchParams && searchParams.get("days")) || "14", 10) || 14));
  const growthLog = await getGrowthLog(learningDeps).catch(() => ({ ranYet: false }));
  const todayDateKey = new Date().toISOString().slice(0, 10);
  const runHistory = await getRunHistory(learningDeps, days, todayDateKey).catch(() => ({ available: false, reasonJa: "実行履歴の読み出しに失敗しました。", days: [] }));

  const metricsTrend = await getMetricsTrend(learningDeps, 7, todayDateKey).catch(() => null);
  const zeroKnowledge = diagnoseZeroKnowledge(growthLog);
  const zeroVerification = diagnoseZeroVerification(growthLog);
  const engines = buildEngineStatuses({
    growthLog,
    runHistory,
    upstashEnabled: UPSTASH_ENABLED,
    apiKeyConfigured: !!API_KEY,
    llmConfigured: !!process.env.ANTHROPIC_API_KEY,
    engineTotals: growthLog.engineTotals,
    // 優先順位⑪: 契約プランと、現在の設定値。有料プラン向けの設定のまま
    // 無料プランへ戻ってしまった場合を検出するために両方を渡す。
    apiPlan: getApiPlanInfo(),
    configuredCaps: {
      playerUpdateCap: Number(process.env.PLAYER_UPDATE_CAP) || null,
      extendedLeagueCap: Number(process.env.EXTENDED_LEAGUE_CAP) || null,
    },
  });

  const errorCount = engines.filter((e) => e.status === "error").length;
  const warnCount = engines.filter((e) => e.status === "warn").length;
  const overall = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";
  const overallMessageJa = errorCount > 0
    ? `${errorCount}件の重大な問題が見つかりました(下の一覧の❌印を確認してください)。`
    : warnCount > 0
      ? `重大な問題はありませんが、${warnCount}件の注意点があります。`
      : "すべての構成要素が正常に動作しています。";

  return {
    status: 200,
    body: {
      ok: true, generatedAt, overall, overallMessageJa,
      zeroKnowledge, zeroVerification, engines, runHistory,
      // 2026年8月: 「昨日より賢くなったか」を数値の差分で示す(⑧のご要望)。
      growthComparison: metricsTrend ? metricsTrend.comparison : null,
      metricsAvailable: !!(metricsTrend && metricsTrend.available),
      apiBudget: growthLog.apiBudget || null,
      // 2026年8月・優先順位⑪: 現在の契約プランの自動判定結果。
      // 「Proに加入したはずだが本当に反映されているか」をこの画面だけで確認できる。
      apiPlan: getApiPlanInfo(),
      // 2026年8月: 「Renderの環境変数をちゃんと設定できたのか」を、
      // Renderの管理画面を開かなくてもこの画面だけで確認できるようにする。
      // 環境変数は一度設定すれば再デプロイしても保持されるため、設定作業は1回だけ。
      settings: {
        extendedLeagueCap: Number(process.env.EXTENDED_LEAGUE_CAP) || null,
        playerUpdateCap: Number(process.env.PLAYER_UPDATE_CAP) || null,
        apiDailyBudgetManual: Number(process.env.API_DAILY_BUDGET) || null,
        noteJa: (Number(process.env.EXTENDED_LEAGUE_CAP) && Number(process.env.PLAYER_UPDATE_CAP))
          ? `有料プラン向けの設定が反映されています(拡張リーグ${process.env.EXTENDED_LEAGUE_CAP}件/日・選手${process.env.PLAYER_UPDATE_CAP}名/日)。追加の設定作業は不要です。`
          : "Render側の環境変数 EXTENDED_LEAGUE_CAP / PLAYER_UPDATE_CAP がまだ設定されていません(未設定の場合は無料プラン向けの既定値、拡張リーグ2件・選手3名で動作します)。設定は1回だけで、以後は再デプロイしても保持されます。",
      },
    },
  };
}

async function handleDebugStatus() {
  const generatedAt = new Date().toISOString();

  // ---- Redis(Upstash)への実接続確認(設定の有無だけでなく、実際にPINGが通るか) ----
  const redisInfo = { configured: UPSTASH_ENABLED, reachable: false, error: null };
  if (UPSTASH_ENABLED) {
    try {
      const pong = await upstashCmd(["PING"]);
      redisInfo.reachable = !!pong;
      redisInfo.raw = pong;
    } catch (e) {
      redisInfo.reachable = false;
      redisInfo.error = e.message;
    }
  }

  // ---- API-Footballへの実接続確認(/status は認証確認用の軽量エンドポイント) ----
  const apiFootballInfo = { configured: !!API_KEY, viaRapidApi: VIA_RAPIDAPI, reachable: false, error: null };
  if (API_KEY) {
    try {
      const status = await callApiFootball("/status");
      apiFootballInfo.reachable = true;
      apiFootballInfo.accountInfo = status && status.response ? status.response : null;
    } catch (e) {
      apiFootballInfo.reachable = false;
      apiFootballInfo.error = e.message;
    }
  }

  // ---- LLM(Anthropic等)の実接続確認 ----
  // 以前は「APIキーが設定されているか」しか見ておらず、これでは「キーはある
  // ものの実際の呼び出しは失敗し続けている」状態(本番で実際に発生した不具合)を
  // 検知できなかった。これが「/debug.htmlはOKと出るのに、実際にAIに質問すると
  // 失敗する」というズレの直接原因だった。ここで極小トークン数(5)の実際のテスト
  // 呼び出しを1回行い、生の成功/失敗と、失敗時は実際のHTTPステータス・エラー本文
  // をそのまま返す(このページ自体がAUTO_COLLECT_SECRETで保護されているため、
  // 一般公開はされない)。コストはほぼゼロ(入力十数トークン・出力5トークン程度)。
  const llmInfo = {
    provider: process.env.LLM_PROVIDER || "anthropic",
    configured: !!process.env.ANTHROPIC_API_KEY,
    note: "「実接続テスト」は、このページを開くたびに実際にごく小さいテスト呼び出しを1回行います(コストはごくわずかですが、ゼロではありません)。",
  };
  if (llmInfo.configured) {
    try {
      const testStart = Date.now();
      const { text } = await generateLLM({
        systemPrompt: "あなたは接続テスト用です。「OK」とだけ返してください。",
        userPrompt: "テスト",
        maxTokens: 5,
      });
      llmInfo.testCall = { attempted: true, ok: true, tookMs: Date.now() - testStart, sampleResponse: text };
    } catch (e) {
      llmInfo.testCall = {
        attempted: true,
        ok: false,
        code: e.code || null,
        error: e.message || String(e),
      };
    }
  } else {
    llmInfo.testCall = { attempted: false, ok: false, error: "APIキーが未設定のためテスト呼び出しをスキップしました。" };
  }

  // ---- Learning Engine(既存のgetGrowthLogをそのまま再利用) ----
  const learning = await getGrowthLog(learningDeps);

  // ---- Knowledge Engine: 登録済みクラブ全体を横断して件数を集計 ----
  // 4層構造(Layer1事実/Layer2固定知識/Layer3見解/Layer4振り返り)導入後は、
  // 単なる合計件数だけでなく層ごとの件数も出す(「本当に増えているか」を
  // 種類別に確認できるようにするため)。
  let knowledgeTotalActive = 0;
  let knowledgeTotalStored = 0;
  let layerFactsCount = 0, layerAnalysesCount = 0, layerOpinionsCount = 0, layerProfilesCount = 0, layerReflectionsCount = 0;
  const knowledgeByTeam = [];
  if (UPSTASH_ENABLED) {
    for (const team of REGISTERED_TEAMS) {
      try {
        const active = await knowledgeStore.getActiveKnowledge(team.nameEn);
        knowledgeTotalActive += active.totalActive;
        knowledgeTotalStored += active.totalStored;
        layerFactsCount += active.facts.length;
        layerAnalysesCount += active.analyses.length;
        layerOpinionsCount += active.opinions.length;
        layerProfilesCount += active.profiles.length;
        layerReflectionsCount += active.reflections.length;
        if (active.totalStored > 0) {
          knowledgeByTeam.push({
            teamEn: team.nameEn, teamJa: team.nameJa, active: active.totalActive, stored: active.totalStored,
            layer1Facts: active.facts.length, layer2Profiles: active.profiles.length,
            layer3Opinions: active.opinions.length, layer4Reflections: active.reflections.length,
          });
        }
      } catch (e) {
        // ベストエフォート: 1クラブ分の集計に失敗しても他クラブの集計は続行する
      }
    }
  }
  // ---- 選手のKnowledge Engine(2026年8月〜: オンデマンド生成のため固定リストが
  // 無く、登録クラブのように横断集計できない。累計生成数だけ軽量カウンターで追う) ----
  let trackedPlayerProfiles = 0;
  if (UPSTASH_ENABLED) {
    try {
      trackedPlayerProfiles = parseInt((await upstashCmd(["GET", "knowledge:trackedPlayerProfiles"])) || "0", 10) || 0;
    } catch (e) { /* ベストエフォート */ }
  }

  const knowledgeEngineInfo = {
    totalActiveItems: knowledgeTotalActive,
    totalStoredItems: knowledgeTotalStored,
    registeredTeamsChecked: REGISTERED_TEAMS.length,
    byLayer: {
      layer1Facts: layerFactsCount,
      layer2Profiles: layerProfilesCount,
      layer3Opinions: layerOpinionsCount,
      layer4Reflections: layerReflectionsCount,
      analysesPromotedFromHypotheses: layerAnalysesCount,
    },
    byTeam: knowledgeByTeam,
    // 2026年8月・知識拡張フェーズ: 議論モードで質問された選手について、累計何人分の
    // Layer2プロフィール(プレースタイル等)を生成済みか(クラブと違い固定リストが
    // 無いオンデマンド方式のため、個別内訳ではなく累計数のみ)。
    onDemandPlayerProfilesGenerated: trackedPlayerProfiles,
  };

  // ---- Memory Engine: 現状「team:<英名>:leadingFactor」という1クラブ1サブジェクトのみ運用中 ----
  let memorySubjectsWithConclusion = 0;
  const memoryDetails = [];
  if (UPSTASH_ENABLED) {
    for (const team of REGISTERED_TEAMS) {
      try {
        const subjectKey = `team:${team.nameEn}:leadingFactor`;
        const conclusion = await memoryStore.getLastConclusion(subjectKey);
        if (conclusion) {
          memorySubjectsWithConclusion++;
          memoryDetails.push({
            teamEn: team.nameEn, teamJa: team.nameJa,
            statement: conclusion.statement, revision: conclusion.revision,
            computedAt: conclusion.computedAt, lastConfirmedAt: conclusion.lastConfirmedAt || null,
          });
        }
      } catch (e) {
        // ベストエフォート
      }
    }
  }
  const memoryEngineInfo = {
    subjectsWithConclusion: memorySubjectsWithConclusion,
    registeredTeamsChecked: REGISTERED_TEAMS.length,
    details: memoryDetails,
  };

  // ---- Prediction Engine(自前の学習モデル。learn:ownpred:* / learn:weights) ----
  const predictionEngineInfo = {
    totalOwnPredictions: 0, resolved: 0, correct: 0, accuracyPct: null, currentWeights: null, weightsLastUpdatedAt: null,
    // v2(拡張特徴量: 怪我人・順位・過去対戦・過密日程・得失点率)がすでに学習を
    // 始めているか(=既定値の0から動いたか)を一目で分かるようにする。
    v2ExtendedFeaturesLearning: { started: false, nonZeroWeights: [] },
    weightsHistoryRecent: [],
  };
  if (UPSTASH_ENABLED) {
    try {
      const [totalRaw, resolvedRaw, correctRaw, weights, weightsHistoryRaw] = await Promise.all([
        upstashCmd(["GET", "learn:ownpred:total"]),
        upstashCmd(["GET", "learn:ownpred:resolved"]),
        upstashCmd(["GET", "learn:ownpred:correct"]),
        upstashGetJSON("learn:weights"),
        upstashCmd(["LRANGE", "learn:weights:history", "-5", "-1"]),
      ]);
      const resolved = parseInt(resolvedRaw, 10) || 0;
      const correct = parseInt(correctRaw, 10) || 0;
      predictionEngineInfo.totalOwnPredictions = parseInt(totalRaw, 10) || 0;
      predictionEngineInfo.resolved = resolved;
      predictionEngineInfo.correct = correct;
      predictionEngineInfo.accuracyPct = resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null;
      predictionEngineInfo.currentWeights = weights || null;
      if (weights) {
        const extendedKeys = ["goalRateSensitivity", "injurySensitivity", "standingsSensitivity", "headToHeadSensitivity", "fatigueSensitivity"];
        const nonZero = extendedKeys.filter((k) => typeof weights[k] === "number" && Math.abs(weights[k]) > 0.0001);
        predictionEngineInfo.v2ExtendedFeaturesLearning = { started: nonZero.length > 0, nonZeroWeights: nonZero };
      }
      if (weightsHistoryRaw && weightsHistoryRaw.length) {
        const parsedHistory = weightsHistoryRaw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
        predictionEngineInfo.weightsHistoryRecent = parsedHistory.map((h) => ({
          date: h.date, method: h.method, adopted: h.adopted, oldAccuracy: h.oldAccuracy, newAccuracy: h.newAccuracy, sampleSize: h.sampleSize,
        }));
        const last = parsedHistory[parsedHistory.length - 1];
        if (last) predictionEngineInfo.weightsLastUpdatedAt = (last.newWeights && last.newWeights.updatedAt) || null;
      }
    } catch (e) {
      predictionEngineInfo.error = e.message;
    }
  }

  return {
    status: 200,
    body: {
      generatedAt,
      redis: redisInfo,
      apiFootball: apiFootballInfo,
      llm: llmInfo,
      learningEngine: learning,
      knowledgeEngine: knowledgeEngineInfo,
      memoryEngine: memoryEngineInfo,
      predictionEngine: predictionEngineInfo,
    },
  };
}

// ---- Memory Engine強化: 「AIは昨日何を考えていたか・今日何を考えているか・
// その理由」を実際に確認できるようにする(2026年8月・知識拡張フェーズ)。
// 仕組み自体(getConclusionHistory)はStage Eから既に実装されていたが、これまで
// どのエンドポイントからも呼ばれておらず、実質的に検証不可能だった(正直な
// ギャップ)。ここで初めて公開する。
async function handleTeamViewHistory(query) {
  const teamEn = String(query.get("team") || "").trim();
  if (!teamEn) return { status: 400, body: { ok: false, error: "team (English club name) is required" } };
  if (!UPSTASH_ENABLED) {
    return { status: 200, body: { ok: false, reason: "NO_UPSTASH", message: "Upstash未設定のためMemory Engineの記録はありません。" } };
  }
  const subjectKey = `team:${teamEn}:dailyView`;
  const [current, history] = await Promise.all([
    memoryStore.getLastConclusion(subjectKey),
    memoryStore.getConclusionHistory(subjectKey, 30),
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      team: teamEn,
      today: current ? { statement: current.statement, computedAt: current.computedAt, revision: current.revision } : null,
      // history[0]が直近の変化(=多くの場合「昨日の見解」)。それぞれ
      // 「その時点の見解」「変化理由」「いつ何に置き換わったか」を含む。
      history: history.map((h) => ({
        statement: h.statement, computedAt: h.computedAt,
        changeReason: h.changeReason, supersededAt: h.supersededAt, supersededBy: h.supersededBy,
      })),
      note: history.length === 0
        ? "見解の変化履歴はまだありません(毎日学習エンジンが2回以上実行され、かつ見解が変わった場合に記録されます)。"
        : null,
    },
  };
}

// LLM呼び出しは実費が発生するため、暴走・悪用でコストが青天井にならないよう
// 2段階の上限を設ける(世界中の誰でも使える公開サービスを想定した設計)。
//   ①IPごとの1日あたり上限(既定10回): 一人(または悪意あるアクセス)がその日の
//     予算を独り占めして、他の利用者が誰も使えなくなる事態を防ぐ。
//   ②サイト全体の1日あたり上限(既定2000回): ①をすり抜けるような異常アクセス
//     (IPを分散させた大量アクセス等)からサービス全体を守る、最後の安全弁。
// どちらも.envで調整可能。またAnthropic Console側(platform.claude.com)の
// 「使用量上限」設定も、アプリのバグ等に依存しない最終的な安全弁として
// 別途設定しておくことを強く推奨する(server/README.md参照)。
const PER_IP_LLM_CALLS_PER_DAY = parseInt(process.env.PER_IP_LLM_CALLS_PER_DAY, 10) || 10;
const MAX_LLM_CALLS_PER_DAY = parseInt(process.env.MAX_LLM_CALLS_PER_DAY, 10) || 2000;
let llmDailyBudget = { day: null, count: 0 };
let llmIpDailyBudget = { day: null, counts: new Map() };

function tryConsumeLlmBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (llmDailyBudget.day !== today) llmDailyBudget = { day: today, count: 0 };
  if (llmDailyBudget.count >= MAX_LLM_CALLS_PER_DAY) return false;
  llmDailyBudget.count += 1;
  return true;
}

// IPは末尾の1件のみ厳密照合はせず、既存の簡易レート制限(rateLimited関数)と
// 同じ抽出方法をそのまま踏襲する(x-forwarded-forの先頭が実クライアントIPである
// Renderの構成を想定。プロキシ構成が変わる場合は要調整)。
function tryConsumeLlmBudgetForIp(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (llmIpDailyBudget.day !== today) llmIpDailyBudget = { day: today, counts: new Map() };
  const key = ip || "unknown";
  const current = llmIpDailyBudget.counts.get(key) || 0;
  if (current >= PER_IP_LLM_CALLS_PER_DAY) return false;
  llmIpDailyBudget.counts.set(key, current + 1);
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
  // 2026年8月・知識拡張フェーズ: 監督遍歴(実データ)・Layer2固定知識(AI推定の
  // 戦術傾向)も、質問の種類に関わらずあれば根拠として渡す(coachName)・
  // needsに関係なく利用可能)。
  if (knowledge.managerCareer && knowledge.managerCareer.career && knowledge.managerCareer.career.length) {
    const prev = knowledge.managerCareer.career.find((c) => c.end);
    if (prev) facts.push(`[監督遍歴] ${knowledge.managerCareer.currentCoachName || knowledge.coachName}監督の前職: ${prev.teamName}(${prev.start || "不明"}〜${prev.end})`);
  }
  if (knowledge.clubProfile && knowledge.clubProfile.statement) {
    facts.push(knowledge.clubProfile.statement);
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

// 2026年8月・「議論できるAI」強化フェーズ(ご要望⑤): 「検索AIのように事実を
// 並べるだけ」ではなく、①世の中の一般論 ②AI独自の意見 ③反対意見(あえて逆側
// から見た視点) ④最終結論 ⑤今後の見通し、という「議論の型」を毎回踏ませる。
// さらにご要望④(Memory Engineの活用)に対応し、②AI独自の意見の中で、前回との
// 評価の変化(あれば)に必ず触れさせる(userPromptに前回結論を渡すreasoning
// PromptBlock/previousConclusionと連動。formatReasoningForPrompt参照)。
function buildDiscussSystemPrompt() {
  return [
    "あなたはサッカーの分析官です。以下に与えられた「事実」だけを根拠として、利用者の質問に答えてください。",
    "事実に無い具体的な数字・固有名詞(スコア・日付・移籍額・選手名など)を新たに作ってはいけません。",
    "与えられた事実が乏しい場合は、それを正直に述べた上で、一般的なサッカーの見方として考察してください。",
    "事実と自分の意見は明確に書き分けてください(「〜という結果が出ています」と「私は〜と考えます」のように)。",
    "利用者が意見や感想を述べている場合は、頭ごなしに否定せず、まずその視点を受け止めてください。",
    "あなたは単に事実を検索して並べる「検索AI」ではありません。以下の型に沿って、自分の頭で考えて議論してください。",
    "「AIが前回下した結論」が与えられていて、かつ今回の結論が変わった場合は、②AI独自の意見の中で必ず",
    "「以前は〜と評価していましたが、今回は〜に評価を変えました」という趣旨の文を含めてください。",
    "前回の結論が無い、または今回と同じ場合は、変化した体で書かない(でっち上げない)でください。",
    "必ず次の形式で、日本語で出力してください。見出し以外の余計な文章は含めないでください。",
    "",
    "###一般論###",
    "(この話題について、サッカー界で一般的に言われている見方・定説を2〜4文で)",
    "",
    "###AI独自の意見###",
    "(与えられた実データを踏まえた、あなた自身の見解を3〜6文で。単なる一般論の繰り返しではなく、あなた独自の視点を出してください。評価が前回から変わった場合はその旨に必ず触れてください)",
    "",
    "###反対意見###",
    "(AI独自の意見に対して、最も説得力のある反対の視点・懸念点を2〜4文で。あなたの意見を弱める材料も正直に示してください)",
    "",
    "###最終結論###",
    "(一般論・AI独自の意見・反対意見を踏まえた、あなたの最終的な結論を2〜3文で)",
    "",
    "###今後どうなると思うか###",
    "(今後の見通しを1〜3文で)",
    "",
    "###最も重要だと考える点###",
    "(必ず1文だけ、「私は○○が最も重要だと考えます。」という形式で。○○にはこの考察で最も重視した具体的な要素を入れてください)",
    "",
    "###フォローアップ###",
    "(議論を続けるための質問を1〜2個、1行に1つずつ)",
  ].join("\n");
}

function parseDiscussLlmOutput(rawText) {
  const text = String(rawText || "");
  const LABEL_ORDER = ["一般論", "AI独自の意見", "反対意見", "最終結論", "今後どうなると思うか", "最も重要だと考える点", "フォローアップ"];
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
  const generalView = grab("一般論", LABEL_ORDER.slice(1));
  const aiOpinion = grab("AI独自の意見", LABEL_ORDER.slice(2));
  const counterArgument = grab("反対意見", LABEL_ORDER.slice(3));
  const finalConclusion = grab("最終結論", LABEL_ORDER.slice(4));
  const futureOutlook = grab("今後どうなると思うか", LABEL_ORDER.slice(5));
  const mostImportantOpinion = grab("最も重要だと考える点", LABEL_ORDER.slice(6));
  const followRaw = grab("フォローアップ", []);
  const parsedOk = !!(generalView || aiOpinion || counterArgument || finalConclusion || futureOutlook || mostImportantOpinion);
  if (!parsedOk) {
    // LLMが指定フォーマットに従わなかった場合の保険: 空欄のまま返すより、
    // 生成された文章をそのままAI独自の意見欄に入れて表示できるようにする。
    return {
      generalView: "", aiOpinion: text.trim().slice(0, 1200), counterArgument: "", finalConclusion: "",
      futureOutlook: "", mostImportantOpinion: "", followUpQuestions: [], parsedOk: false,
    };
  }
  const followUpQuestions = followRaw.split("\n").map((s) => s.replace(/^[・\-\d.、\s]+/, "").trim()).filter(Boolean).slice(0, 2);
  return { generalView, aiOpinion, counterArgument, finalConclusion, futureOutlook, mostImportantOpinion, followUpQuestions, parsedOk: true };
}

async function handleDiscuss(body, clientIp) {
  if (!body || typeof body !== "object") return { status: 400, body: { ok: false, error: "invalid JSON body" } };
  const question = String(body.question || "").trim();
  if (!question) return { status: 400, body: { ok: false, error: "question is required" } };
  if (question.length > 500) return { status: 400, body: { ok: false, error: "question is too long (max 500 chars)" } };

  // 予算チェックはPlanner/RAG/Reasoning Engineより先に行う。どうせLLMを呼べない
  // ならAPI-Football側のクォータも消費させないため。①IPごとの上限→②サイト全体の
  // 上限、の順でチェックする(①で弾かれた場合は②の枠を消費しない=他の利用者の
  // 分は減らさない)。
  if (!tryConsumeLlmBudgetForIp(clientIp)) {
    return {
      status: 200,
      body: {
        ok: false, reason: "llm_budget_exceeded_per_ip",
        message: `本日、あなたがご利用いただけるAI考察の回数の上限(${PER_IP_LLM_CALLS_PER_DAY}回)に達しました。日付が変わると(日本時間の朝ごろ)また使えるようになります。`,
      },
    };
  }
  if (!tryConsumeLlmBudget()) {
    return {
      status: 200,
      body: {
        ok: false, reason: "llm_budget_exceeded_global",
        message: "本日はサイト全体でのAI考察の利用が集中しているため、一時的に利用を制限しています。しばらくしてから再度お試しください。",
      },
    };
  }

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
      const knowledge = await knowledgeSource.gatherClubKnowledge(subject.labelEn, plan.needs, subject.labelJa);
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
      // 2026年8月・知識拡張フェーズ: キーパス・パス成功率・ドリブル成功率・
      // 守備指標・デュエル勝率も、取得できたものだけ事実として渡す(いずれも実データ)。
      const extraParts = [];
      if (s.keyPasses !== null && s.keyPasses !== undefined) extraParts.push(`キーパス${s.keyPasses}本`);
      if (s.passAccuracyPct !== null && s.passAccuracyPct !== undefined) extraParts.push(`パス成功率${s.passAccuracyPct}%`);
      if (s.dribbleSuccessRatePct !== null && s.dribbleSuccessRatePct !== undefined) extraParts.push(`ドリブル成功率${s.dribbleSuccessRatePct}%(${s.dribbleAttempts}回試行)`);
      if (s.defensiveActions !== null && s.defensiveActions !== undefined) extraParts.push(`守備指標(タックル+インターセプト)${s.defensiveActions}回`);
      if (s.duelWinRatePct !== null && s.duelWinRatePct !== undefined) extraParts.push(`デュエル(競り合い)勝率${s.duelWinRatePct}%`);
      if (extraParts.length) facts.push(`${playerName}の追加実成績: ${extraParts.join("・")}`);
      stats = { appearances: s.appearances, goals: s.goals, assists: s.assists, avgRating: s.avgRating, keyPasses: s.keyPasses, passAccuracyPct: s.passAccuracyPct, dribbleSuccessRatePct: s.dribbleSuccessRatePct, defensiveActions: s.defensiveActions, duelWinRatePct: s.duelWinRatePct };
      confidence = { stars: 4, reasonJa: "今シーズンの実成績データが取得できているため。ただし直近の調子や怪我の詳細までは反映されていません。" };

      // ---- Knowledge Engine Layer2(選手プロフィール)をオンデマンドで生成・
      // キャッシュする(既に有効なプロフィールがあれば内部でスキップされる)。
      // 「主要リーグ全選手」への現実的な対応方法: 質問された選手から知識が
      // 蓄積されていく設計(クラブと同じ思想。README参照)。
      if (statsBody.player && statsBody.player.id) {
        const playerKey = `player:${statsBody.player.id}`;
        try {
          const groundingFacts = extraParts.length ? [`実成績: 出場${s.appearances ?? "不明"}試合・${s.goals ?? "不明"}得点・${s.assists ?? "不明"}アシスト`, ...extraParts] : [`実成績: 出場${s.appearances ?? "不明"}試合・${s.goals ?? "不明"}得点・${s.assists ?? "不明"}アシスト`];
          const playerProfileResult = await playerProfileEngine.ensurePlayerProfile(
            playerKey, playerName, hint.teamEn || null, groundingFacts, new Date().toISOString(), hint.teamEn || null
          );
          if (playerProfileResult && playerProfileResult.profile && playerProfileResult.profile.statement) {
            facts.push(playerProfileResult.profile.statement);
          }
        } catch (e) { /* ベストエフォート: プロフィール生成に失敗しても選手の実成績自体は回答に使う */ }

        // 実成績スナップショットをLayer1事実として保存(「昨日より知識が増えている」
        // 追跡・重複排除の対象にするため。knowledgeStoreのteamEnフィールドを
        // 選手用の主体キーとして流用している点はplayerProfileEngine.js冒頭の
        // コメントの通り)。
        try {
          await knowledgeStore.saveKnowledgeItem({
            teamEn: playerKey, teamJa: playerName, category: "playerSeasonStats", type: "fact",
            statement: `${playerName}の${statsBody.season}シーズン実成績: 出場${s.appearances ?? "不明"}試合・${s.goals ?? "不明"}得点・${s.assists ?? "不明"}アシスト${extraParts.length ? "・" + extraParts.join("・") : ""}`,
            computedAt: new Date().toISOString(), source: "API-Footballの実データ(/players)",
          });
        } catch (e) { /* ベストエフォート */ }
      }
    } else {
      facts.push(`${hint.name || "対象選手"}の実成績データは見つかりませんでした(${statsBody.reason || "不明"})。`);
      confidence = { stars: 1, reasonJa: "実成績データを取得できなかったため、一般的な知識のみに基づく考察です。" };
    }
  } else {
    facts.push("特定のクラブ・選手データには基づかない、一般的なサッカーの知識に基づく考察です。");
    confidence = { stars: 2, reasonJa: "特定の実データによる裏付けができないため、確信度は控えめにしています。" };
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
    // これまでここでエラーの中身(実際のAnthropic APIのHTTPステータス・応答本文)を
    // 一切ログに残していなかったため、本番で「AIの考察生成に失敗しました」が
    // 続いても原因(APIキー不正・クレジット不足・レート制限・モデル名不正 等)を
    // 特定する手段がなかった。Renderの「Logs」タブで実際の原因が読めるようにする。
    console.error("[discuss] generateLLM failed:", e.code || "(no code)", "-", e.message);
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
      // 2026年8月・「議論できるAI」強化フェーズ(ご要望⑤): 検索AIのような
      // 「事実の要約」ではなく、一般論→AI独自の意見→反対意見→最終結論→
      // 今後どうなるか、という「議論の型」をそのままフィールドとして返す。
      generalView: llmOut.generalView,
      aiOpinion: llmOut.aiOpinion,
      counterArgument: llmOut.counterArgument,
      finalConclusion: llmOut.finalConclusion,
      futureOutlook: llmOut.futureOutlook,
      mostImportantOpinion: llmOut.mostImportantOpinion,
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
      if (pathname === "/api/coach-search") {
        const { status, body } = await handleCoachSearch(parsed.searchParams);
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
      if (pathname === "/api/match-analysis") {
        // 「AIマッチ分析」カード: ?home=<クラブ名>&away=<クラブ名>(日本語名/英語名どちらも可)。
        // GET(副作用が無い読み取り専用の分析リクエストのため、/api/fixtures/analysis等と
        // 同じくGETに統一)。LLM呼び出しを含む可能性があるため、/api/discussと同じ
        // IPベースの日次予算(tryConsumeLlmBudgetForIp)を関数内部で共有する
        // (ただし予算超過時もエラーにはせず、決定論的な文章にフォールバックする)。
        const maRequestIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
        const { status, body } = await handleMatchAnalysis(parsed.searchParams, maRequestIp);
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
        const discussClientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
        const { status, body } = await handleDiscuss(parsedBody, discussClientIp);
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
        //
        // 2026年8月・本番調査で発見された不具合の修正: 以前はこのリクエストを
        // 「学習ジョブが完全に終わるまで」応答を返さずに待たせていた。実際の
        // 本番データ(11クラブ・複数選手ぶんの外部API呼び出し + LLM生成)では
        // この処理全体が2分(GitHub Actions側のcurl --max-timeの上限)を超える
        // ことがあり、fetchWithTimeout導入後も「個々の呼び出しは時間内に終わる
        // が、件数が多いため合計では2分を超える」ケースでは、GitHub Actions
        // 側がcurlの制限時間で待ちきれずexit code 28で失敗し続けていた
        // (サーバー側は実際には処理を続けており、いずれ正常に完了・保存されて
        // いた可能性が高い)。
        // 対策として、リクエストを受けたら即座に「開始しました」と応答を返し、
        // 実際の学習処理はレスポンスを待たずにバックグラウンドで継続する
        // (fire-and-forget)方式に変更した。これにより、処理に何分かかっても
        // HTTPクライアント側のタイムアウトの影響を受けなくなる。デバッグ用途で
        // 完了を待ちたい場合は ?sync=1 を付けると従来通り同期的に完了を待つ。
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        // 2026年8月・本番調査(優先順位⑨の健康診断)で発見した不具合の修正:
        // 本番のgrowthLogに「本日13回実行」と記録されており、API-Footballの
        // 使用量が想定(80〜100)の8倍(801)に膨らんでいた。
        //
        // 原因: GitHub Actions側のcurlが --retry 2 とフォールバックの再呼び出しを
        // 行うため、1回のワークフローで最大4回このエンドポイントを叩く。
        // Renderの無料プランは15分アクセスが無いとスリープするため、初回の
        // 呼び出しはコールドスタート待ちでタイムアウトしやすく、そのたびに
        // curlが再送する。サーバー側は既に処理を始めているので、再送のぶんだけ
        // 学習ジョブが多重に起動していた。
        //
        // 既存の dailyLearningRunning はプロセス内メモリのフラグのため、
        // 再デプロイやスリープ復帰で新しいプロセスになると効かない。そこで
        // Upstash上に「実行ロック」を置き、プロセスをまたいで多重起動を防ぐ。
        // 一定時間(既定10分)で自動的に期限切れになるため、途中で落ちても
        // 翌回以降がブロックされ続けることはない。意図的に再実行したい場合は
        // ?force=1 を付ける(デバッグ用の逃げ道)。
        const runLockOk = (parsed.searchParams.get("force") === "1")
          ? { acquired: true, skipped: false }
          : await tryAcquireDailyRunLock();
        if (!runLockOk.acquired) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: true, started: false, alreadyRunning: true, reason: "RUN_LOCK_HELD",
            message: `直近${DAILY_RUN_LOCK_SECONDS / 60}分以内に学習ジョブが開始されているため、二重起動を防ぐためスキップしました(API-Footballのリクエストを無駄に消費しないための保護です)。意図的に再実行したい場合は ?force=1 を付けてください。`,
          }));
          return;
        }
        if (parsed.searchParams.get("sync") === "1") {
          const result = await runDailyLearning(learningDeps);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
          return;
        }
        if (dailyLearningRunning) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, alreadyRunning: true, message: "学習ジョブは既に実行中です(二重起動を防ぐためスキップしました)。数分後に/api/growth-logで結果を確認してください。" }));
          return;
        }
        dailyLearningRunning = true;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, started: true, message: "学習ジョブをバックグラウンドで開始しました。数分後に/api/growth-logで結果を確認してください。" }));
        runDailyLearning(learningDeps)
          .catch((e) => {
            console.error("[run-daily background error]", e && e.stack || e);
          })
          .finally(() => { dailyLearningRunning = false; });
        return;
      }
      if (pathname === "/api/growth-log") {
        // ホーム画面の「昨日学んだこと」ウィジェット用。Upstash未設定・未実行の
        // 場合も、架空の数字を返さず正直な状態を返す(既存のhandleAccuracyStats
        // と同じ方針)。
        const result = await getGrowthLog(learningDeps);
        // 2026年8月・優先順位⑨: 「0件」の理由をサーバー側で判定して同梱する。
        // これまでは画面に「0件」としか出ず、正常な0件(前回から変化なし)と
        // 異常な0件(未実行・キー未設定・予算切れ)を利用者が区別できなかった。
        try {
          result.zeroKnowledgeDiagnosis = diagnoseZeroKnowledge(result);
          result.zeroVerificationDiagnosis = diagnoseZeroVerification(result);
          // 2026年8月・完全自動Learning Cycle ⑧: 「昨日より賢くなったか」の判定も
          // ホーム画面のウィジェットへ渡す(前日との実データの差分に基づく)。
          const trend = await getMetricsTrend(learningDeps, 3, new Date().toISOString().slice(0, 10)).catch(() => null);
          result.growthComparison = trend ? trend.comparison : null;
        } catch (e) { /* 診断は付加情報なので、失敗しても本体は返す */ }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }
      if (pathname === "/api/learning/metrics") {
        // 2026年8月・完全自動Learning Cycle ⑧「毎日賢くなっていることを証明してください」。
        // Prediction Accuracy / Knowledge Count / Memory Count / Failure Learning /
        // Weight Update / Learning Time を日ごとに記録したものを、前日との差分つきで返す。
        const days = Math.max(2, Math.min(60, parseInt(parsed.searchParams.get("days") || "14", 10) || 14));
        const todayDateKey = new Date().toISOString().slice(0, 10);
        const trend = await getMetricsTrend(learningDeps, days, todayDateKey)
          .catch((e) => ({ available: false, reasonJa: `指標の読み出しに失敗しました(${e.message})。`, days: [] }));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), ...trend }));
        return;
      }
      if (pathname === "/api/learning/health") {
        // 2026年8月・優先順位⑨「Learning Engineを総点検してください」。
        // GitHub Actions / cron / Render / Upstash / Prediction / Learning /
        // Knowledge / Memory / Hypothesis の状態を実データから判定し、
        // 「毎日動いていること」を過去N日分の実行履歴で実証する。
        const { status, body } = await handleLearningHealth(parsed.searchParams);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/knowledge/team-view-history") {
        // 「AIは昨日何を考えていたか・今日何を考えているか・その理由」を確認する
        // エンドポイント(Memory Engine強化)。内部の考察内容を含むため、他の
        // 保護付きエンドポイントと同じ?key=方式に揃える(AUTO_COLLECT_SECRET未設定なら開いたまま)。
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        const { status, body } = await handleTeamViewHistory(parsed.searchParams);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/debug-status") {
        // 開発者向け自己診断ページ(/debug.html)専用のJSONエンドポイント。
        // AUTO_COLLECT_SECRETが設定されている場合は、他の保護付きエンドポイント
        // (run-daily/auto-collect)と同じ ?key= 方式で保護する(内部の件数・
        // 構成情報を一般公開しないため)。未設定の場合は、それらのエンドポイントと
        // 同様に開いたままになる(README/.env.exampleで開示済みのトレードオフ)。
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        const { status, body } = await handleDebugStatus();
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
  console.log(`AI予測の記録(Upstash Redis): ${UPSTASH_ENABLED ? "あり" : "なし(.envのUPSTASH_REDIS_REST_URL/TOKENを設定してください)"}`);
});

module.exports = {
  server,
  handlePlayerSeasonStats,
  handleFixturesToday,
  handleFixtureAnalysis,
  handleCoachSearch,
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
  handleDebugStatus,
  handleLearningHealth,
  tryAcquireDailyRunLock,
  getApiPlanInfo,
  recordRateLimitHeaders,
  handleTeamViewHistory,
  handleMatchAnalysis,
  learningDeps,
  knowledgeStore,
  memoryStore,
  relationshipIndex,
  clubProfileEngine,
  playerProfileEngine,
};
