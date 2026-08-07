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
// 2026年8月・優先順位④: 6段階の熟考(必要データ取得→仮説生成→仮説比較→反対意見→根拠評価→最終結論)。
const { deliberate } = require("./reasoning/deliberation");

// 毎日学習エンジン(Learning Engine)。実体は server/learning/dailyJob.js。
// 依存(callApiFootball/resolveTeamId/Upstashアクセス関数)は、このファイル自身が
// 定義した後にまとめて注入する(利用箇所は下の方の「Stage D」セクションを参照)。
let { runDailyLearning } = require("./learning/dailyJob");   // テストで差し替えられるよう let
const { getGrowthLog, getRecentFactsForTeam, computeFormScore, OWN_PREDICT_LOG_CAP: OWN_PREDICT_LOG_CAP_DISPLAY } = require("./learning/dailyJob");
// 2026年8月・優先順位⑨: 「今日追加した知識0件」が正常な0件(前回から変化なし)
// なのか、異常な0件(未実行・キー未設定・予算切れ等)なのかを実データから判定する。
const { diagnoseZeroKnowledge, diagnoseZeroVerification, getRunHistory, buildEngineStatuses } = require("./learning/healthCheck");
// 2026年8月・ご指示③: 特徴量生成の共通化(日次学習とオンデマンド分析でズレを起こさない)
const { buildMatchFeatures } = require("./learning/featureEngine");
// 2026年8月・優先順位⑤: 予測評価が「変わった時だけ」Memory Engineへ記録する。
const { recordPredictionEvaluation, buildComparisonForResponse } = require("./memory/predictionMemory");
// 2026年8月・完全自動Learning Cycle ⑧: 「本当に昨日より賢くなったのか」を数値で示す。
const { getMetricsTrend } = require("./learning/dailyMetrics");
// 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示②⑨⑩):
// 予測精度の毎日測定・学習計画・信頼度の説明をダッシュボードへ返す
const { getAccuracyTrend, computeMarketProbs } = require("./learning/accuracyTracker");
// 2026年8月・精度証明ラウンド②: 較正(実測のズレ)に基づく表示勝率の自動補正
const { applyCalibration } = require("./learning/calibrationCorrection");
// 自己改善ループ⑤: 「この1か月でAIが何を改善してきたか」の履歴読み出し
const { getSelfImprovementHistory } = require("./learning/selfImprovement");
// 2026年8月・AI知能計測ラウンド(ご指示③⑤): 考察の質とRAG使用率を、質問時は
// メモリ集計のみ(応答速度への影響ゼロ)で記録する。日次保存はdailyJobが行う。
const intelligenceMetrics = require("./learning/intelligenceMetrics");
const { loadLatestAgenda } = require("./learning/learningAgenda");
const { SOURCE_TRUST, HALF_LIFE_HOURS } = require("./learning/trustEngine");
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
  fetchLatestFormation, fetchTeamTopScorer, fetchTeamXgAverage,
} = require("./learning/features");
// リーグの知識(順位表・得点/アシストランキング)をクラブの質問から引くために使う
const _LEAGUE_CFG = require("./learning/leagueConfig");
const {
  EXTENDED_DEFAULT_WEIGHTS, computeMatchFeatures, computeFeatureAvailability, predictOutcomeV2,
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
// ============================================================================
// 2026年8月・最終方針「必ず提出するもの」対応: 性能の常時計測。
// 応答時間(エンドポイント別の平均/p95)・キャッシュヒット率・プロセスの
// CPU/メモリを、追加コストほぼゼロ(メモリ上のカウンタのみ)で常時計測し、
// /api/debug-status で実測値として提出できるようにする。
// 「実装しました」ではなく実測値で示すための土台。
// ============================================================================
const perfStats = {
  startedAt: Date.now(),
  cacheHits: 0,
  cacheMisses: 0,
  endpoints: new Map(), // pathGroup -> { count, totalMs, ring: number[](最新200件) }
};
const PERF_RING_SIZE = 200;
function recordPerf(pathGroup, ms) {
  let e = perfStats.endpoints.get(pathGroup);
  if (!e) {
    if (perfStats.endpoints.size >= 50) return; // 未知のパスの氾濫でメモリを食わない
    e = { count: 0, totalMs: 0, ring: [] };
    perfStats.endpoints.set(pathGroup, e);
  }
  e.count++;
  e.totalMs += ms;
  e.ring.push(ms);
  if (e.ring.length > PERF_RING_SIZE) e.ring.shift();
}
function percentileOf(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function perfSnapshot() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const totalCache = perfStats.cacheHits + perfStats.cacheMisses;
  return {
    uptimeSec: Math.round((Date.now() - perfStats.startedAt) / 1000),
    cache: {
      hits: perfStats.cacheHits, misses: perfStats.cacheMisses,
      hitRatePct: totalCache ? Math.round((perfStats.cacheHits / totalCache) * 1000) / 10 : null,
    },
    memory: { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576) },
    cpu: { userMs: Math.round(cpu.user / 1000), systemMs: Math.round(cpu.system / 1000) },
    endpoints: [...perfStats.endpoints.entries()].map(([path, e]) => ({
      path, count: e.count,
      avgMs: Math.round(e.totalMs / e.count),
      p95Ms: percentileOf(e.ring, 95),
    })).sort((a, b) => b.count - a.count),
    // AI知能計測ラウンド: まだ日次保存されていない考察サンプル数(メモリ集計中)。
    // 質問時にRedisへ書かない設計が本番でも動いていることを外から確認できる。
    intelligenceBuffer: { pendingSamples: intelligenceMetrics.pendingSampleCount() },
    // 成長可視化ラウンド②: API成功率(プロセス起動からの実測)
    apiCalls: apiCallStatsSnapshot(),
  };
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) { perfStats.cacheMisses++; return undefined; }
  if (Date.now() > hit.expires) { cache.delete(key); perfStats.cacheMisses++; return undefined; }
  perfStats.cacheHits++;
  return hit.data;
}
// 第7次監査で発見した欠陥の修正:
//   このMapは「同じ鍵をもう一度読んだとき」にしか期限切れを削除しないため、
//   二度と読まれない鍵(例: 存在しない試合IDでの /api/fixtures/analysis)は
//   永久に残り続けた。認証不要のGETで毎分30件まで積めるため、1日あたり
//   4万件以上がメモリに居座り、Renderの無料プランでは落ちる。
//   保存件数に上限を設け、超えたら期限切れを一掃し、それでも多ければ
//   古いものから捨てる(JavaScriptのMapは挿入順を保つ)。
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 5000;
function sweepCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (now > v.expires) cache.delete(k);
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const overflow = cache.size - CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const k of cache.keys()) { cache.delete(k); if (++removed >= overflow) break; }
}
function cacheSet(key, data, ttlMs) {
  if (cache.size >= CACHE_MAX_ENTRIES) sweepCache();
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// 第7次監査で発見した「鍵の衝突」の修正:
//   `resolve:${name}|${teamHint}|...` のように、利用者が入力した文字列を
//   区切り文字で連結して鍵にしていた。name="A", team="B|C" と
//   name="A|B", team="C" がまったく同じ鍵になるため、**ある選手の成績が
//   別の選手の質問に対して返る**ことが起こりうる。各部品を符号化して連結する。
function cacheKeyOf(prefix, parts) {
  return prefix + ":" + (parts || []).map((v) => encodeURIComponent(String(v ?? ""))).join("|");
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

// ---- 2026年8月・第7次監査で発見した時差の欠陥への対応 ----
//
// このアプリの利用者は日本にいますが、日付キーはすべてUTCで作られていました。
// 実害が2つありました。
//
//  (1) 日次学習ジョブは GitHub Actions の cron "0 19 * * *"(UTC19時=日本時間の
//      翌朝4時)に走ります。日本の利用者が「今朝動いた」と感じる実行が、
//      **前日のUTC日付**のキーへ保存されます。一方で健康診断は
//      「今日(UTC)の記録があるか」を見るため、日本時間の朝9時から翌朝4時まで
//      ——つまり日本人が起きているあいだ中ずっと——
//      「本日は実行記録がありません。GitHub Actionsが動いていない可能性があります」
//      と表示していました。**毎日賢くなっていることを証明するはずの画面が、
//      毎日ほぼ一日中「壊れています」と嘘をついていた**ことになります。
//
//  (2) 「📡 本日の実際の試合」も同じで、日本時間の0時〜9時のあいだは
//      前日の試合が「本日の試合」として表示されていました。
//
// 学習の記録キーは「日本時間の日付」に統一します(利用者にとっての1日と、
// 記録上の1日を一致させるため)。既存のUTCキーは自然に置き換わります。
const APP_TIMEZONE_OFFSET_HOURS = Number(process.env.APP_TIMEZONE_OFFSET_HOURS ?? 9); // 既定=日本時間(UTC+9)
function appDateKey(date) {
  const d = date ? new Date(date) : new Date();
  return new Date(d.getTime() + APP_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---- 2026年8月・第7次監査で発見した欠陥への対応(利用者の識別) ----
//   これまでは `req.headers["x-forwarded-for"]` をそのまま鍵にしていた。
//   このヘッダーは誰でも自由に書ける値なので、リクエストごとに違う値を送るだけで
//   「1分30回まで」の制限も「AI考察1日10回まで」の制限も**完全に無効化**できた。
//   さらに、その値ごとにMapのエントリが増え続け、掃除もされていなかった。
//
//   Renderのようなプロキシ配下では、X-Forwarded-For の**最も右側**が
//   直前のプロキシ、**左端**が自称の値になる。信頼できるのはプロキシが付け足した
//   部分なので、左端(自己申告)ではなく、実際の接続元も併せて鍵にする。
//   完全な対策ではないが、ヘッダーを1つ書き換えるだけで無制限になる状態は解消できる。
function clientKeyFromRequest(req) {
  const socketIp = (req.socket && req.socket.remoteAddress) || "unknown";
  const xff = String(req.headers["x-forwarded-for"] || "");
  // 一番右(=直前のプロキシが実際に観測した接続元)を使う
  const rightMost = xff.split(",").map((v) => v.trim()).filter(Boolean).pop() || "";
  // 実接続元も鍵に含めることで、ヘッダーだけを変えても鍵が無限に増えないようにする
  return `${socketIp}|${rightMost}`.slice(0, 100);
}

// ---- ごく簡易なレート制限(IPごと・1分あたり30リクエストまで) ----
const rateBuckets = new Map();
// 第7次監査での追加: このMapは一度も掃除されていなかったため、
// 鍵が増え続けるとメモリを圧迫した。古くなったバケツを定期的に捨てる。
const RATE_BUCKETS_MAX = 5000;
// 上限は環境変数で調整できるようにする(既定30。検証用に一時的に緩めたい場合に使う)
const RATE_LIMIT_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE) || 30;
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = RATE_LIMIT_PER_MINUTE;
  const bucket = rateBuckets.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < windowMs);
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  if (rateBuckets.size > RATE_BUCKETS_MAX) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] >= windowMs) rateBuckets.delete(k);
    }
    // それでも多い場合は、古いものから捨てる(Mapは挿入順を保つ)
    let over = rateBuckets.size - RATE_BUCKETS_MAX;
    if (over > 0) for (const k of rateBuckets.keys()) { rateBuckets.delete(k); if (--over <= 0) break; }
  }
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
      const isNew = lastRateLimit.dailyLimit !== limit;
      lastRateLimit = {
        dailyLimit: limit,
        remaining: Number.isFinite(remaining) ? remaining : null,
        observedAt: new Date().toISOString(),
      };
      // ---- 2026年8月・本番の健康診断出力から発見した重大な問題への対応 ----
      //   契約プランの自動判定はプロセス内のメモリにしか無かった。
      //   Renderの無料プランは15分アクセスが無いとスリープするため、
      //   **起動のたびに「プランが分からない」状態に戻り、予算が既定の
      //   1日100件で始まってしまう**。日次学習は
      //   クラブ→監督/移籍→リーグ→選手 の順に処理するため、
      //   100件(うち20件は利用者用に確保)ではクラブと監督/移籍で尽き、
      //   **リーグと選手には一度も到達しない**。
      //   実際、本番の記録は3日連続で「0リーグ・0選手」でした。
      //   一度分かったプランはUpstashへ保存し、次の起動時に読み直す。
      if (isNew && UPSTASH_ENABLED) {
        upstashSetJSON("learn:apiplan", {
          dailyLimit: limit, observedAt: lastRateLimit.observedAt,
        }).catch(() => {});
      }
    }
  } catch (e) { /* ヘッダーが読めなくても本処理は続行する(ベストエフォート) */ }
}

// 保存済みのプラン判定を読み戻す(プロセス起動時に1回だけ)。
// これが無いと、スリープ復帰のたびに予算が100件から始まってしまう。
let planRestorePromise = null;
async function restoreDetectedPlan() {
  if (!UPSTASH_ENABLED) return null;
  if (lastRateLimit.dailyLimit) return lastRateLimit.dailyLimit;
  if (!planRestorePromise) {
    planRestorePromise = (async () => {
      try {
        const stored = await upstashGetJSON("learn:apiplan");
        if (stored && Number.isFinite(stored.dailyLimit) && stored.dailyLimit > 0 && !lastRateLimit.dailyLimit) {
          lastRateLimit = {
            dailyLimit: stored.dailyLimit,
            remaining: null, // 残量は今日の実測でしか分からないので復元しない
            observedAt: stored.observedAt || null,
            restoredFromStorage: true,
          };
        }
        return lastRateLimit.dailyLimit;
      } catch (e) { return null; }
    })();
  }
  return planRestorePromise;
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
    // 復元した値なのか、今のプロセスで実際に観測した値なのかを区別して伝える
    restoredFromStorage: !!lastRateLimit.restoredFromStorage,
    noteJa: detected
      ? (lastRateLimit.restoredFromStorage
        ? `以前の実行で判定した契約プラン(1日${detected}件)を保存先から読み戻しています。次にAPIを呼んだ時点で最新の値へ更新されます。`
        : "API-Footballのレスポンスヘッダーから実際の契約プランを自動判定しました。")
      : "まだAPI-Footballを1度も呼べていないため、契約プランを自動判定できていません(APIキー未設定、またはサーバー起動直後の可能性があります)。",
  };
}

// ---- 2026年8月: 日次学習ジョブの多重起動を防ぐロック ----
// プロセス内フラグ(dailyLearningRunning)は再デプロイ・スリープ復帰で失われるため、
// Upstash上に期限つきのロックを置いてプロセスをまたいで保護する。
// SET key value NX EX <秒> は「まだ無いときだけ書き込む」ため、
// これが失敗した=直近に別の実行が始まっている、と判断できる。
// 第8次監査(Medium)の修正: Proプラン予算では1回のジョブが数百APIリクエスト+
// LLM呼び出しで10分を超え得るため、既定10分ではロック失効後に別プロセスと
// 並走し得た(解決の二重実行の引き金)。既定を30分に延長する。
const DAILY_RUN_LOCK_SECONDS = Number(process.env.DAILY_RUN_LOCK_SECONDS) || 1800; // 既定30分

// 第7次監査で発見した欠陥への対応:
//   AUTO_COLLECT_SECRET を設定していない場合(手順書での既定)、
//   `GET /api/learning/run-daily?force=1&sync=1` を繰り返し呼ぶだけで
//   多重起動の保護をすり抜けて学習ジョブを何度でも起動でき、
//   1回あたり数十〜100件のAPIリクエストを消費できてしまった。
//   デバッグ用の逃げ道は残したいので、禁止ではなく回数制限にする。
const UNPROTECTED_FORCE_RUN_MAX = Number(process.env.UNPROTECTED_FORCE_RUN_MAX) || 3;
let unprotectedForceRuns = { day: null, count: 0 };
// 第8次監査(Medium)の修正: カウンタがプロセス内メモリだけだと、Render無料プランの
// スリープ(15分)や再デプロイのたびに0へ戻り、「1日3回まで」が実質無制限だった。
// Upstashへ永続化する(障害時はメモリ側のみで判断=可用性優先)。
async function consumeUnprotectedForceRun() {
  const today = appDateKey();
  if (unprotectedForceRuns.day !== today) unprotectedForceRuns = { day: today, count: 0 };
  if (unprotectedForceRuns.count >= UNPROTECTED_FORCE_RUN_MAX) return false;
  if (UPSTASH_ENABLED) {
    try {
      const n = await upstashCmd(["INCR", `learn:forceruns:${today}`]);
      if (Number(n) === 1) await upstashCmd(["EXPIRE", `learn:forceruns:${today}`, "172800"]).catch(() => {});
      if (Number(n) > UNPROTECTED_FORCE_RUN_MAX) return false;
    } catch (e) { /* 永続側が読めない場合はメモリ側のみで判断 */ }
  }
  unprotectedForceRuns.count++;
  return true;
}
async function tryAcquireDailyRunLock() {
  if (!UPSTASH_ENABLED) {
    // Upstashが無い環境では、従来どおりプロセス内フラグだけで保護する
    // (できないことを黙って「できたこと」にしない)。
    return { acquired: true, skipped: true, reasonJa: "Upstash未設定のため、プロセスをまたいだ多重起動の防止はできません。" };
  }
  try {
    const key = `learn:runlock:${appDateKey()}`;
    const result = await upstashCmd(["SET", key, new Date().toISOString(), "NX", "EX", String(DAILY_RUN_LOCK_SECONDS)]);
    // Upstashは取得成功で "OK"、既に存在して書き込まなかった場合は null を返す
    return { acquired: result === "OK" || result === true, skipped: false };
  } catch (e) {
    // ロックの取得可否が判断できない場合は、学習が一切動かなくなる方が困るため
    // 実行を許可する(安全側=可用性優先)。
    return { acquired: true, skipped: true, reasonJa: `実行ロックを確認できませんでした(${e.message})。` };
  }
}

// ============================================================================
// 2026年8月・API予算ガードの構造的修正(最優先のご指示)
// ----------------------------------------------------------------------------
// これまでは「APIを呼ぶ箇所それぞれで tryReserve() を呼ぶ」設計だったため、
// 呼び忘れた箇所(リーグ知識取得・クラブフォーム取得など大部分)が
// 予算を通らずに直接APIを叩いており、totalSpent が実消費と一致しなかった。
//
// 呼び出し側の規律に依存する設計そのものが原因なので、**予算チェックを
// callApiFootball の内部へ移す**。これにより、どこから呼んでも必ず
// 予算を通ることが構造的に保証され、「通らない呼び出し」が原理的に作れなくなる。
//
// 予算が尽きた場合は BUDGET_EXHAUSTED エラーを投げる。各呼び出し側は既に
// try/catch でAPIエラーを扱っているため、黙って失敗するのではなく
// 「予算不足で見送った」という理由付きのエラーとして伝わる。
// ============================================================================
const { createApiBudget: _createApiBudget, DEFAULT_DAILY_BUDGET: _DEF_BUDGET, DEFAULT_USER_RESERVE: _DEF_RESERVE } = require("./learning/apiBudget");

let globalApiBudget = null;
let globalApiBudgetDate = null;
// 第3次監査で発見した欠陥の修正: 同時に複数の呼び出しが来ると、
// init() の完了前に別の呼び出しが新しいインスタンスを作ってしまい、
// **前回までの消費(spentBefore)を読み込む前に予算を使えてしまう**
// (=1日の上限を超過しうる)。インスタンスではなく「生成中のPromise」を
// 共有することで、同時呼び出しでも必ず1つだけになるようにする。
let globalApiBudgetPromise = null;

async function getApiBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (globalApiBudget && globalApiBudgetDate === today) return globalApiBudget;
  if (globalApiBudgetPromise && globalApiBudgetDate === today) return globalApiBudgetPromise;
  // 第5次監査で発見した「日付またぎ(UTC 0時)の取り違え」の修正。
  //   これまでは globalApiBudgetDate だけを新しい日付へ書き換え、
  //   **前日のインスタンスが入ったままの globalApiBudget を消していなかった**。
  //   その結果:
  //     (1) init() の完了を待っている数百ミリ秒の間に来た呼び出しが、
  //         1行目の判定に一致して「前日のインスタンス」を受け取り、
  //         消費が前日のキーへ書き込まれる(新しい日の集計から消える)。
  //     (2) 23:59:59 と 00:00:00 の呼び出しが競合すると、後から解決した
  //         前日ぶんのPromiseが globalApiBudget を上書きし、日付は今日・
  //         中身は昨日という状態が**そのプロセスが生きている間ずっと続く**。
  //         前日に使い切っていれば、新しい日なのに1日中APIが使えなくなる。
  //   .github/workflows/predictions-auto-collect.yml は cron "0 */6 * * *"、
  //   つまりちょうどUTC 0時に発火するため、これは現実に起きうる。
  //   対策: 古いインスタンスを必ず捨て、init() 完了後にもう一度日付を確認してから
  //   共有変数へ格納する。
  globalApiBudget = null;
  globalApiBudgetDate = today;
  const creating = (async () => {
    // 保存済みのプラン判定があれば先に読み戻す(スリープ復帰対策)。
    // これをしないと、起動直後の予算が既定の100件になり、
    // 日次学習がリーグ・選手まで到達できない。
    await restoreDetectedPlan().catch(() => null);
    const detected = getApiPlanInfo();
    const manual = Number(process.env.API_DAILY_BUDGET) || null;
    // 実際の契約プランの上限を優先し、手動設定がそれを超える場合は安全側を採る
    const dailyBudget = (detected.detectedDailyLimit && manual)
      ? Math.min(detected.detectedDailyLimit, manual)
      : (detected.detectedDailyLimit || manual || _DEF_BUDGET);
    const instance = _createApiBudget({
      // upstashCmd を渡すと、予算カウンターが SET(上書き)ではなく
      // INCRBY(原子的な加算)で記録されるようになる。第5次監査で発見した
      // 「2プロセスが同時に書き戻すと片方の消費が消える」問題への対策。
      upstashEnabled: UPSTASH_ENABLED, upstashGetJSON, upstashSetJSON, upstashCmd,
      dailyBudget,
      userReserve: Number(process.env.API_USER_RESERVE) || _DEF_RESERVE,
    });
    await instance.init(today);
    // 生成中にさらに日付が変わっていたら、この結果は共有変数へ入れない
    // (古い日のインスタンスで新しい日を汚さないため)。呼び出し元へは返す。
    if (globalApiBudgetDate === today) {
      globalApiBudget = instance;
      lastFlushedBudget = instance;
    }
    return instance;
  })();
  globalApiBudgetPromise = creating;
  return creating;
}

// 予算の消費を定期的にUpstashへ書き戻す(毎回書くとUpstashへの負荷が高いため、
// 一定件数ごとにまとめて書く)。
// 欠陥Dの修正: 5回に1回しか書き戻さないと、プロセスが落ちた際に最大4件の
// 消費が記録から失われ、totalSpentが実消費より少なくなる(過小報告)。
// 書き戻し間隔を短くしつつ、直近の未書き戻し分がある場合は
// プロセス終了時にも必ず書き戻す。
let budgetWritesPending = 0;
let lastFlushedBudget = null;
async function maybeFlushBudget(budget) {
  lastFlushedBudget = budget;
  budgetWritesPending++;
  if (budgetWritesPending >= 2) {
    // 第5次監査の修正: これまでは flush() を呼ぶ前に未書き戻し件数を0へ
    // リセットしていたため、**Upstashが一時的に落ちて書き戻しに失敗しても
    // 「書き戻し済み」扱いになり、終了時の再書き戻しも行われなかった**。
    // 成功したときだけリセットする。
    const ok = await budget.flush().catch(() => false);
    if (ok !== false) budgetWritesPending = 0;
  }
}
// プロセス終了時の取りこぼし防止。
// 第3次監査で発見した欠陥の修正: SIGTERM/SIGINT にハンドラを登録すると
// Nodeの既定の終了動作を上書きしてしまい、**プロセスが終了しなくなる**
// (Render の再デプロイやスリープで SIGKILL 待ちになる)。
// シグナルを握る場合は、書き戻し後に必ず自分で終了させる。
async function flushBudgetOnExit() {
  if (lastFlushedBudget && budgetWritesPending > 0) {
    const ok = await lastFlushedBudget.flush().catch(() => false);
    if (ok !== false) budgetWritesPending = 0;
  }
}
process.on("beforeExit", () => { flushBudgetOnExit(); });
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await flushBudgetOnExit();
    process.exit(0); // 既定動作を上書きした以上、自分で確実に終了する
  });
}

// ---- 2026年8月・成長可視化ラウンド②: API成功率の常時計測 ----
// すべてのAPI-Football呼び出しがcallApiFootballを通るため、ここで成功/失敗を
// 数えるだけで正確なAPI成功率が出る(メモリカウンタのみ=負荷ゼロ。プロセス
// 起動からの累計で、perf欄とdaily-reportの学習品質パネルに実測値として出す)。
const apiCallStats = { attempts: 0, failures: 0, byCode: {} };
function recordApiCallOutcome(ok, code) {
  apiCallStats.attempts++;
  if (!ok) {
    apiCallStats.failures++;
    const key = code || "unknown";
    apiCallStats.byCode[key] = (apiCallStats.byCode[key] || 0) + 1;
  }
}
function apiCallStatsSnapshot() {
  return {
    attempts: apiCallStats.attempts,
    failures: apiCallStats.failures,
    successRatePct: apiCallStats.attempts ? Math.round(((apiCallStats.attempts - apiCallStats.failures) / apiCallStats.attempts) * 1000) / 10 : null,
    failuresByCode: { ...apiCallStats.byCode },
  };
}

async function callApiFootball(endpoint, params, opts) {
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

  // ---- 予算ガード(すべてのAPI呼び出しがここを必ず通る) ----
  const budget = await getApiBudget();
  // 欠陥Aの修正: 利用者のリクエストは「利用者用の予約枠」を含む全体から確保する。
  // 日次ジョブ(バッチ)だけが予約枠を残す側になる。opts.jobCall で区別する。
  const isJobCall = !!(opts && opts.jobCall);
  const reservation = isJobCall
    ? budget.tryReserve(1, `${endpoint}`)
    : budget.tryReserveUser(1, `${endpoint}`);
  if (!reservation.allowed) {
    const err = new Error(reservation.reason);
    err.code = "BUDGET_EXHAUSTED";
    err.budgetReasonJa = reservation.reason;
    throw err;
  }

  // 第5次監査で発見した欠陥の修正:
  //   これまでは fetch が例外(タイムアウト・ネットワーク断)を投げると、
  //   その下の maybeFlushBudget まで到達せず、**予約した1件が
  //   「未書き戻し件数」にすら数えられなかった**。API-Football側の障害で
  //   30件連続タイムアウトすると、30件ぶんの消費が記録から丸ごと消え、
  //   次のプロセスが古い値を読んで上限を超過する。予約は既に消費済みなので、
  //   成功・失敗にかかわらず必ず書き戻し対象に含める。
  //   (タイムアウトしたリクエストもAPI-Football側では消費として数えられるため、
  //    「失敗したら返却する」ではなく「数える」のが安全側の判断)
  let res;
  try {
    res = await fetchWithTimeout(url.toString(), { headers }, API_FOOTBALL_TIMEOUT_MS);
  } catch (e) {
    recordApiCallOutcome(false, e.code || "network"); // 成長可視化ラウンド②: 失敗を数える
    throw e;
  } finally {
    await maybeFlushBudget(budget);
  }
  // 2026年8月・優先順位⑪: API-Footballは全レスポンスに、そのAPIキーの
  // 「1日の上限」と「本日の残り」をヘッダーで返してくる。これを読んでおけば、
  // 契約プラン(無料100/日・Pro7500/日など)をアプリ自身が自動判定できるため、
  // 利用者がAPI_DAILY_BUDGETを手で設定する必要が無くなる(設定し忘れ・
  // 設定間違いによる予算超過事故を根本的に防げる)。
  recordRateLimitHeaders(res);
  // 欠陥Bの修正: 契約プランの上限は最初のAPI応答で初めて分かる。
  // 予算インスタンスは既定値(100)で作られているため、判明した実際の上限を反映する
  // (これをしないと、Proに加入していても1日100件として扱われ続けていた)。
  const planNow = getApiPlanInfo();
  const detectedNow = planNow.detectedDailyLimit;
  if (detectedNow) {
    const manual = Number(process.env.API_DAILY_BUDGET) || null;
    budget.updateDailyBudget(manual ? Math.min(detectedNow, manual) : detectedNow);
    // 第5次監査での改善: API-Football自身が「本日の残り」を毎回返してくれる。
    // 自前のカウンターは、タイムアウト・別プロセスの消費・強制終了などで
    // 必ず実態からズレるため、本家の数字で上書き補正する(増やす方向のみ)。
    // これにより予算ガードが自己修復するようになる。
    if (typeof budget.reconcileFromRemaining === "function" && !manual) {
      budget.reconcileFromRemaining(planNow.detectedRemaining);
    }
  }
  if (!res.ok) {
    recordApiCallOutcome(false, `http_${res.status}`);
    const err = new Error(`API-Football HTTP ${res.status}`);
    err.code = "HTTP_ERROR";
    throw err;
  }
  const json = await res.json();
  const errCount = Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors || {}).length;
  if (errCount) {
    recordApiCallOutcome(false, "api_error");
    const err = new Error("API-Football error: " + JSON.stringify(json.errors));
    err.code = "API_ERROR";
    throw err;
  }
  recordApiCallOutcome(true, null);
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

async function searchTeamsWithRetry(name, attempts = 2, delayMs = 400, opts) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await callApiFootball("/teams", { search: name }, opts);
      return { list: data.response || [], error: null };
    } catch (e) {
      // 2026年8月・再監査で発見した欠陥Eの修正:
      // 予算切れ(BUDGET_EXHAUSTED)まで再試行して握り潰していたため、
      // 利用者には「クラブが特定できませんでした(team_not_found)」という
      // **まったく誤った理由**が表示されていた。予算切れは再試行しても
      // 解決しないので、そのまま上位へ伝えて正しい理由を出す。
      if (e && e.code === "BUDGET_EXHAUSTED") throw e;
      lastError = e;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  return { list: [], error: lastError };
}

// 第3次監査で発見した欠陥の修正: 日次ジョブが呼ぶ resolveTeamId は
// jobCall フラグを持たないため、/teams の検索(再試行含む)が利用者の予約枠から
// 消費されていた。予約枠を守る意味が無くなるので、opts を最後まで通す。
async function resolveTeamId(teamNameEnglish, opts) {
  const name = (teamNameEnglish || "").trim();
  if (!name) return null;
  const cacheKey = `team-id:${name.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let list = [];
  let hadTransientError = false;

  const first = await searchTeamsWithRetry(name, 2, 400, opts);
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
      const retry = await searchTeamsWithRetry(variant, 2, 400, opts);
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
  const cacheKey = cacheKeyOf("resolve", [name, teamHint, season, birthHint || "", teamEnglishHint || ""]);
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let results = [];
  // 第6次監査での追加: 一時的な障害があったかどうかを覚えておき、
  // 「本当に見つからない」場合だけ結果をキャッシュする(resolveTeamIdと同じ設計)。
  let hadTransientError = false;

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
          // 第4次監査で発見した欠陥の修正: 予算切れは名前の綴り違いではないので
          // 次の候補を試しても意味がなく、「選手が見つからない」という誤った理由に
          // 化けたうえ6時間キャッシュされてしまう(キャッシュ汚染)。そのまま伝播させる。
          if (e && e.code === "BUDGET_EXHAUSTED") throw e;
          // 第6次監査で発見した同種の欠陥: タイムアウトや5xxも「見つからない」に
          // 化けて1時間キャッシュされていた。resolveTeamId(下記)は既に
          // hadTransientError を見て「見つからない」をキャッシュしない設計に
          // なっているのに、選手側にはその仕組みが無かった。
          hadTransientError = true;
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
          if (e && e.code === "BUDGET_EXHAUSTED") throw e; // 同上(予算切れは再試行で解決しない)
          // リーグIDがそのシーズンに存在しない等の「正常な空振り」と、
          // タイムアウト等の一時障害を区別する(後者は「見つからない」と
          // 断定してキャッシュしてはいけない)。
          // 第8次監査(High)の修正: API_ERROR(API-Footballのクォータ超過等は
          // HTTP 200+errorsで返るためこのコードになる)とNO_KEY(キー未設定)が
          // 一時障害の判定から漏れており、「クォータを使い切った日の午後は実在の
          // 選手が全員6時間『見つかりません』とキャッシュされる」状態だった。
          // どちらも選手の不存在を意味しないので、断定キャッシュを禁止する。
          if (e && (e.code === "TIMEOUT" || e.code === "HTTP_ERROR" || e.code === "API_ERROR" || e.code === "NO_KEY" || /timeout|network|fetch/i.test(e.message || ""))) {
            hadTransientError = true;
          }
          // this league/season combo errored (e.g. league id not valid for this season) — try the next one
        }
      }
    }
  }
  if (!results.length) {
    // 第6次監査で発見した欠陥の修正:
    //   一時的な通信障害で1件も取れなかった場合まで「この選手は存在しない」と
    //   確定させ、1時間キャッシュしていた(さらに呼び出し元が
    //   reason:"player_not_found" として6時間キャッシュするため、最大で
    //   数時間ものあいだ実在する選手が「見つかりません」と表示され続けた)。
    //   一時障害のときはキャッシュせず、次のリクエストでやり直せるようにする。
    if (hadTransientError) {
      const err = new Error("選手情報の取得中に一時的な障害が発生しました(時間をおいて再度お試しください)。");
      err.code = "TRANSIENT_ERROR";
      throw err;
    }
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
    // 第7次監査で発見した欠陥の修正:
    //   API側のチーム名が空文字だと `hintLower.includes("")` が常にtrueになり、
    //   同姓の無関係な選手が「クラブ名が一致した」として選ばれていた。
    const match = results.find((r) =>
      (r.statistics || []).some((st) => {
        const teamName = ((st.team && st.team.name) || "").toLowerCase();
        if (!teamName || !hintLower) return false;
        return teamName.includes(hintLower) || hintLower.includes(teamName);
      })
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
  // 第7次監査で発見した欠陥の修正:
  //   ?season= に範囲の検査が無かったため、`?season=99999` のような値でも
  //   鍵が変わり、そのたびに21〜42件の選手検索APIが走った(認証不要のGETから
  //   API予算を焼き切れる状態)。実在しうる範囲に収める。
  // 2026年8月・150問検証で発見した問題への対応:
  //   応答に利用者の入力(選手名)をそのまま反射していた。画面側では
  //   escapeHtml しているため現時点で実害は無いが、このAPIを別の場所で
  //   使ったときに危険になる。サーバー側でも記号を落としてから返す。
  //   (検索そのものには元の文字列を使い、応答へ載せる名前だけを清書する)
  const safeEcho = (v) => String(v || "").replace(/[<>"'`&]/g, "").slice(0, 60);
  const seasonRaw = parseInt(query.get("season"), 10);
  const nowYear = new Date().getUTCFullYear();
  const season = String(Number.isFinite(seasonRaw) && seasonRaw >= 2000 && seasonRaw <= nowYear + 1
    ? seasonRaw
    : guessSeason());
  if (!name) return { status: 400, body: { found: false, error: "name is required" } };
  // 名前の長さにも上限を設ける(異常に長い文字列で鍵を無限に増やせないように)
  if (name.length > 60) return { status: 400, body: { found: false, error: "name is too long" } };

  const cacheKey = cacheKeyOf("season-stats", [name, team, teamEn, birth, season]);
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
      const payload = { found: false, reason: "player_not_found", name: safeEcho(name), season: seasonBase };
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
      const payload = { found: false, reason: "no_statistics", name: safeEcho(name), season: seasonBase };
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
async function getOrLogPrediction(fixtureId, meta, opts) {
  const key = `pred:${fixtureId}`;
  const existing = await upstashGetJSON(key);
  if (existing) return existing;
  if (!UPSTASH_ENABLED) return null;
  try {
    // 第8次監査(Medium)の修正: cron(auto-collect)からの呼び出しはjobCallとして計上する
    const data = await callApiFootball("/predictions", { fixture: fixtureId }, { jobCall: !!(opts && opts.jobCall) });
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
    // ---- 2026年8月・調査で見つけた二重計上の穴 ----
    //   upstashGetJSON は「まだ無い」ときも「読み出しに失敗した」ときも
    //   同じ null を返す。つまりUpstashが一瞬詰まった隙に同じ試合をもう一度
    //   記録し、pred:total を二重に数え、pred:pending にも同じIDが2つ並んでいた。
    //   「この試合を数えてよいのは最初の1回だけ」を SET NX で保証する
    //   (resolvePrediction 側の pred:resolvelock と同じ考え方)。
    // ---- 検証で発見した順序の誤りの修正 ----
    //   従来は「本体を保存 → NXで印を付ける」の順だった。ところが
    //   upstashSetJSON は失敗しても false を返すだけ(例外を投げない)なので、
    //   本体の保存に一度でも失敗すると
    //     ・pred:logged の印だけが残り(TTLも無い)
    //     ・pred:total(正答率の分母)だけが増え
    //     ・次に同じ試合を記録できても firstTime=false のため
    //       **pred:pending に二度と載らず、永久に答え合わせされない**
    //   という、分母だけが水増しされる最悪の状態になっていた。
    //   本体が確実に保存できたときだけ数える順序に直し、印にもTTLを付ける。
    const savedOk = (await upstashSetJSON(key, record)) !== false;
    if (!savedOk) return null; // 保存できていないものを「記録した」とは数えない
    let firstTime = true;
    try {
      // 印は90日で自然に消える(試合の記録より長く残す意味は無い)
      const claim = await upstashCmd(["SET", `pred:logged:${fixtureId}`, record.loggedAt, "NX", "EX", "7776000"]);
      firstTime = claim === "OK" || claim === true;
    } catch (e) { firstTime = true; } // 判定できない場合は記録する側に倒す
    if (firstTime) {
      await upstashCmd(["RPUSH", "pred:pending", String(fixtureId)]).catch(() => {});
      await upstashCmd(["INCR", "pred:total"]).catch(() => {});
      await upstashCmd(["SET", "pred:since", record.loggedAt, "NX"]).catch(() => {});
    } else {
      // 印はあるのに保留リストに載っていない = 過去の障害の取り残し。ここで復旧する。
      try {
        const pending = (await upstashCmd(["LRANGE", "pred:pending", "0", "-1"])) || [];
        if (!pending.includes(String(fixtureId))) {
          await upstashCmd(["RPUSH", "pred:pending", String(fixtureId)]).catch(() => {});
        }
      } catch (e) { /* 復旧は best effort。失敗しても本体の記録は残る */ }
    }
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

  // ---- 2026年8月・第7次監査で発見した二重計上の修正 ----
  //   「読む→resolvedか確認する→カウンターを増やす」の間に await が挟まるため、
  //   同じ試合に対して3つの入口(/api/fixtures/today の一括検証・
  //   /api/fixtures/analysis・6時間ごとのcron)が同時に走ると、
  //   両方が `record.resolved === false` を見て**両方ともカウンターを増やして**
  //   いた。ホーム画面の「AI予測の正答率」——このアプリで唯一の
  //   「でっち上げていない数字」——が水増しされ、pred:recent にも同じ試合が
  //   二重に並ぶ状態だった。
  //   Redisの SET ... NX(まだ無いときだけ書ける)を鍵にして、
  //   **カウンターを増やしてよいのは最初の1つだけ**にする。
  // 2026年8月・正答率が更新されない調査での修正:
  //   従来は「ロックのSETが例外を投げたら数えない(mayCount=false)」としつつ、
  //   その直後で record.resolved = true を保存し、pred:pending からも削除していた。
  //   つまりUpstashが一瞬詰まっただけで、その試合は**二度と数えられない**
  //   (次回は resolved=true で早期returnする)。正答率が動かない原因の一つ。
  //   自社予測側(dailyJob.js)は既に .catch(() => "OK") で「取りこぼすより
  //   二重計上を避ける」ではなく「数える側」に倒しており、そちらに揃える。
  let mayCount = true;
  try {
    const claim = await upstashCmd(["SET", `pred:resolvelock:${fixtureId}`, new Date().toISOString(), "NX", "EX", "86400"]);
    mayCount = claim === "OK" || claim === true;
  } catch (e) {
    mayCount = true; // ロックの可否を判定できない=数える側に倒す(恒久的な取りこぼしを防ぐ)
  }

  record.resolved = true;
  record.actualWinner = actualWinner;
  record.correct = correct;
  record.resolvedAt = new Date().toISOString();

  await upstashSetJSON(key, record);
  await upstashCmd(["LREM", "pred:pending", "0", String(fixtureId)]).catch(() => {});
  if (mayCount) {
    await upstashCmd(["INCR", "pred:resolved"]).catch(() => {});
    if (correct) await upstashCmd(["INCR", "pred:correct"]).catch(() => {});
    await upstashCmd(["RPUSH", "pred:recent", JSON.stringify(record)]).catch(() => {});
    await upstashCmd(["LTRIM", "pred:recent", "-20", "-1"]).catch(() => {});
  }
  return record;
}

// ホーム画面に表示する「AI予測の実績」の集計値を返す。Upstash未設定の場合は
// 正直に「記録なし」を返す(架空の数字は絶対に出さない)。
/* ============================================================================
   2026年8月7日・「昨日と今日で何が変わったのか、利用者に伝わらない」への対処
   ----------------------------------------------------------------------------
   ご指摘:
     > Knowledge が増えた / Memory が増えた / RAG を実装した と言われても
     > 利用者からすると「だから何？」という状態です。

   まったくその通りで、これまで画面に出していたのは **内部の件数** だけだった。
   件数をいくら出しても「賢くなった」は伝わらない。

   ここで返すのは、利用者が **自分で確かめられる具体的な変化** に限る:
     ・答え合わせできた試合(実際のスコアと、AIの予想が当たったか外れたか)
     ・検索できる選手が何人増えたか(増えた選手の名前つき)
     ・平均評価が上がった/下がった選手(実測の数値差つき)
     ・クラブに起きた変化(移籍・怪我・調子。実測の差分から検知したものだけ)
     ・予測モデルの重みが更新されたか(されていないならその理由)

   計算できないものは「計算できません」と理由つきで返す(でっち上げない)。

   比較の土台となる「その日のスナップショット」は、この画面が開かれたときに
   1日1回だけ保存する(毎日の学習が途中で止まっても比較が続けられるように、
   学習ジョブとは切り離してある)。
   ============================================================================ */
async function buildDailySnapshot() {
  const idx = await loadPlayerIndex(false).catch(() => null);
  const rows = (idx && idx.rows) || [];
  const C = playerSearch.COL;
  const [totalRaw, resolvedRaw, correctRaw, knowledgeRaw] = await Promise.all([
    upstashCmd(["GET", "pred:total"]).catch(() => null),
    upstashCmd(["GET", "pred:resolved"]).catch(() => null),
    upstashCmd(["GET", "pred:correct"]).catch(() => null),
    upstashCmd(["GET", "learn:knowledge:total"]).catch(() => null),
  ]);
  const resolved = parseInt(resolvedRaw, 10) || 0;
  const correct = parseInt(correctRaw, 10) || 0;
  return {
    at: new Date().toISOString(),
    dateKey: appDateKey(),
    playerIndexCount: rows.length,
    playerIndexClubs: new Set(rows.map((r) => r[C.teamEn]).filter(Boolean)).size,
    playerIndexWithRating: rows.filter((r) => r[C.rating] !== null && r[C.rating] !== undefined).length,
    // 名前は先頭2,000人ぶんだけ持つ(比較のためだけなので、これで十分)
    playerIds: rows.slice(0, 2000).map((r) => Number(r[C.id])),
    predTotal: parseInt(totalRaw, 10) || 0,
    predResolved: resolved,
    predCorrect: correct,
    accuracyPct: resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null,
    knowledgeTotal: parseInt(knowledgeRaw, 10) || null,
  };
}

async function handleDailyDiff() {
  if (!UPSTASH_ENABLED) {
    return { status: 200, body: { ok: true, available: false, reasonJa: "保存先(Upstash)が未設定のため、昨日との比較ができません。" } };
  }
  const cached = cacheGet("daily:diff");
  if (cached) return { status: 200, body: { ...cached, cached: true } };

  const todayKey = appDateKey();
  const yKey = appDateKey(new Date(Date.now() - 86400000));
  const snapKey = (k) => `kb:daily:snapshot:${k}`;

  // ---- 今日のスナップショット(無ければ作って保存する) ----
  let today = await upstashGetJSON(snapKey(todayKey)).catch(() => null);
  const freshlyCreated = !today;
  if (!today) {
    today = await buildDailySnapshot();
    await upstashSetJSON(snapKey(todayKey), today).catch(() => {});
    await upstashCmd(["EXPIRE", snapKey(todayKey), String(30 * 86400)]).catch(() => {});
  }
  const yesterday = await upstashGetJSON(snapKey(yKey)).catch(() => null);

  const idx = await loadPlayerIndex(false).catch(() => null);
  const rows = (idx && idx.rows) || [];
  const C = playerSearch.COL;

  /* ---- ① 答え合わせできた試合(実際のスコアつき) ---- */
  const recentRaw = (await upstashCmd(["LRANGE", "pred:recent", "-40", "-1"]).catch(() => [])) || [];
  const recent = recentRaw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  const since = Date.now() - 36 * 3600 * 1000;
  const resolvedRecently = recent
    .filter((r) => r && r.resolved && r.resolvedAt && new Date(r.resolvedAt).getTime() >= since)
    .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)))
    .slice(0, 8)
    .map((r) => ({
      home: r.home, away: r.away, league: r.league,
      kickoff: r.kickoff, resolvedAt: r.resolvedAt,
      score: (r.homeGoals !== undefined && r.awayGoals !== undefined && r.homeGoals !== null)
        ? `${r.homeGoals}-${r.awayGoals}` : null,
      predictedWinnerJa: r.predictedWinner === "home" ? `${r.home}勝利`
        : r.predictedWinner === "away" ? `${r.away}勝利` : "引き分け",
      actualWinnerJa: r.actualWinner === "home" ? `${r.home}勝利`
        : r.actualWinner === "away" ? `${r.away}勝利` : "引き分け",
      correct: r.correct === true,
    }));

  const accBefore = yesterday && yesterday.accuracyPct !== null && yesterday.accuracyPct !== undefined ? yesterday.accuracyPct : null;
  const accAfter = today.accuracyPct;
  const predictions = {
    available: resolvedRecently.length > 0,
    items: resolvedRecently,
    resolvedCount: resolvedRecently.length,
    hitCount: resolvedRecently.filter((x) => x.correct).length,
    accuracyBefore: accBefore, accuracyAfter: accAfter,
    accuracyDeltaPt: (accBefore !== null && accAfter !== null) ? Math.round((accAfter - accBefore) * 10) / 10 : null,
    reasonJa: resolvedRecently.length ? null
      : "この36時間で答え合わせできた試合がありません(試合が終わり次第、自動で反映されます)。",
  };

  /* ---- ② 検索できる選手が何人増えたか ---- */
  const prevIds = new Set((yesterday && yesterday.playerIds) || []);
  const newlySearchable = prevIds.size
    ? rows.filter((r) => !prevIds.has(Number(r[C.id]))).slice(0, 12)
      .map((r) => ({ id: r[C.id], name: r[C.name], teamJa: r[C.teamJa] || r[C.teamEn] }))
    : [];
  const playerIndexDiff = {
    countToday: today.playerIndexCount,
    countYesterday: yesterday ? yesterday.playerIndexCount : null,
    delta: yesterday ? today.playerIndexCount - yesterday.playerIndexCount : null,
    clubsToday: today.playerIndexClubs,
    clubsYesterday: yesterday ? yesterday.playerIndexClubs : null,
    newlySearchable,
    reasonJa: yesterday ? null : "昨日のスナップショットがまだありません(この画面を1日1回開くと、翌日から差分が出せます)。",
  };

  /* ---- ③ 平均評価が上がった/下がった選手(索引の実測差) ---- */
  const withDelta = rows
    .map((r) => ({ row: r, g: playerSearch.growthOf(r) }))
    .filter((x) => x.g && x.g.measurable && Math.abs(x.g.delta) >= 0.05);
  const toItem = (x) => ({
    id: x.row[C.id], name: x.row[C.name], teamJa: x.row[C.teamJa] || x.row[C.teamEn],
    from: x.g.baseRating, to: x.g.currentRating, delta: x.g.delta, days: x.g.days,
  });
  const playerForm = {
    available: withDelta.length > 0,
    up: withDelta.filter((x) => x.g.delta > 0).sort((a, b) => b.g.delta - a.g.delta).slice(0, 5).map(toItem),
    down: withDelta.filter((x) => x.g.delta < 0).sort((a, b) => a.g.delta - b.g.delta).slice(0, 5).map(toItem),
    measuredCount: withDelta.length,
    reasonJa: withDelta.length ? null
      : (rows.length
        ? "平均評価の変化を測れる選手がまだいません(同じ選手を2日以上続けて取得できると測れるようになります)。"
        : "選手の索引がまだ作られていないため、評価の変化を測れません。"),
    methodJa: "毎日取得している平均評価の実測値どうしの差です。推定値や独自スコアではありません。",
  };

  /* ---- ④ クラブ・選手に起きた変化(実測の差分から検知したものだけ) ---- */
  const feed = await clubDossier.getScoutFeed(40).catch(() => ({ items: [] }));
  const feedSince = Date.now() - 48 * 3600 * 1000;
  const changes = (feed.items || [])
    .filter((it) => it && it.at && new Date(it.at).getTime() >= feedSince)
    .slice(0, 10)
    .map((it) => ({
      type: it.type, name: it.name, teamJa: it.teamJa || it.teamEn,
      labelJa: it.labelJa, detailJa: it.detailJa, at: it.at,
    }));
  const clubChanges = {
    available: changes.length > 0,
    items: changes,
    reasonJa: changes.length ? null
      : "この48時間で検知した移籍・調子の急変はありません(実測値が動いたときにだけ記録します)。",
  };

  /* ---- ⑤ AIの見解が昨日から変わったクラブ(AI自身の言葉での差分) ----
     ご指摘「AI回答が昨日より賢くなったのか分からない」への直接の答え。
     この記録(見解・変わった理由)は以前から毎日保存されていたのに、
     **画面から読む経路が1本も無かった**。ここで初めて表に出す。 */
  const viewChanges = [];
  const viewSince = Date.now() - 72 * 3600 * 1000;
  for (const team of REGISTERED_TEAMS.slice(0, 11)) {
    try {
      const key = `team:${team.nameEn}:dailyView`;
      const [cur, hist] = await Promise.all([
        memoryStore.getLastConclusion(key),
        memoryStore.getConclusionHistory(key, 3),
      ]);
      if (!cur || !cur.statement) continue;
      const prev = (hist || [])[0];
      if (!prev || !prev.statement) continue;
      const changedAt = prev.supersededAt || cur.computedAt;
      if (!changedAt || new Date(changedAt).getTime() < viewSince) continue;
      viewChanges.push({
        teamJa: team.nameJa, teamEn: team.nameEn,
        before: prev.statement, after: cur.statement,
        changeReasonJa: prev.changeReason || cur.changeReason || null,
        changedAt,
      });
    } catch (e) { /* 1クラブ読めなくても他を止めない */ }
    if (viewChanges.length >= 4) break;
  }
  const aiViews = {
    available: viewChanges.length > 0,
    items: viewChanges,
    reasonJa: viewChanges.length ? null
      : "この72時間で、AIのクラブ評価が変わったものはありません(見解が変わったときにだけ記録します。毎日の学習が2回以上完了している必要があります)。",
    methodJa: "AI自身がその日の実測値をもとに書いた「このクラブをどう見ているか」の文章です。変わったときだけ、前の文章と並べて出しています。",
  };

  /* ---- ⑥ 予測モデルの重み ---- */
  const growth = await upstashGetJSON("learn:growthlog:latest").catch(() => null);
  const model = {
    lastLearnedDate: growth && growth.date ? growth.date : null,
    weightsUpdated: growth ? (growth.weightsUpdatedV2 === true || growth.weightsUpdated === true) : null,
    reasonJa: !growth ? "学習の記録がまだありません。"
      : (growth.weightsUpdatedV2 === true || growth.weightsUpdated === true)
        ? "検証で改善が確認できたため、予測の重みを更新しました。"
        : "検証で改善が確認できなかったため、重みは更新していません(悪化させないための仕組みです)。",
  };

  /* ---- ⑥ 学習そのものが動いているか ---- */
  const progress = await upstashGetJSON("learn:progress").catch(() => null);
  const learningRun = {
    lastDate: growth && growth.date ? growth.date : null,
    isTodayDone: !!(growth && growth.date === todayKey),
    lastStage: progress ? progress.stage : null,
    lastStageAt: progress ? progress.at : null,
    finished: progress ? progress.finished === true : null,
    reasonJa: !growth ? "毎日の学習がまだ一度も完了していません。"
      : growth.date === todayKey ? "本日の学習は完了しています。"
        : `最後に完了した学習は ${growth.date} 分です。${progress && !progress.finished ? `本日の学習は「${progress.stage}」の段階で止まっています。` : "本日分はまだ完了していません。"}`,
  };

  /* ---- 総合判定: 利用者から見て「昨日と変わったか」 ---- */
  const evidence = [];
  if (predictions.resolvedCount > 0) {
    evidence.push(`試合の答え合わせが${predictions.resolvedCount}件進みました(的中${predictions.hitCount}件)`);
  }
  if (playerIndexDiff.delta !== null && playerIndexDiff.delta > 0) {
    evidence.push(`検索できる選手が${playerIndexDiff.delta}人増えました`);
  }
  if (playerForm.up.length || playerForm.down.length) {
    evidence.push(`平均評価が動いた選手を${playerForm.measuredCount}人検知しました`);
  }
  if (clubChanges.items.length) {
    evidence.push(`移籍・調子の変化を${clubChanges.items.length}件検知しました`);
  }
  if (viewChanges.length) {
    evidence.push(`AIのクラブ評価が${viewChanges.length}件変わりました`);
  }
  const verdictJa = evidence.length
    ? `昨日から次の変化がありました: ${evidence.join("、")}。`
    : "昨日と比べて、利用者から見える変化はまだ検知できていません。" +
      (learningRun.isTodayDone ? "" : "毎日の学習が本日まだ完了していないことが原因の可能性があります。");

  const body = {
    ok: true, available: true,
    date: todayKey, comparedWith: yesterday ? yKey : null,
    firstDayJa: yesterday ? null
      : "昨日のスナップショットがまだ無いため、今回は「今日の状態」だけを表示しています。明日から本当の差分が出ます。",
    snapshotCreatedNow: freshlyCreated,
    verdictJa,
    evidenceCount: evidence.length,
    predictions, playerIndex: playerIndexDiff, playerForm, clubChanges, aiViews, model, learningRun,
    honestyJa: "ここに出しているのは、すべて実測値の差分です。件数だけの指標(Knowledge件数・Memory件数など)は、利用者が確かめられないためこの欄には出していません。",
    generatedAt: new Date().toISOString(),
  };
  cacheSet("daily:diff", body, 5 * 60 * 1000);
  return { status: 200, body };
}

async function handleAccuracyStats() {
  if (!UPSTASH_ENABLED) {
    // 2026年8月・全機能監査の指摘: 0を返すだけで**理由が付いていなかった**。
    // 「まだ0件」と「保存先が無いので永久に0」を利用者が区別できない。
    return {
      status: 200,
      body: {
        configured: false, total: 0, resolved: 0, correct: 0, accuracyPct: null,
        since: null, pending: null, lastResolvedAt: null, recent: [],
        reasonJa: "予測の記録先(Upstash Redis)が設定されていないため、AI予測の実績を記録・集計できません。Renderの環境変数 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を設定すると記録が始まります。",
      },
    };
  }
  try {
    const [totalRaw, resolvedRaw, correctRaw, since, recentRaw, pendingRaw] = await Promise.all([
      upstashCmd(["GET", "pred:total"]),
      upstashCmd(["GET", "pred:resolved"]),
      upstashCmd(["GET", "pred:correct"]),
      upstashCmd(["GET", "pred:since"]),
      upstashCmd(["LRANGE", "pred:recent", "-10", "-1"]),
      // 2026年8月の調査で追加: 「正答率が何日も動かない」ときに、
      // 答え合わせ待ちの行列が伸び続けているのかどうかを外から確認できるようにする。
      upstashCmd(["LLEN", "pred:pending"]).catch(() => null),
    ]);
    // ---- 2026年8月・「正答率が何日も動かない」への回答責任 ----
    //   これまで、外から見て分かるのは「保留15件」だけだった。
    //   ・自動照合(6時間ごとのcron)がそもそも走っているのか
    //   ・保留の試合はまだ終わっていないのか、終わったのに照合できないのか
    //   が誰にも分からず、「正常です」としか答えられない状態だった。
    //   実行の記録と、保留リストの中身の内訳を返す。
    const lastRun = await upstashGetJSON("pred:autocollect:lastrun").catch(() => null);
    let pendingDetail = null;
    try {
      const ids = (await upstashCmd(["LRANGE", "pred:pending", "0", "40"])) || [];
      const now = Date.now();
      let awaitingKickoff = 0, dueForCheck = 0, unreadable = 0, oldestKickoff = null;
      for (const idStr of ids) {
        const rec = await upstashGetJSON(`pred:${idStr}`).catch(() => null);
        if (!rec) { unreadable++; continue; }
        const ko = rec.kickoff ? new Date(rec.kickoff).getTime() : null;
        if (ko && (!oldestKickoff || ko < oldestKickoff)) oldestKickoff = ko;
        if (ko && (now - ko) < AUTO_COLLECT_RESOLVE_MIN_AGE_MS) awaitingKickoff++;
        else dueForCheck++;
      }
      pendingDetail = {
        sampled: ids.length,
        awaitingKickoff,     // まだ試合中・未開催(照合できなくて当然)
        dueForCheck,         // 試合は終わっているはずなのに照合されていない
        unreadable,          // 記録本体が読めない(3回で自動的に外れる)
        oldestKickoff: oldestKickoff ? new Date(oldestKickoff).toISOString() : null,
        resolveCapPerRun: AUTO_COLLECT_RESOLVE_CAP,
      };
    } catch (e) { pendingDetail = { error: e.message }; }
    const total = parseInt(totalRaw, 10) || 0;
    const resolved = parseInt(resolvedRaw, 10) || 0;
    const correct = parseInt(correctRaw, 10) || 0;
    const pending = Number.isFinite(Number(pendingRaw)) ? Number(pendingRaw) : null;
    const accuracyPct = resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null;
    const recent = (recentRaw || [])
      .map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
      .filter(Boolean)
      .reverse();
    const lastResolvedAt = recent.length ? (recent[0].resolvedAt || null) : null;
    // 「なぜ数字が動かないのか」を、推測ではなく実測から言い切る
    // 時計のずれや未来日時で「-2時間前」のような表示にならないよう0で止める
    const hoursSince = (iso) => {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) return null;
      return Math.max(0, Math.round((Date.now() - t) / 3600000));
    };
    const sinceLastRunH = lastRun ? hoursSince(lastRun.at) : null;
    let stalledReasonJa = null;
    if (!lastRun) {
      stalledReasonJa = "自動照合が一度も実行を記録していません。サイトを開くと1時間ごとに自動で走る仕組みですが、それも記録が無い状態です(保存先への接続をご確認ください)。";
    } else if (sinceLastRunH !== null && sinceLastRunH >= 3) {
      stalledReasonJa = `自動照合の最後の実行が${sinceLastRunH}時間前です(サイトを開くと1時間ごとに自動で走ります)。しばらく誰もサイトを開いていないか、定期実行が止まっている可能性があります。`;
    } else if (pendingDetail && pendingDetail.dueForCheck === 0 && pending > 0) {
      stalledReasonJa = "答え合わせ待ちの試合はすべて『まだ終わっていない』状態です。試合が終われば自動的に正答率へ反映されます(異常ではありません)。";
    } else if (pendingDetail && pendingDetail.dueForCheck > 0 && sinceLastRunH !== null && sinceLastRunH < 3) {
      // 直前の実行で「見たのに1件も解決しなかった」場合は、その理由を状態別に出す
      const tally = (lastRun && lastRun.statusTally) || null;
      const sawNothingResolvable = lastRun && lastRun.resolved === 0 && lastRun.evicted === 0
        && tally && Object.keys(tally).length > 0;
      if (sawNothingResolvable) {
        const parts = Object.entries(tally).map(([k, v]) => `${STATUS_LABELS_JA[k] || k} ${v}件`).join(" / ");
        stalledReasonJa = `直前の自動照合で${parts}を確認しましたが、まだ結果が確定していないため答え合わせできませんでした`
          + `(日程変更などで「未開始」に戻った試合が含まれます)。変更後の日程を記録に反映したので、次回は別の試合を確認します。`;
      } else {
        stalledReasonJa = `終了しているはずの試合が${pendingDetail.dueForCheck}件、答え合わせ待ちのまま残っています。1回の実行で照合できるのは${AUTO_COLLECT_RESOLVE_CAP}件までのため、順次消化されます。`;
      }
    }
    return {
      status: 200,
      body: {
        configured: true, total, resolved, correct, accuracyPct, since: since || null,
        pending, lastResolvedAt, recent,
        lastAutoCollect: lastRun || null,
        statusLabelsJa: STATUS_LABELS_JA,
        hoursSinceLastAutoCollect: sinceLastRunH,
        hoursSinceLastResolved: hoursSince(lastResolvedAt),
        pendingDetail,
        stalledReasonJa,
        noteJa: "この正答率は API-Football が提供する予測の的中率です(自社モデルの実力ではありません)。自社モデルの検証結果は学習ダッシュボードをご覧ください。",
      },
    };
  } catch (e) {
    return { status: 200, body: { configured: true, error: e.message, reasonJa: `予測実績の読み出しに失敗しました(${e.message})。0件という意味ではなく、集計できなかったという意味です。`, total: 0, resolved: 0, correct: 0, accuracyPct: null, since: null, pending: null, lastResolvedAt: null, recent: [] } };
  }
}

// Leagues/competitions to hide from "today's real fixtures" even though
// API-Football includes them in an unrestricted /fixtures?date=... response —
// youth, reserve, and women's competitions clutter a fan-facing app whose
// registered players are all senior men's footballers.
// 2026年8月・「TOP100の試合が漏れていないか」調査で発見した誤検出の修正:
//   `ii` を単独の語として除外していたため、"Liga II"(ルーマニア2部)、
//   "II liga"(ポーランド3部)、"Prva II HNL" など**トップリーグ直下の
//   実在リーグが丸ごと消えていた**。除外したかったのは "Arsenal II" のような
//   リザーブチーム表記なので、チーム名側で判定する(SECONDARY_SQUAD_REと同じ考え方)。
//   リーグ名の除外からは `ii` を外す。
const FIXTURE_NAME_DENYLIST = /\b(u1[5-9]|u2[0-3]|women|female|femenina|feminine|reserve|reserves|youth|academy|futsal|beach soccer)\b/i;
// チーム名の末尾が " II" / " B" のものはリザーブ(2軍)。リーグ名ではなくチーム名で判定する。
const FIXTURE_TEAM_RESERVE_RE = /(\bII\b|\bB\b)\s*$/;

async function handleFixturesToday(query, opts) {
  // 第8次監査(Medium)の修正×2:
  //  (1) auto-collect(cron)から呼ばれた場合は jobCall として予算計上し、
  //      利用者用の予約枠(USER_REQUEST_RESERVE)をcronが食い潰さないようにする。
  //  (2) API-Footballの date= はUTC解釈のため、従来は「UTCでその日付」の窓
  //      (JST 9:00〜翌8:59)になっており、日本の1日と一致していなかった。
  //      timezone=Asia/Tokyo を併用して「日本時間のその日」の試合を取得する。
  const fxCallOpts = { jobCall: !!(opts && opts.jobCall) };
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
  // 第7次監査で発見した欠陥の修正:
  //   ?leagues= は件数の上限も数値かどうかの検査も無く、そのまま
  //   Promise.all で1つずつAPIを呼んでいた。`?leagues=1,2,...,500` という
  //   認証不要のGET1本で、500件のAPIリクエストを一度に発生させられた
  //   (無料プランの1日分の5倍)。件数を絞り、数値のみを受け付ける。
  const MAX_LEAGUES_PARAM = 12;
  const leaguesParam = String(query.get("leagues") || "")
    .split(",").map((v) => v.trim())
    .filter((v) => /^\d{1,6}$/.test(v))
    .slice(0, MAX_LEAGUES_PARAM);
  // 第7次監査で発見した時差の欠陥の修正:
  //   「📡 本日の実際の試合」がUTCの日付を使っていたため、日本時間の
  //   0時〜9時のあいだは**前日の試合**が「本日の試合」として表示されていた。
  const today = appDateKey();

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
          const data = await callApiFootball("/fixtures", { date: today, league: leagueId, season, timezone: "Asia/Tokyo" }, fxCallOpts);
          return data.response || [];
        } catch (e) {
          return [];
        }
      }));
      all = results.flat();
    } else {
      // Default: no league restriction at all — get everything scheduled today.
      const data = await callApiFootball("/fixtures", { date: today, timezone: "Asia/Tokyo" }, fxCallOpts);
      all = data.response || [];
    }

    const mapped = all
      .filter((f) => !FIXTURE_NAME_DENYLIST.test((f.league && f.league.name) || ""))
      // リザーブ(2軍)チーム同士の試合はチーム名で除外する。
      // リーグ名の `ii` 除外を外した代わりの、より正確な判定。
      .filter((f) => !(f.teams && f.teams.home && f.teams.away
        && FIXTURE_TEAM_RESERVE_RE.test(String(f.teams.home.name || ""))
        && FIXTURE_TEAM_RESERVE_RE.test(String(f.teams.away.name || ""))))
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
      }));
    // 利用者目線ラウンドで発見した欠陥の修正:
    //   従来は「キックオフの早い順に80件」で切っていたため、世界で80試合を超える
    //   忙しい日は、日本時間の夕方〜夜の**まだ始まっていない試合が黙って消え**、
    //   「本日は終了した試合しかない」ように見えていた(表示の嘘に相当)。
    //   ライブ・これから、を必ず優先して残し、枠の残りに終了済み(新しい順)を
    //   入れる。省略した件数は正直に返す(prioritizeFixturesForDisplay参照)。
    const prioritized = prioritizeFixturesForDisplay(mapped, 80);
    const fixtures = prioritized.fixtures;

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

    const payload = {
      found: true, source: "API-Football", date: today, fetchedAt: new Date().toISOString(), fixtures,
      // 正直な開示: この日に実際に存在した試合数と、表示枠(80)の都合で省略した件数
      totalToday: prioritized.totalToday,
      omittedCount: prioritized.omittedCount,
      // 未終了(ライブ中・これから)の試合を切り捨てた件数。通常は0だが、
      // 大会が重なる日は0にならない。画面はこの値を見て文言を変える。
      omittedUnfinishedCount: prioritized.omittedUnfinishedCount || 0,
    };
    cacheSet(cacheKey, payload, 15 * 60 * 1000);
    return { status: 200, body: payload };
  } catch (e) {
    const payload = { found: false, reason: e.code || "error", error: e.message };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    return { status: 200, body: payload };
  }
}

/**
 * 「本日の試合」の表示上限(cap)適用を、状態の優先順位つきで行う純関数。
 *   優先1: ライブ中 / 優先2: これから(未開始・延期等) / 残り枠: 終了済み(新しい順に残す)
 * これにより「まだ始まっていない試合が表示枠の都合で消える」ことは起こらない
 * (ライブ+これからだけで枠を超える日は理論上あり得るが、その場合も
 *  omittedCountで正直に開示される)。
 */
function prioritizeFixturesForDisplay(fixtures, cap) {
  const live = [], upcoming = [], finished = [];
  for (const f of fixtures || []) {
    if (LIVE_STATUSES.has(f.status)) live.push(f);
    else if (FINISHED_STATUSES.has(f.status)) finished.push(f);
    else upcoming.push(f);
  }
  const byDate = (a, b) => new Date(a.date) - new Date(b.date);
  live.sort(byDate); upcoming.sort(byDate); finished.sort(byDate);
  let kept = [...live, ...upcoming].slice(0, cap);
  // 2026年8月の調査で発見: 画面には「ライブ中・これからの試合は省略されません」と
  // 断言していたが、未終了の試合が上限(80)を超える日はここで実際に切り捨てていた。
  // 何件切ったかを数えて返し、画面が嘘をつかないようにする。
  const omittedUnfinishedCount = Math.max(0, live.length + upcoming.length - kept.length);
  const room = cap - kept.length;
  if (room > 0 && finished.length) kept = kept.concat(finished.slice(-room)); // 終了済みは新しい(遅い)ものを優先して残す
  kept.sort(byDate); // 表示は従来どおり時系列
  const total = (fixtures || []).length;
  return { fixtures: kept, totalToday: total, omittedCount: Math.max(0, total - kept.length), omittedUnfinishedCount };
}

// ---- 2026年8月・利用者目線ラウンド: 「今日のAI予想」を開いた瞬間に見せる ----
// 「このサイトの一番の価値はAIによる試合予想」というご指摘への対応。
// 予想は毎朝の日次学習でAI自身のモデル(学習済みの重み)が生成・保存した
// learn:ownpred レコードをそのまま読むだけで、このエンドポイントが新しい
// 予測計算やAPI-Football呼び出しを発生させることはない(最終方針⑥:
// 「利用者が質問した瞬間に重い処理を行う設計は禁止」)。
// 試合一覧は handleFixturesToday の既存キャッシュを共有する。

/** 今日の試合1件 + 保存済みのAI予測レコード → 画面表示用の1行(純関数・テスト対象) */
function buildTodayPredictionEntry(fixture, record, calibrationMap) {
  if (!fixture || !record) return null;
  const probs = (Number.isFinite(record.homeLambda) && Number.isFinite(record.awayLambda))
    ? computeMarketProbs(record.homeLambda, record.awayLambda) : null;
  const pct = (v) => Math.round(v * 100);
  const topFactor = Array.isArray(record.factorImportance) && record.factorImportance.length
    ? (record.factorImportance.find((f) => f && f.stars > 0) || record.factorImportance[0]) : null;
  // 精度証明ラウンド②: 実測のズレ(較正マップ)による表示勝率の補正。
  // 補正できる実測が無ければnull(生の値だけを表示。数字をでっち上げない)。
  const rawWinnerPct = probs
    ? (record.predictedWinner === "home" ? probs.homeWin * 100 : record.predictedWinner === "away" ? probs.awayWin * 100 : probs.draw * 100)
    : null;
  const calibrated = (rawWinnerPct !== null) ? applyCalibration(rawWinnerPct, calibrationMap) : null;
  return {
    // 精度証明ラウンド: 較正補正・市場比較(オッズ)・似た試合(RAG強化)
    calibrated,
    market: record.odds ? {
      odds: record.odds,
      impliedPct: record.marketImplied || null,
      edgePt: Number.isFinite(record.marketEdgePt) ? record.marketEdgePt : null,
    } : null,
    similarPastJa: record.similarPastJa || null,
    fixtureId: fixture.id,
    league: fixture.league || record.league || null,
    country: fixture.country || null,
    kickoff: fixture.date || record.kickoff || null,
    status: fixture.status || null,
    home: fixture.home || null,
    away: fixture.away || null,
    score: fixture.score || null,
    predictedWinner: record.predictedWinner || null,
    probs: probs ? { homeWinPct: pct(probs.homeWin), drawPct: pct(probs.draw), awayWinPct: pct(probs.awayWin) } : null,
    predictedScoreline: record.predictedScoreline || null,
    topFactorJa: topFactor ? topFactor.labelJa : null,
    // 成長可視化ラウンド⑤: 判断根拠のスコア(この予測に実際に影響した要素と影響度)。
    // 予測記録のfactorImportance(モデルの重み×特徴量の実計算)から機械的に出す。
    // 注: 市場オッズは予測の入力には使っていない(市場比較専用)ため、ここには出ない。
    factors: Array.isArray(record.factorImportance)
      ? record.factorImportance.filter((f) => f && f.stars > 0).slice(0, 5).map((f) => ({ labelJa: f.labelJa, stars: f.stars }))
      : [],
    // 「学習v◯の重みで予測」— 重みが更新されるたびにこの数字が上がる=
    // AIが学習しながら予想していることが利用者にも見える
    weightsVersion: Number.isFinite(record.weightsVersion) ? record.weightsVersion : null,
    loggedAt: record.loggedAt || null,
    resolved: !!record.resolved,
    correct: record.resolved ? record.correct : null,
    actualWinner: record.resolved ? (record.actualWinner || null) : null,
  };
}

/**
 * 保留中の予測記録から「次の試合」として表示できるものを選ぶ(純関数・テスト対象)。
 * 監査での指摘への対応:
 *   ・中止された試合の保留分が残り続けるため、直近14日以内に限定する
 *   ・日付が壊れている記録(パースできない)は除外する
 *   ・答え合わせ済みは対象外。キックオフの近い順・最大5件。
 */
const UPCOMING_WINDOW_DAYS = 14;
const UPCOMING_MAX = 5;
function selectUpcomingPredictionRecords(records, nowMs) {
  return (records || [])
    .filter((r) => {
      if (!r || r.resolved || !r.kickoff) return false;
      const t = new Date(r.kickoff).getTime();
      return Number.isFinite(t) && t > nowMs && t < nowMs + UPCOMING_WINDOW_DAYS * 86400000;
    })
    .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
    .slice(0, UPCOMING_MAX);
}

async function handlePredictionsToday() {
  const cacheKey = `predictions-today:${appDateKey()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached };

  const { body: fx } = await handleFixturesToday(new URLSearchParams(), {});
  if (!fx || !fx.found) {
    const payload = {
      found: false, reason: (fx && fx.reason) || "fixtures_unavailable",
      noteJa: "本日の試合一覧を取得できなかったため、AI予想を表示できません(サーバー起動直後やAPI利用上限時に起こります。しばらくして再読み込みしてください)。",
    };
    cacheSet(cacheKey, payload, 2 * 60 * 1000);
    return { status: 200, body: payload };
  }
  const fixtures = fx.fixtures || [];
  let predictions = [];
  let calibrationMap = null;
  if (UPSTASH_ENABLED && fixtures.length) {
    // Redisの読み取りのみ(1試合1コマンド+較正マップ1コマンド・上限60・結果は5分キャッシュ)
    calibrationMap = await upstashGetJSON("learn:calibration:map").catch(() => null);
    // 監査での指摘: 一覧は最大80件返るのに予想の照合は先頭60件だけだったため、
    // 夜の試合が61番目以降に来た日は「本日は対象試合がない」と誤って断定していた。
    // 表示上限と揃える(読み取りは5分キャッシュの内側なので実害のあるコスト増は無い)。
    const target = fixtures.slice(0, 80);
    const records = await Promise.all(target.map((f) => upstashGetJSON(`learn:ownpred:${f.id}`).catch(() => null)));
    predictions = target.map((f, i) => buildTodayPredictionEntry(f, records[i], calibrationMap)).filter(Boolean);
    predictions.sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
  }
  // ---- 2026年8月・利用者からの指摘への対応: 「今日のAI予想が空」問題 ----
  //   予想はAIが追跡しているクラブの「次の試合」に対して作られるため、その試合が
  //   今日でない日(オフシーズンは特に多い)はカードが空になっていた。
  //   本来AIは予想を持っているのに何も見えないのは、利用者にとって
  //   「AIが何もしていない」ように見える。今日の対象試合が無い日は、
  //   AIが予想している「次の試合」を代わりに表示する(でっち上げではなく、
  //   すでに保存済みの予想をそのまま出すだけ)。
  //   コスト: 今日ぶんが空のときだけ、保留リストの読み出し+最大40件のGET。
  let upcomingPredictions = [];
  if (!predictions.length && UPSTASH_ENABLED) {
    try {
      // calibrationMapは上で取得済みの場合がある(未取得のときだけ読む)
      if (!fixtures.length) calibrationMap = await upstashGetJSON("learn:calibration:map").catch(() => null);
      const pendingIds = (await upstashCmd(["LRANGE", "learn:ownpred:pending", "-40", "-1"]).catch(() => [])) || [];
      const recs = await Promise.all(pendingIds.map((id) => upstashGetJSON(`learn:ownpred:${id}`).catch(() => null)));
      upcomingPredictions = selectUpcomingPredictionRecords(recs, Date.now())
        .map((r) => buildTodayPredictionEntry({
          id: r.fixtureId, date: r.kickoff, status: "NS", league: r.league || null,
          home: { name: r.homeTeamEn }, away: { name: r.awayTeamEn }, score: null,
        }, r, calibrationMap))
        .filter(Boolean);
    } catch (e) { /* 付加情報。失敗しても本日ぶんの表示は返す */ }
  }

  // ---- 精度証明ラウンド③: 今日のベスト予想 ----
  // まだ始まっていない試合のうち、(補正後があれば補正後の)勝率が最も高い1試合。
  // 機械的な選定であり、選定基準もそのまま開示する。該当が無ければ出さない。
  let bestPick = null;
  for (const p of predictions) {
    if (p.resolved || FINISHED_STATUSES.has(p.status) || LIVE_STATUSES.has(p.status)) continue;
    const conf = p.calibrated ? p.calibrated.calibratedPct
      : (p.probs ? (p.predictedWinner === "home" ? p.probs.homeWinPct : p.predictedWinner === "away" ? p.probs.awayWinPct : p.probs.drawPct) : null);
    if (conf === null) continue;
    if (!bestPick || conf > bestPick.confidencePct) {
      bestPick = {
        fixtureId: p.fixtureId,
        confidencePct: conf,
        calibrated: !!p.calibrated,
        reasonJa: `本日のAI予想の中で${p.calibrated ? "補正後の" : ""}勝率が最も高い試合です(${conf}%${p.topFactorJa ? `・最重要要素: ${p.topFactorJa}` : ""})。`,
      };
    }
  }
  const payload = {
    found: true,
    date: fx.date,
    generatedAt: new Date().toISOString(),
    totalFixturesToday: fixtures.length,
    predictions,
    // 今日の対象試合が無い日に表示する「AIが予想している次の試合」
    upcomingPredictions,
    bestPick,
    calibrationAvailable: !!(calibrationMap && calibrationMap.available),
    // 予想が無い日も、その理由を正直に表示する(推測で予想をでっち上げない)
    noteJa: predictions.length
      ? "AI自身の予測モデル(実データで毎日学習した重み)による予想です。予想は毎朝の学習時に生成・保存され、試合終了後に必ず答え合わせされて学習に使われます。"
      : (upcomingPredictions.length
        ? `本日はAIが追跡しているクラブの試合がないため、AIがすでに予想している「次の試合」を表示しています(${upcomingPredictions.length}件)。予想は毎朝の学習で生成・保存され、試合終了後に必ず答え合わせされます。`
        : (fixtures.length
          // 2026年8月の調査で修正: 旧文言は「AIが毎日追跡しているクラブ」とだけ書いており、
          // 知識収集の対象(UEFA上位100クラブ)全部で予想が出ると読めた。
          // 実際には1回の学習で新規記録するのは上限件数までなので、
          // 「今日は順番が回ってこなかった」場合があることを正直に書く。
          ? `本日の試合${fixtures.length}件の中に、AIが予想を保存している試合はまだありません。AIはUEFA上位100クラブ+登録クラブを日替わりの順番で回り、毎朝の学習で1回あたり最大${OWN_PREDICT_LOG_CAP_DISPLAY}件の予想を新しく作ります。そのため「今日はまだ順番が回っていない」ことがあります。オフシーズン中は対象試合そのものが少ないのも正常です。`
          : "本日は対象となる試合がありません。シーズン中は毎朝の学習で、ここにAI予想が並びます。")),
  };
  cacheSet(cacheKey, payload, 5 * 60 * 1000);
  return { status: 200, body: payload };
}

// ---- 2026年8月・精度証明ラウンド④: 学習状態の週次バックアップ出力 ----
// AIの「脳」= 作り直せない学習状態(重み・精度履歴・較正・使用実績・知能レポート)
// をJSONで出力する。GitHub Actions(weekly-backup.yml)が週1回これを取得して
// リポジトリへ保存する。知識アイテム本体は含めない(APIから数日で再収集できる
// 派生データであり、容量が大きいため。この選択も応答に明記して開示する)。
async function handleBackupExport() {
  if (!UPSTASH_ENABLED) return { status: 200, body: { ok: false, reasonJa: "Upstash未設定のためバックアップ対象がありません。" } };
  const todayKey = appDateKey();
  const getJ = (k) => upstashGetJSON(k).catch(() => null);
  const base = new Date(`${todayKey}T00:00:00Z`).getTime();
  const days = [];
  for (let i = 0; i < 30; i++) days.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  const [weights, weightsHistoryRaw, apiplan, calibration, similarClubs, knowledgeUsage, growthLatest, intelLatest, agendaLatest] = await Promise.all([
    getJ("learn:weights"),
    upstashCmd(["LRANGE", "learn:weights:history", "-50", "-1"]).catch(() => []),
    getJ("learn:apiplan"),
    getJ("learn:calibration:map"),
    getJ("kb:similar:clubs"),
    getJ("knowledge:usage"),
    getJ("learn:growthlog:latest"),
    getJ("learn:intel:report:latest"),
    getJ("learn:agenda:latest"),
  ]);
  const perDay = async (prefix) => {
    const rows = await Promise.all(days.map((d) => getJ(`${prefix}${d}`)));
    const out = {};
    days.forEach((d, i) => { if (rows[i]) out[d] = rows[i]; });
    return out;
  };
  const [accuracyByDay, metricsByDay, roiByDay, intelByDay] = await Promise.all([
    perDay("learn:accuracy:"), perDay("learn:metrics:"), perDay("learn:roi:"), perDay("learn:intel:"),
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      exportedAt: new Date().toISOString(),
      version: 1,
      noteJa: "AIの学習状態(重み・精度/ROI/知能の履歴30日・較正・似たクラブ索引・知識使用実績)のバックアップです。知識アイテム本体は含みません(APIから再収集できる派生データのため。消失時は数日で自動再収集されます)。",
      data: {
        weights, weightsHistory: (weightsHistoryRaw || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean),
        apiplan, calibration, similarClubs, knowledgeUsage,
        growthLogLatest: growthLatest, intelReportLatest: intelLatest, agendaLatest,
        accuracyByDay, metricsByDay, roiByDay, intelByDay,
      },
    },
  };
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
// 結果(スコア)が永久に確定しない状態。保留キューに残すと先頭詰まりの原因になる。
// 延期・中止・放棄・裁定勝ち・不戦勝。dailyJob.js の UNRESOLVABLE_STATUSES と同じ基準。
const UNRESOLVABLE_STATUSES = new Set(["PST", "CANC", "ABD", "AWD", "WO"]);
// 画面に「なぜ答え合わせできないのか」を日本語で出すための対応表
const STATUS_LABELS_JA = {
  NS: "未開始", TBD: "日時未定", "1H": "前半", HT: "ハーフタイム", "2H": "後半",
  ET: "延長", BT: "延長前の休憩", P: "PK戦", SUSP: "一時中断", INT: "中断",
  LIVE: "進行中", FT: "終了", AET: "延長終了", PEN: "PK戦終了",
  PST: "延期", CANC: "中止", ABD: "放棄", AWD: "裁定勝ち", WO: "不戦勝",
  unknown: "状態不明",
};
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
    // 第6次監査で発見した欠陥への対応:
    //   この .catch はタイムアウトも予算切れも「空の応答」に化けさせていた。
    //   その結果、**選手評価もイベントも空っぽの「試合後の振り返り」カード**が
    //   完成品として1週間キャッシュされ、その間ずっと再取得できなかった。
    //   取得できたかどうかを覚えておき、キャッシュの寿命と表示に反映する。
    let subFetchFailed = false;
    const [playersData, eventsData] = await Promise.all([
      callApiFootball("/fixtures/players", { fixture: id }).catch(() => { subFetchFailed = true; return { response: [] }; }),
      callApiFootball("/fixtures/events", { fixture: id }).catch(() => { subFetchFailed = true; return { response: [] }; }),
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

    // 利用者目線ラウンド: 「選手評価データがありません」だけでは、待てば出るのか
    // 永遠に出ないのか利用者に分からない。空である理由を機械的に区別して添える。
    //   ・取得失敗(予算切れ・通信) → 開き直せば再取得される(dataIncompleteNoteJaも参照)
    //   ・取得成功なのに空 → API-Football側がこの試合の選手統計を提供していない
    //     (親善試合・一部の大会では提供されない。提供され次第自動で表示される)
    const playersUnavailableReasonJa = (!homePlayers.length && !awayPlayers.length)
      ? (subFetchFailed
        ? "選手評価の取得に失敗しました(APIの利用上限・通信の問題)。時間をおいてこの画面を開き直すと自動で再取得します。"
        : "データ提供元(API-Football)がこの試合の選手評価を提供していません。親善試合や一部の大会では選手のレーティングが提供されないことがあり、これは蓄積不足ではなくデータ提供元側の範囲の問題です。主要リーグの公式戦では提供されます。")
      : null;

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
        playersUnavailableReasonJa,
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
      playersUnavailableReasonJa,
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
    // 第6次監査での修正:
    //   「終了した試合のデータは変わらないので長期キャッシュしてよい」は、
    //   **データが完全に取れている場合にだけ**成り立つ。選手評価やイベントの
    //   取得に失敗したまま1週間キャッシュすると、その間ずっと中身が空の
    //   振り返りカードが出続け、再取得の機会が無い。
    //   取得に失敗していたら短いキャッシュにして、次のアクセスでやり直す。
    if (subFetchFailed) {
      payload.dataIncomplete = true;
      payload.dataIncompleteNoteJa = "選手評価・試合イベントの取得に失敗したため、この振り返りは一部が欠けています(時間をおいて開き直すと再取得します)。";
      cacheSet(cacheKey, payload, 5 * 60 * 1000);
    } else {
      cacheSet(cacheKey, payload, 7 * 24 * 60 * 60 * 1000);
    }
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
// ---- 2026年8月7日・本番実測で判明した「答え合わせが追いつかない」の修正 ----
//   実測: pending 18件 → 22件、resolved 0、45時間ぶん1件も答え合わせされていない。
//   照合枠8件をすべて「日程変更でNSに戻った試合」に食われ、その後ろに並ぶ
//   終了済みの試合に一度も到達していなかった。しかも1回の実行で3件を新規記録
//   するため、**列は縮むどころか毎回伸びていた**。
//
//   API-Football の /fixtures は ids=1-2-3... で **1リクエストに20件** まとめて
//   問い合わせできる。1件1リクエストをやめれば、同じAPI消費のまま照合できる
//   件数を8件→60件に増やせる(最終方針③「精度>コスト・取得量は減らさない」に適合)。
const AUTO_COLLECT_RESOLVE_CAP = Number(process.env.AUTO_COLLECT_RESOLVE_CAP) || 60; // 1回の実行で照合を試みる件数
const AUTO_COLLECT_IDS_PER_CALL = 20; // /fixtures?ids= に一度に渡せる試合ID数(APIの仕様上限)
const AUTO_COLLECT_RESOLVE_MIN_AGE_MS = 2 * 60 * 60 * 1000; // キックオフから2時間経っていない試合は「まだ終わっていない可能性が高い」としてスキップ
// 記録上のキックオフからこれだけ経っても結果が確定しない試合は諦める
// (延期の繰り返し・データ提供元での取り消しなど。列に永久に居座らせない)
const PENDING_MAX_AGE_MS = Number(process.env.PENDING_MAX_AGE_MS) || 14 * 24 * 60 * 60 * 1000;

async function handleAutoCollectPredictions(opts) {
  if (!UPSTASH_ENABLED) {
    return { status: 200, body: { ok: true, upstashConfigured: false, logged: 0, resolved: 0, note: "Upstash未設定のため何もしていません" } };
  }

  let logged = 0;
  let resolved = 0;
  let evicted = 0;
  let skippedNoData = 0;
  let pendingLenBefore = null;
  let pendingLenAfter = null;
  let rotated = 0;
  const statusTally = {};   // どの状態の試合が何件あったか(なぜ解決しないのかの証拠)
  const notes = [];
  const startedAt = new Date().toISOString();

  // フェーズ1: 保留中(まだ結果が確定していない)の予測を、実際の試合結果と突き合わせる。
  // 「今日の試合」一覧のスイープでは対応できない“前日以前にキックオフした試合”もここで拾える。
  //
  // ---- 2026年8月7日・本番実測で判明した構造的な詰まりの修正 ----
  //   旧実装は「列の先頭から1件ずつ、1件1リクエスト、最大8件」だった。
  //   実測ではその8件がすべて「日程変更でNSに戻った試合」で埋まり、
  //   後ろに並ぶ **終了済みの試合に一度も到達していなかった**(45時間0件)。
  //   さらに1回の実行で3件を新規記録するため、列は毎回伸びていた。
  //
  //   直し方(推測ではなく、実測した詰まり方に対する構造的な対処):
  //     ① 先頭から順ではなく、**キックオフが古い順**に見る
  //        (=終わっている可能性が最も高いものから照合する)
  //     ② キックオフがまだ先の試合は、APIを呼ばずに最初から除外する
  //        (日程変更を反映済みなので、ここで枠を1つも使わない)
  //     ③ /fixtures?ids=a-b-c で **20件を1リクエスト** にまとめる
  //        (同じAPI消費で照合できる件数が8件→60件になる)
  try {
    const pendingIds = (await upstashCmd(["LRANGE", "pred:pending", "0", "-1"])) || [];
    pendingLenBefore = pendingIds.length;

    // ---- ①②: 記録を読み、照合すべきものだけを「古い順」に並べる ----
    const candidates = [];
    let awaitingKickoff = 0;
    for (const idStr of pendingIds) {
      const record = await upstashGetJSON(`pred:${idStr}`);
      if (record && record.resolved) {
        // 解決済みなのに残っている=LREMの取りこぼし。ここで確実に外す(APIは使わない)
        await upstashCmd(["LREM", "pred:pending", "0", String(idStr)]).catch(() => {});
        evicted++;
        notes.push(`pending evicted (fixture ${idStr} already resolved)`);
        continue;
      }
      if (!record) {
        // 本体が読めない。Upstashの一時的な失敗でも null が返るため、
        // 即座には消さず「連続で読めなかった回数」を数え、3回でようやく諦める。
        const missKey = `pred:pendingmiss:${idStr}`;
        let miss = 0;
        try {
          miss = Number(await upstashCmd(["INCR", missKey])) || 0;
          await upstashCmd(["EXPIRE", missKey, "604800"]).catch(() => {});
        } catch (e) { miss = 0; }
        if (miss >= 3) {
          await upstashCmd(["LREM", "pred:pending", "0", String(idStr)]).catch(() => {});
          await upstashCmd(["DEL", missKey]).catch(() => {});
          evicted++;
          notes.push(`pending evicted (fixture ${idStr} record missing ${miss}x)`);
        }
        continue;
      }
      // 検証での指摘: 「連続で読めなかった回数」と書きながら、成功しても
      //   カウンターを消していなかった。数週間おきの一時的な失敗が3回積もるだけで、
      //   健全な予測が保留リストから外され、二度と答え合わせされなくなる。
      //   読めた時点で必ず消す(=本当に「連続」でのみ諦める)。
      await upstashCmd(["DEL", `pred:pendingmiss:${idStr}`]).catch(() => {});
      const kickMs = record.kickoff ? Date.parse(record.kickoff) : NaN;
      if (Number.isFinite(kickMs) && (Date.now() - kickMs) < AUTO_COLLECT_RESOLVE_MIN_AGE_MS) {
        awaitingKickoff++;   // まだ試合中/開始前。APIを1回も使わずに見送る
        continue;
      }
      candidates.push({ idStr: String(idStr), record, kickMs: Number.isFinite(kickMs) ? kickMs : 0 });
    }
    // 古い試合ほど「もう終わっている」ので、そこから照合する
    candidates.sort((a, b) => a.kickMs - b.kickMs);
    if (candidates.length > AUTO_COLLECT_RESOLVE_CAP) {
      notes.push(`resolve cap reached (${AUTO_COLLECT_RESOLVE_CAP} / due ${candidates.length})`);
    }
    const targets = candidates.slice(0, AUTO_COLLECT_RESOLVE_CAP);
    notes.push(`due for check ${candidates.length} / awaiting kickoff ${awaitingKickoff}`);

    // ---- ③: 20件ずつまとめて問い合わせる ----
    for (let i = 0; i < targets.length; i += AUTO_COLLECT_IDS_PER_CALL) {
      const chunk = targets.slice(i, i + AUTO_COLLECT_IDS_PER_CALL);
      let entries = null;
      try {
        const data = chunk.length === 1
          ? await callApiFootball("/fixtures", { id: chunk[0].idStr }, { jobCall: true })
          : await callApiFootball("/fixtures", { ids: chunk.map((c) => c.idStr).join("-") }, { jobCall: true });
        entries = data.response || [];
      } catch (e) {
        notes.push(`resolve batch failed (${chunk.length} fixtures): ${e.message}`);
        if (e && e.code === "BUDGET_EXHAUSTED") { notes.push("API budget exhausted; stopping resolve phase"); break; }
        continue;   // このかたまりは次回に回す(列の順番は変えない)
      }
      const byId = new Map();
      for (const en of entries) {
        if (en && en.fixture && en.fixture.id !== undefined) byId.set(String(en.fixture.id), en);
      }
      for (const c of chunk) {
        const idStr = c.idStr;
        const record = c.record;
        const entry = byId.get(idStr);
        try {
          // ---- 先頭詰まりの修正(2/3): APIから消えた試合ID ----
          //   シーズン移行やID振り直しで /fixtures?id=… が空になる試合がある。
          //   従来はここで continue するだけで、そのIDは永久に先頭に居座っていた。
          if (!entry || !entry.fixture) {
            const attempts = (Number(record.resolveAttempts) || 0) + 1;
            record.resolveAttempts = attempts;
            await upstashSetJSON(`pred:${idStr}`, record).catch(() => {});
            if (attempts >= 3) {
              await upstashCmd(["LREM", "pred:pending", "0", String(idStr)]).catch(() => {});
              evicted++;
              notes.push(`pending evicted (fixture ${idStr} not found ${attempts}x)`);
            } else {
              notes.push(`fixture ${idStr} not found (${attempts}/3)`);
            }
            continue;
          }
          const statusShort = entry.fixture.status ? entry.fixture.status.short : null;
          // ---- 先頭詰まりの修正(3/3): 結果が永久に出ない試合 ----
          //   延期(PST)・中止(CANC)・放棄(ABD)・裁定勝ち(AWD)・不戦勝(WO)は
          //   スコアが出ないため FINISHED_STATUSES に入らず、永久に残っていた。
          if (UNRESOLVABLE_STATUSES.has(statusShort)) {
            await upstashCmd(["LREM", "pred:pending", "0", String(idStr)]).catch(() => {});
            evicted++;
            notes.push(`pending evicted (fixture ${idStr} ${statusShort})`);
            continue;
          }
          statusTally[statusShort || "unknown"] = (statusTally[statusShort || "unknown"] || 0) + 1;
          if (FINISHED_STATUSES.has(statusShort) && entry.goals) {
            const r = await resolvePrediction(idStr, entry.goals.home, entry.goals.away);
            if (r) resolved++;
            continue;
          }
          // まだ終わっていない試合。日程変更を記録に反映しておけば、
          // 次回はキックオフ前として **APIを1回も使わずに** 見送れる。
          const apiDate = entry.fixture.date ? Date.parse(entry.fixture.date) : NaN;
          const recordedKick = record.kickoff ? Date.parse(record.kickoff) : NaN;
          if (Number.isFinite(apiDate) && Number.isFinite(recordedKick) && apiDate > recordedKick + 60 * 1000) {
            record.kickoff = entry.fixture.date;
            await upstashSetJSON(`pred:${idStr}`, record).catch(() => {});
            notes.push(`fixture ${idStr} rescheduled to ${entry.fixture.date} (${statusShort})`);
          }
          const ageMs = Number.isFinite(recordedKick) ? Date.now() - recordedKick : 0;
          if (ageMs > PENDING_MAX_AGE_MS) {
            await upstashCmd(["LREM", "pred:pending", "0", String(idStr)]).catch(() => {});
            evicted++;
            notes.push(`pending evicted (fixture ${idStr} still ${statusShort} after ${Math.round(ageMs / 86400000)} days)`);
            continue;
          }
          // 最後尾へ回す。古い順に見る方式でも、同じ試合ばかり先に来ないようにする。
          await upstashCmd(["LREM", "pred:pending", "0", String(idStr)]).catch(() => {});
          await upstashCmd(["RPUSH", "pred:pending", String(idStr)]).catch(() => {});
          rotated++;
        } catch (e) {
          notes.push(`resolve check failed for fixture ${idStr}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    notes.push("resolve phase error: " + e.message);
  }

  // フェーズ2: 今日の試合一覧から、まだ記録していない今後の試合を少数だけ新規に記録する。
  // handleFixturesToday()を再利用することで、キャッシュ・除外リーグ(ユース/女子など)の
  // ロジックを重複させない。
  try {
    const todayResult = await handleFixturesToday(new URLSearchParams(), { jobCall: true });
    // 2026年8月の調査で発見: found:false(APIキー未設定・取得失敗)でも
    // fixtures が空配列として扱われ、「何も記録できなかった」ことが
    // 成功と区別できないまま ok:true で返っていた。理由を残す。
    if (todayResult.body && todayResult.body.found === false) {
      notes.push("log phase skipped: 今日の試合一覧を取得できませんでした" + (todayResult.body.noteJa ? ` (${todayResult.body.noteJa})` : ""));
    }
    const fixtures = (todayResult.body && todayResult.body.fixtures) || [];
    const upcoming = fixtures.filter((f) => f.status === "NS");
    let attempted = 0;
    for (const f of upcoming) {
      if (attempted >= AUTO_COLLECT_LOG_CAP) { notes.push(`log cap reached (${AUTO_COLLECT_LOG_CAP})`); break; }
      const existing = await upstashGetJSON(`pred:${f.id}`);
      if (existing) continue; // 既に記録済み
      // 2026年8月の調査で発見した「毎回同じ3試合で枠を使い切る」問題の修正:
      //   親善試合など API-Football が /predictions を持たない試合は
      //   getOrLogPrediction が null を返し、**何も保存されない**。
      //   そのため次回の実行でも同じ試合が先頭に来て再び枠(1日最大12件)を
      //   使い切り、後ろの試合は永久に記録されなかった。
      //   「データが無かった」ことを短期の目印として残し、当日は再挑戦しない。
      const noData = await upstashCmd(["GET", `pred:nodata:${f.id}`]).catch(() => null);
      if (noData) { skippedNoData++; continue; }
      attempted++;
      const rec = await getOrLogPrediction(f.id, {
        league: f.league || null,
        homeName: f.home ? f.home.name : null,
        awayName: f.away ? f.away.name : null,
        kickoff: f.date,
      }, { jobCall: true });
      if (rec) logged++;
      else {
        await upstashCmd(["SET", `pred:nodata:${f.id}`, new Date().toISOString(), "EX", "72000"]).catch(() => {});
        notes.push(`no prediction data from API for fixture ${f.id}`);
      }
    }
  } catch (e) {
    notes.push("log phase error: " + e.message);
  }

  try {
    pendingLenAfter = Number(await upstashCmd(["LLEN", "pred:pending"]));
    if (!Number.isFinite(pendingLenAfter)) pendingLenAfter = null;
  } catch (e) { pendingLenAfter = null; }

  // 第6次監査で発見した誤りの修正:
  //   両方のフェーズが例外で落ちても ok:true を返していたため、
  //   これを叩くcronの監視から見ると「毎回成功している」ようにしか見えず、
  //   障害が何日でも見過ごされる状態だった。エラーが起きたかどうかを
  //   ok に反映し、監視が気づけるようにする。
  // 第7次監査で発見した、第6次の修正そのものの行き過ぎを是正:
  //   `/error/i` は個々の試合の注記(「resolve check failed for fixture …」)にも
  //   一致するため、8件中1件だけAPIが失敗して残り7件は正常に処理できた日でも
  //   ok:false になっていた。呼び出し元のGitHub Actionsはこれを致命的失敗として
  //   **エンドポイントをもう一度叩き**(さらにAPIを消費し)、最後は失敗通知を出す。
  //   ここで報告すべきは「処理そのものが立ち上がらなかった」ことだけにする。
  //   個々の試合の失敗は notes に残るので、情報が消えるわけではない。
  const hadFatalError = notes.some((n) => /^(resolve|log) phase error:/.test(n));
  // ---- 2026年8月・「正答率が何日も動かない」への回答責任 ----
  //   これまで、この処理が実際に走ったかどうかを外から確かめる方法が
  //   まったく無かった(GitHub Actionsのログを見るしかない)。
  //   実行のたびに記録を残し、/api/accuracy-stats から見えるようにする。
  //   これで「cronが止まっている」のか「試合がまだ終わっていない」のかを
  //   推測ではなく実測で区別できる。
  const runRecord = {
    at: new Date().toISOString(), startedAt,
    trigger: opts && opts.trigger ? opts.trigger : "request",
    ok: !hadFatalError, logged, resolved, evicted, skippedNoData, rotated,
    // どの状態の試合を何件見たか。これが無かったせいで
    //「8件見て0件解決」の理由を突き止めるのに丸1往復かかった。
    statusTally,
    pendingLenBefore, pendingLenAfter,
    notes: notes.slice(0, 20),
  };
  await upstashSetJSON("pred:autocollect:lastrun", runRecord).catch(() => {});
  await upstashCmd(["LPUSH", "pred:autocollect:log", JSON.stringify(runRecord)]).catch(() => {});
  await upstashCmd(["LTRIM", "pred:autocollect:log", "0", "29"]).catch(() => {});
  return {
    status: 200,
    body: {
      ok: !hadFatalError, upstashConfigured: true, logged, resolved,
      // 2026年8月の調査で追加した可観測性。「正答率が動かない」ときに
      // 保留キューが詰まっているのかどうかを、外から数字で確認できるようにする。
      evicted, skippedNoData, rotated, statusTally, pendingLenBefore, pendingLenAfter,
      ranAt: runRecord.at,
      notes,
    },
  };
}

// ============================================================================
// 2026年8月7日・予測の答え合わせを GitHub Actions に依存させないための自己修復
// ----------------------------------------------------------------------------
// 実際に起きたこと:
//   手動実行した Predictions Auto-Collect が
//     「The job was not acquired by Runner of type hosted even after
//       multiple attempts」
//     「Internal server error. Correlation ID: ...」
//   で15分待たされた末に失敗した。**GitHub側で実行機が確保できなかった**ため、
//   ワークフローの中身(curl)は一行も動いていない。
//   設定ミスでもコードのバグでもなく、こちらから直せない外部要因である。
//
// つまり「毎日必ず起きなければならない処理」を、こちらで制御できない
// 外部のスケジューラ1本に預けていたことが、そもそもの設計上の弱点だった。
// (これ以前にも、定時実行が3時間42分遅れた実測がある)
//
// 対処: サーバー自身が「最後に答え合わせをしてから何時間経ったか」を見て、
// 古すぎる場合だけ、利用者のリクエストのついでに **裏で** 実行する。
//   ・利用者を待たせない(応答を返してから走る)
//   ・1回あたりの処理量は従来と同じ上限(照合8件・記録3件)なのでAPI消費は増えない
//   ・複数インスタンスでも二重に走らないよう Redis の NX ロックで守る
//   ・GitHub Actions が動いている間は「まだ新しい」ので何もしない(二重実行しない)
// ============================================================================
let autoSweepInFlight = false;
let autoSweepLastCheckedAt = 0;
// 何分おきに「古くなっていないか」を確認するか(Redis読み出しを増やしすぎない)
const AUTO_SWEEP_CHECK_INTERVAL_MS = Number.isFinite(Number(process.env.AUTO_SWEEP_CHECK_INTERVAL_MS))
  ? Number(process.env.AUTO_SWEEP_CHECK_INTERVAL_MS) : 10 * 60 * 1000;
// ---- 2026年8月7日・本番実測を受けた見直し ----
//   実測: 直前の自動照合の trigger が "self-heal" だった=**GitHub Actions は
//   9時間以上まったく動いていなかった**。9時間に1回では、1回の実行で新規記録
//   3件・照合0件という日には列が伸びる一方になる。
//   自己修復の間隔を1時間に縮める(NXロックも1時間なので二重には走らない)。
//   1回の処理量は照合の問い合わせ数回・記録3件で、APIの1日予算(7,500)に対して
//   十分小さい。取得量を減らすのではなく、**動く回数を増やして追いつかせる**。
const AUTO_SWEEP_STALE_MS = Number(process.env.AUTO_SWEEP_STALE_MS) || 60 * 60 * 1000;

async function maybeSelfHealAutoCollect() {
  if (!UPSTASH_ENABLED) return;
  if (autoSweepInFlight) return;
  const now = Date.now();
  if (now - autoSweepLastCheckedAt < AUTO_SWEEP_CHECK_INTERVAL_MS) return;
  autoSweepLastCheckedAt = now;
  try {
    const last = await upstashGetJSON("pred:autocollect:lastrun").catch(() => null);
    const lastMs = last && last.at ? new Date(last.at).getTime() : null;
    const age = Number.isFinite(lastMs) ? now - lastMs : Infinity;
    if (age < AUTO_SWEEP_STALE_MS) return; // まだ新しい(cronが動いている)
    // 複数プロセス・複数インスタンスで同時に走らせない(NXロック・1時間)
    const gotLock = await upstashCmd([
      "SET", "pred:autocollect:selfheallock", new Date().toISOString(), "NX", "EX", "3600",
    ]).catch(() => null);
    if (!gotLock) return;
    autoSweepInFlight = true;
    // 応答は既に返しているので、ここから先は利用者を待たせない
    handleAutoCollectPredictions({ trigger: "self-heal" })
      .then((r) => {
        const b = (r && r.body) || {};
        console.log("[self-heal auto-collect]", JSON.stringify({
          logged: b.logged, resolved: b.resolved, evicted: b.evicted,
          pendingLenBefore: b.pendingLenBefore, pendingLenAfter: b.pendingLenAfter,
        }));
      })
      .catch((e) => console.error("[self-heal auto-collect failed]", e && e.message))
      .finally(() => { autoSweepInFlight = false; });
  } catch (e) {
    autoSweepInFlight = false;
  }
}

// ============================================================================
// 2026年8月7日・毎日の学習も GitHub Actions に依存させない
// ----------------------------------------------------------------------------
// 実際に起きたこと(本番の実測):
//   ・最後の学習記録は 2026-08-06T09:50Z(手動実行ぶん)。
//     定刻(日本時間4:17=前日19:17Z)の実行記録が **存在しない**。
//   ・同じ時間帯、自動照合の trigger も "self-heal" だった。
//     = 2本のワークフローがどちらも動いていない。
//
// 影響は正答率だけではない。**選手検索の索引は毎日の学習でしか作られない**ため、
// 学習が走らない限り「選手が1人も出てこない」状態が永久に続く。
// つまり、この1点が止まるとアプリの主要機能がまとめて止まる。
//
// 対処: 自動照合と同じ考え方で、最後の学習から26時間以上経っていたら、
// 利用者のリクエストのついでに **裏で** 学習を走らせる。
//   ・応答を返してから走るので、利用者は1ミリ秒も待たない(最終方針⑥)
//   ・Redis の NX ロック(既存の tryAcquireDailyRunLock)で二重起動を防ぐ
//   ・GitHub Actions が動いていれば「まだ新しい」ので何もしない
//   ・1日1回ぶんの処理量しか走らない(APIの取得量は増えも減りもしない)
// ============================================================================
let learnSweepLastCheckedAt = 0;
// 0 を指定できるようにする(`||` だと 0 が既定値に落ちて、設定が黙って無視される)
const LEARN_SWEEP_CHECK_INTERVAL_MS = Number.isFinite(Number(process.env.LEARN_SWEEP_CHECK_INTERVAL_MS))
  ? Number(process.env.LEARN_SWEEP_CHECK_INTERVAL_MS) : 15 * 60 * 1000;
// 1日1回の処理なので、24時間+余裕の26時間で「明らかに止まっている」と判断する
const LEARN_SWEEP_STALE_MS = Number(process.env.LEARN_SWEEP_STALE_MS) || 26 * 60 * 60 * 1000;

// 逃げ道: 自動起動を止めたい環境(テスト・検証用の複製など)では 0 を指定する
const SELF_HEAL_DAILY_LEARNING = process.env.SELF_HEAL_DAILY_LEARNING !== "0";

// 選手検索が使える状態かを確認し、足りない分だけを裏で埋める。
//   ・索引がまったく無い       → 保存済みデータから作り直す(外部API 0回)
//   ・索引はあるがクラブが不足 → 25クラブぶんずつ収集して追いつかせる
// どちらも応答を返したあとに走るので、利用者は待たされない。
async function maybeRepairPlayerIndex() {
  try {
    const idx = await loadPlayerIndex(false).catch(() => null);
    if (!idx) return;
    const rowCount = (idx.rows || []).length;
    const neverBuilt = idx.metaFound === false && rowCount === 0;
    if (neverBuilt) {
      // 索引づくりは外部APIを1回も使わないので、これだけを走らせる
      // (以前は「毎日の学習まるごと」を走らせようとして重すぎ、完走しなかった)
      const got = await upstashCmd([
        "SET", "kb:player:index:rebuildlock", new Date().toISOString(), "NX", "EX", "1800",
      ]).catch(() => null);
      if (got) rebuildPlayerIndexNow({ trigger: "self-heal" }).catch(() => {});
      return;
    }
    if (rowCount === 0) return;
    // ---- 索引はあるが主要クラブが入っていない場合(2026年8月7日の実測) ----
    //   索引1,401人・42クラブで Arsenal/Barcelona/Bayern などが丸ごと不在だった。
    const clubsInIndex = idx.facets && idx.facets.clubs ? idx.facets.clubs.length : 0;
    if (clubsInIndex >= Math.floor(CLUB_UNIVERSE.length * 0.8)) return;
    const got = await upstashCmd([
      "SET", "kb:universe:playercollectlock", new Date().toISOString(), "NX", "EX", "900",
    ]).catch(() => null);
    if (!got) return;
    console.log("[player-collect] self-heal start", JSON.stringify({ clubsInIndex, target: CLUB_UNIVERSE.length }));
    collectPlayersNow({ trigger: "self-heal" }).catch(() => {});
  } catch (e) { /* 修復に失敗しても本体は止めない */ }
}

async function maybeSelfHealDailyLearning() {
  if (!SELF_HEAL_DAILY_LEARNING) return;
  if (!UPSTASH_ENABLED) return;
  if (dailyLearningRunning) return;
  const now = Date.now();
  if (now - learnSweepLastCheckedAt < LEARN_SWEEP_CHECK_INTERVAL_MS) return;
  learnSweepLastCheckedAt = now;
  try {
    const latest = await upstashGetJSON("learn:growthlog:latest").catch(() => null);
    const ranMs = latest && latest.ranAt ? new Date(latest.ranAt).getTime() : null;
    const age = Number.isFinite(ranMs) ? now - ranMs : Infinity;
    let reason = age >= LEARN_SWEEP_STALE_MS ? "stale" : null;
    // 索引まわりの修復は、学習が古いかどうかとは無関係に必ず確認する
    // (「学習が古い」ときにだけ見ていると、学習が新しい日に索引が欠けたままになる)
    await maybeRepairPlayerIndex();
    // ---- 2026年8月7日・本番実測を受けた追加条件 ----
    //   実測: 選手記録は922件あるのに索引は1度も作られておらず、画面の
    //   「選手検索」が全機能停止していた。索引は毎日の学習でしか作られないため、
    //   「まだ24時間経っていないから待つ」では主要機能が丸1日止まったままになる。
    //   索引が **一度も作られていない** ときは、時間を待たずに学習を始める。
    //   (作れなかった場合に無限に走らないよう、専用の3時間ロックで抑える)
    if (!reason) return; // 定期実行は生きている(索引の修復は上で確認済み)
    // 二重起動の防止は既存のロックをそのまま使う(プロセスをまたいで効く)
    const lock = await tryAcquireDailyRunLock();
    if (!lock.acquired) return;
    dailyLearningRunning = true;
    console.log("[self-heal daily-learning] starting", JSON.stringify({
      reason,
      lastRanAt: latest && latest.ranAt ? latest.ranAt : null,
      hoursSince: Number.isFinite(age) ? Math.round(age / 3600000) : null,
    }));
    // 応答は既に返しているので、ここから先は利用者を待たせない
    runDailyLearning(learningDeps)
      .then((r) => {
        console.log("[self-heal daily-learning] done", JSON.stringify({
          ok: r && r.ok, date: r && r.date,
          playersIndexed: r && r.universe ? r.universe.playersIndexed : null,
        }));
      })
      .catch((e) => console.error("[self-heal daily-learning failed]", e && e.message))
      .finally(() => { dailyLearningRunning = false; });
  } catch (e) {
    dailyLearningRunning = false;
  }
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
  // 第7次監査で発見した欠陥の修正:
  //   `8 + Math.floor(Math.random() * 82)` で作った分数を
  //   「後半67分前後に流れを引き寄せる場面を作ると予想されます」と、
  //   あたかも分析結果であるかのように提示していた。
  //   根拠がゼロの数字なので、分数そのものを出さない。
  const turningPoint = standout
    ? `${standout.nameJa}が試合の流れを引き寄せる場面を作れるかどうかが鍵になると予想されます(具体的な時間帯を予測できる根拠はありません)。`
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
  // 第6次監査で発見した欠陥の修正:
  //   選手が0人の側があると teamAvgSrv が**固定値62**を返すため、
  //   「◯◯は攻撃力で相手を上回っており(平均62.0 対 62.0)」という、
  //   定数から作った(しかも両者同値の)比較文が生成されていた。
  //   0 === 0 なので既存の長さ検証も素通りしていた。比較する材料が無いことを
  //   正直に伝えて断る(架空の平均値で比較文を作らない)。
  if (!homeP.length || !awayP.length) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "each side needs at least one player",
        messageJa: "登録選手が1人もいないチームがあるため、能力値の比較ができません(架空の平均値で比較することはしません)。",
      },
    };
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
// ---- 2026年8月・優先順位⑲: Knowledge Graph(相互に辿れる知識の構造化) ----
// 既存の relationshipIndex は「1つの関係に1つの相手」しか持てず、逆方向の探索も
// できなかった(そのファイル冒頭に正直な制約として書かれていたとおり)。
// クラブ→監督→戦術→選手→怪我→布陣→試合→分析→学習結果 を相互に辿るには
// 出る辺・入る辺の両方の索引が必要なため、本物の有向グラフとして作り直した。
// relationshipIndex は既存の呼び出し元との互換のためそのまま残している。
const { createKnowledgeGraph } = require("./knowledge/knowledgeGraph");
const knowledgeGraph = createKnowledgeGraph({
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
});
// ---- 2026年8月・優先順位⑳: 考えの変化を1本の線として記録する ----
// 見立て → 変わったきっかけ → 新しい見立て → 予測 → 結果 → 学び
const { createThoughtTimeline } = require("./memory/thoughtTimeline");
const thoughtTimeline = createThoughtTimeline({
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
});
// ---- 2026年8月・知識拡大フェーズ: クラブ調査ファイル(UEFA上位100の構造化知識) ----
// 日次収集(universeCollector)が書き、予測・議論・マッチ分析が読む。
// これにより「APIが今この瞬間失敗した=データ不足」ではなく、
// 「直近の実測値で補い、いつのデータかを明示する」動きになる。
const { createClubDossier } = require("./knowledge/clubDossier");
const clubDossier = createClubDossier({
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
});

// ---- 2026年8月・選手スカウティングの全面刷新(ご要望①〜⑩) ----
// 夜間バッチ(universeCollector)が作った索引を、サーバー起動後に一度だけ読み、
// 以後はメモリ上で検索する。最終方針⑥「利用者が質問した瞬間に重い処理を
// 行う設計は禁止」に従い、検索1回あたりの Redis / API アクセスは 0 回。
const playerSearch = require("./knowledge/playerSearch");
const { CLUB_UNIVERSE } = require("./learning/clubUniverse");
const { collectClubPlayersBatch } = require("./learning/universeCollector");
const playerSearchDeps = {
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
};

// ============================================================================
// 2026年8月7日・「データはあるのに検索できない」の構造的な対処
// ----------------------------------------------------------------------------
// 本番の実測: 選手記録1,378件・名簿42クラブが保存済みなのに、索引は0人。
// 索引づくりが長い毎日の学習ジョブの最後にあり、そこまで到達していなかった。
// 索引づくりは外部APIを1回も使わない(保存済みの材料だけで完結する)ので、
// 長いジョブから切り離し、単体で作り直せるようにする。
// ============================================================================
let indexRebuildInFlight = false;
let lastIndexRebuild = null;   // 直前の実行結果(画面と調査のために持つ)
let playerCollectInFlight = false;
let lastPlayerCollect = null;

// ---- 2026年8月7日・「索引はできたが主要クラブが入っていない」への対処 ----
//   実測: 索引1,401人だが42クラブぶんしかなく、Arsenal/Barcelona/Bayern/
//   Man City/Liverpool/PSG が丸ごと不在。国籍Spainは2人、平均評価は354人だけ。
//   全100クラブの選手を成績つきで取る処理が、長い学習ジョブの後半にあり、
//   そこへ到達する前に学習が終わっていたため。
//   索引づくりと同じく、この収集も切り離して単体で回せるようにする。
async function collectPlayersNow(opts) {
  if (playerCollectInFlight) {
    return { ok: false, alreadyRunning: true, reasonJa: "選手データの収集は既に実行中です。" };
  }
  playerCollectInFlight = true;
  const t0 = Date.now();
  try {
    const r = await collectClubPlayersBatch({
      callApiFootball: (endpoint, params) => callApiFootball(endpoint, params, { jobCall: true }),
      clubDossier, apiBudget: await getApiBudget().catch(() => null),
      upstashGetJSON, upstashSetJSON, upstashCmd,
    }, {
      nowMs: Date.now(),
      clubLimit: Number(process.env.PLAYER_COLLECT_CLUB_LIMIT) || 25,
      trigger: (opts && opts.trigger) || "manual",
    });
    const out = { ...r, tookMs: Date.now() - t0, trigger: (opts && opts.trigger) || "manual" };
    lastPlayerCollect = out;
    await upstashSetJSON("kb:universe:lastplayercollect", out).catch(() => {});
    if (out.ok) await loadPlayerIndex(true).catch(() => {});
    console.log("[player-collect]", JSON.stringify({
      ok: out.ok, clubsFetched: out.clubsFetched, playersFetched: out.playersFetched,
      apiRequests: out.apiRequests, indexCount: out.indexCount, indexClubs: out.indexClubs,
      cursor: `${out.cursorBefore}->${out.cursorAfter}`, tookMs: out.tookMs, reasonJa: out.reasonJa,
    }));
    return out;
  } catch (e) {
    const out = { ok: false, reasonJa: `選手データの収集に失敗しました: ${e.message}`, tookMs: Date.now() - t0 };
    lastPlayerCollect = out;
    console.error("[player-collect failed]", e && e.message);
    return out;
  } finally {
    playerCollectInFlight = false;
  }
}

async function rebuildPlayerIndexNow(opts) {
  if (indexRebuildInFlight) {
    return { ok: false, alreadyRunning: true, reasonJa: "索引の作り直しは既に実行中です。" };
  }
  indexRebuildInFlight = true;
  const t0 = Date.now();
  try {
    const r = await playerSearch.rebuildIndexFromStore(playerSearchDeps, {
      clubDossier,
      clubs: CLUB_UNIVERSE,
      nowMs: Date.now(),
      dateKey: appDateKey(),
      playerRecordCap: Number(process.env.INDEX_REBUILD_RECORD_CAP) || 6000,
    });
    const out = { ...r, tookMs: Date.now() - t0, at: new Date().toISOString(), trigger: (opts && opts.trigger) || "manual" };
    lastIndexRebuild = out;
    await upstashSetJSON("kb:player:index:lastrebuild", out).catch(() => {});
    // 作り直した内容をすぐ画面に反映する
    if (out.ok) await loadPlayerIndex(true).catch(() => {});
    console.log("[player-index rebuild]", JSON.stringify({
      ok: out.ok, count: out.count, fromSquads: out.fromSquads, fromRecords: out.fromRecords,
      redisReads: out.redisReads, tookMs: out.tookMs, reasonJa: out.reasonJa,
    }));
    return out;
  } catch (e) {
    const out = { ok: false, reasonJa: `索引の作り直しに失敗しました: ${e.message}`, tookMs: Date.now() - t0, at: new Date().toISOString() };
    lastIndexRebuild = out;
    console.error("[player-index rebuild failed]", e && e.message);
    return out;
  } finally {
    indexRebuildInFlight = false;
  }
}
// 索引の再読み込み間隔。夜間バッチは1日1回しか索引を書き換えないため、
// 30分ごとに確認すれば十分(それでもRedis読み出しは1日150回程度で収まる)。
const PLAYER_INDEX_TTL_MS = Number(process.env.PLAYER_INDEX_TTL_MS) || 30 * 60 * 1000;
// 読み出しに失敗したときまで30分待つと、一瞬の通信断で機能が30分止まる。
// 失敗したときだけ短い間隔で再挑戦する。
const PLAYER_INDEX_RETRY_MS = Number(process.env.PLAYER_INDEX_RETRY_MS) || 60 * 1000;
const playerIndexState = {
  rows: [], meta: null, loadedAt: 0, loading: null,
  available: false, reasonJa: null, loadMs: null, facets: null,
  partial: false, lastError: null,
};

async function loadPlayerIndex(force) {
  const now = Date.now();
  const ttl = (playerIndexState.available && !playerIndexState.partial) ? PLAYER_INDEX_TTL_MS : PLAYER_INDEX_RETRY_MS;
  if (!force && playerIndexState.loadedAt && (now - playerIndexState.loadedAt) < ttl) {
    return playerIndexState;
  }
  // 同時アクセスで多重に読み込まないよう、進行中の読み込みを共有する
  if (playerIndexState.loading) return playerIndexState.loading;
  playerIndexState.loading = (async () => {
    const t0 = Date.now();
    try {
      const r = await playerSearch.loadIndex(playerSearchDeps);
      const gotRows = (r.rows || []).length;
      // ---- 2026年8月の監査で発見した2つの穴への対処 ----
      // ① 一部のブロックだけ読めなかったとき、以前は「少ない件数の完全な結果」
      //    として返していた。不完全であることを必ず伝える。
      // ② 一時的な失敗で0件になったとき、以前は手元の正しい索引を捨てて
      //    「索引はまだ作られていません」と答えていた。前回読めた内容を保持する。
      if (gotRows === 0 && playerIndexState.rows.length > 0 && r.available !== true) {
        playerIndexState.partial = true;
        playerIndexState.lastError = r.reasonJa || "索引の読み出しに失敗しました。";
        playerIndexState.reasonJa = `索引の再読み込みに失敗したため、前回読み込んだ${playerIndexState.rows.length}人ぶんの内容を表示しています(${r.reasonJa || "原因不明"})。`;
      } else {
        playerIndexState.rows = r.rows || [];
        playerIndexState.meta = r.meta || null;
        // 「目次があるのか無いのか」は原因の切り分けに直結するので必ず持ち回す
        playerIndexState.metaFound = r.metaFound !== undefined ? r.metaFound : !!r.meta;
        playerIndexState.expectedCount = r.expectedCount ?? null;
        playerIndexState.available = r.available !== false;
        playerIndexState.partial = r.partial === true;
        playerIndexState.reasonJa = r.reasonJa || null;
        playerIndexState.lastError = r.partial ? r.reasonJa : null;
        playerIndexState.facets = playerIndexState.rows.length ? playerSearch.facetsOf(playerIndexState.rows) : null;
      }
    } catch (e) {
      playerIndexState.available = false;
      playerIndexState.partial = true;
      playerIndexState.lastError = e.message;
      playerIndexState.reasonJa = `選手索引の読み出しに失敗しました: ${e.message}`;
    }
    playerIndexState.loadMs = Date.now() - t0;
    playerIndexState.loadedAt = Date.now();
    playerIndexState.loading = null;
    return playerIndexState;
  })();
  return playerIndexState.loading;
}

// ---- 詳細画面用の補助データ(直近5試合・移籍履歴・怪我履歴)----
// 検索には使わないので、**選手を1人開いたときに初めて**読み、以後キャッシュする。
const playerDetailStores = { recent5: null, transfers: null, injuries: null, loadedAt: 0, loading: null };
const DETAIL_STORE_TTL_MS = Number(process.env.DETAIL_STORE_TTL_MS) || 30 * 60 * 1000;
async function loadPlayerDetailStores() {
  const now = Date.now();
  if (playerDetailStores.loadedAt && (now - playerDetailStores.loadedAt) < DETAIL_STORE_TTL_MS) return playerDetailStores;
  if (playerDetailStores.loading) return playerDetailStores.loading;
  playerDetailStores.loading = (async () => {
    try {
      const [r5, tr, inj] = await Promise.all([
        playerSearch.loadShardedMap(playerSearchDeps, playerSearch.DETAIL_KEYS.recent5).catch(() => ({ map: {} })),
        playerSearch.loadShardedMap(playerSearchDeps, playerSearch.DETAIL_KEYS.transfers).catch(() => ({ map: {} })),
        playerSearch.loadShardedMap(playerSearchDeps, playerSearch.DETAIL_KEYS.injuries).catch(() => ({ map: {} })),
      ]);
      playerDetailStores.recent5 = r5.map || {};
      playerDetailStores.transfers = tr.map || {};
      playerDetailStores.injuries = inj.map || {};
    } catch (e) {
      playerDetailStores.recent5 = playerDetailStores.recent5 || {};
      playerDetailStores.transfers = playerDetailStores.transfers || {};
      playerDetailStores.injuries = playerDetailStores.injuries || {};
    }
    playerDetailStores.loadedAt = Date.now();
    playerDetailStores.loading = null;
    return playerDetailStores;
  })();
  return playerDetailStores.loading;
}

// ---- 人気検索・急上昇(⑤)----
// 検索されるたびに数えるが、Redisへの書き込みは**まとめて**行う
// (1検索1書き込みにすると、無料枠をすぐ使い切る)。
const searchTally = new Map();          // playerId -> 今日の検索回数(メモリ上)
let searchTallyFlushedAt = 0;
const SEARCH_FLUSH_INTERVAL_MS = Number(process.env.SEARCH_FLUSH_INTERVAL_MS) || 10 * 60 * 1000;
const SEARCH_TALLY_MAX = 2000;
// 「今日の注目・人気・急上昇」は選手検索タブを開くたびに呼ばれる。
// 中身は1日単位でしか変わらないので、数分キャッシュしてRedisへの往復を防ぐ。
const HIGHLIGHTS_CACHE_MS = Number(process.env.HIGHLIGHTS_CACHE_MS) || 5 * 60 * 1000;
// 選手詳細の本文キャッシュ。索引は1日1回しか変わらないので数分で十分。
// (索引が入れ替わったときは loadPlayerIndex 側で作り直されるため、
//   古い内容が長く残ることはない)
const PLAYER_DETAIL_CACHE_MS = Number(process.env.PLAYER_DETAIL_CACHE_MS) || 5 * 60 * 1000;
function notePlayerViewed(id) {
  if (!id) return;
  if (searchTally.size >= SEARCH_TALLY_MAX && !searchTally.has(id)) return;
  searchTally.set(id, (searchTally.get(id) || 0) + 1);
}
async function flushSearchTally() {
  if (!UPSTASH_ENABLED || searchTally.size === 0) return;
  const now = Date.now();
  if (now - searchTallyFlushedAt < SEARCH_FLUSH_INTERVAL_MS) return;
  searchTallyFlushedAt = now;
  const todayKey = appDateKey();
  const snapshot = [...searchTally.entries()];
  searchTally.clear();
  try {
    const prev = (await upstashGetJSON(`kb:player:views:${todayKey}`).catch(() => null)) || {};
    for (const [id, n] of snapshot) prev[id] = (prev[id] || 0) + n;
    // 上位500人だけ残す(無制限に増やさない)
    const trimmed = Object.fromEntries(
      Object.entries(prev).sort((a, b) => b[1] - a[1]).slice(0, 500)
    );
    await upstashSetJSON(`kb:player:views:${todayKey}`, trimmed);
    await upstashCmd(["EXPIRE", `kb:player:views:${todayKey}`, String(14 * 86400)]).catch(() => {});
  } catch (e) {
    // ベストエフォート。失敗しても検索は止めない。
    // ただし数えた回数を黙って捨てると「人気」が実態より少なく出るので、
    // メモリへ戻して次回の書き込みに合流させる。
    for (const [id, n] of snapshot) {
      if (searchTally.size >= SEARCH_TALLY_MAX && !searchTally.has(id)) break;
      searchTally.set(id, (searchTally.get(id) || 0) + n);
    }
    searchTallyFlushedAt = 0;   // 次のリクエストで再試行できるようにする
  }
}

/** クエリ文字列 → playerSearch が理解する検索条件 */
function parsePlayerQuery(sp) {
  const num = (k) => {
    const v = sp.get(k);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // 監査での指摘: 上限が無いと、URLいっぱいに詰めたリスト(数千件)と
  // 索引の全行の総当たりになり、1リクエストでイベントループを数百ミリ秒占有できる。
  const MAX_LIST_ITEMS = 60;
  const list = (k) => {
    const v = sp.get(k);
    if (!v) return [];
    return v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, MAX_LIST_ITEMS);
  };
  const injuredRaw = sp.get("injured");
  return {
    name: (sp.get("name") || sp.get("q") || "").trim(),
    club: (sp.get("club") || "").trim(),
    clubs: list("clubs"),
    nationality: (sp.get("nationality") || "").trim(),
    nationalities: list("nationalities"),
    leagueIds: list("leagues"),
    positions: list("positions"),
    detailedPositions: list("detailedPositions"),
    injured: injuredRaw === "true" ? true : injuredRaw === "false" ? false : undefined,
    ageMin: num("ageMin"), ageMax: num("ageMax"),
    heightMin: num("heightMin"), heightMax: num("heightMax"),
    minutesMin: num("minutesMin"), minutesMax: num("minutesMax"),
    goalsMin: num("goalsMin"), goalsMax: num("goalsMax"),
    assistsMin: num("assistsMin"), assistsMax: num("assistsMax"),
    ratingMin: num("ratingMin"), ratingMax: num("ratingMax"),
    formMin: num("formMin"), formMax: num("formMax"),
    // 2026年8月・「選手検索」統合で追加
    startRateMin: num("startRateMin"), startRateMax: num("startRateMax"),
    minutesPerAppMin: num("minutesPerAppMin"), minutesPerAppMax: num("minutesPerAppMax"),
    recent5Min: num("recent5Min"), recent5Max: num("recent5Max"),
    sort: sp.get("sort") || "rating",
    order: sp.get("order") === "asc" ? "asc" : "desc",
  };
}

const PLAYER_NOT_INCLUDED_JA = "総合点・能力値・ヒートマップはAPI-Footballでは提供されないため、収集済みデータには含まれません(実測の出場・得点・アシスト・平均評価などのみ)。";

/** 索引が空のときに返す、正直な理由つきの応答 */
function playerIndexUnavailableBody(state) {
  return {
    ok: true,
    available: false,
    indexedCount: 0,
    reasonJa: state.reasonJa
      || "選手の検索索引がまだ作られていません。毎日の学習(日次ジョブ)が次に実行されたときに作成され、その直後から検索できるようになります。",
    players: [], items: [], total: 0, page: 1, perPage: 24, totalPages: 1, hasNext: false, hasPrev: false,
    notIncludedJa: PLAYER_NOT_INCLUDED_JA,
    unavailableFieldsJa: playerSearch.UNAVAILABLE_SEARCH_FIELDS_JA,
  };
}

/**
 * 新しい索引がまだ無い間(=このコードを上げてから夜間バッチが1回走るまで)、
 * 旧世代の名前索引(kb:player:searchIndex)で従来どおり名前検索ができるようにする。
 * 最終方針①「劣化禁止」への対応: 新機能を入れた日に、既にできていたことが
 * 一時的にでもできなくなるのを避ける。
 */
async function legacyPlayerNameSearch(query, limit) {
  const found = await clubDossier.searchPlayers(query, { limit });
  const players = [];
  for (const hit of found.results || []) {
    const rec = await clubDossier.getPlayer(hit.id);
    if (!rec) {
      players.push({ ...hit, recordUnavailableJa: "選手記録の読み出しに失敗しました(索引にはあります)。" });
      continue;
    }
    // 記録ファイルは stats を入れ子で持つが、画面は索引と同じ「平ら」な形を期待する。
    // ここで揃えないと、値があるのに全部「未取得」と表示される(監査での指摘)。
    const st = rec.stats || {};
    players.push({
      ...rec,
      matchedName: hit.name,
      positionJa: playerSearch.BROAD_POSITION_JA[rec.position] || rec.position || null,
      heightCm: playerSearch.parseHeightCm(rec.height),
      appearances: st.appearances ?? null,
      minutes: st.minutes ?? null,
      goals: st.goals ?? null,
      assists: st.assists ?? null,
      rating: st.rating ?? null,
      keyPasses: st.keyPasses ?? null,
      passAccuracyPct: st.passAccuracyPct ?? null,
      dribbleSuccessRatePct: st.dribbleSuccessRatePct ?? null,
      defensiveActions: st.defensiveActions ?? null,
      duelWinRatePct: st.duelWinRatePct ?? null,
      injured: false,
      injuryChecked: false,
      injuryNoteJa: "旧方式の名前検索では怪我の有無を判定していません。",
      formDelta: null,
      detailedPosition: null, detailedPositionJa: null,
      photo: rec.id ? `https://media.api-sports.io/football/players/${rec.id}.png` : null,
    });
  }
  return {
    ok: true,
    available: found.available !== false,
    legacyIndex: true,
    reasonJa: found.reasonJa || null,
    noteJa: "新しい複数条件の索引はまだ作られていないため、従来の名前検索(前日までに収集した名簿)で応答しています。次の日次学習が走ると、複数条件での絞り込みが使えるようになります。",
    query, indexedCount: found.indexedCount ?? null,
    players, items: players,
    total: players.length, page: 1, perPage: limit, totalPages: 1, hasNext: false, hasPrev: false,
    tookMs: null,
    notIncludedJa: PLAYER_NOT_INCLUDED_JA,
    unavailableFieldsJa: playerSearch.UNAVAILABLE_SEARCH_FIELDS_JA,
    sourceJa: "毎日の学習でAPI-Footballから収集し保存した実測値です。",
  };
}

const learningDeps = {
  // 2026年8月・欠陥Aの修正: 日次ジョブ(バッチ)の呼び出しであることを明示し、
  // 利用者用の予約枠を食い潰さないようにする。
  callApiFootball: (endpoint, params) => callApiFootball(endpoint, params, { jobCall: true }),
  // 自己改善ループ①: API成功率の実測(自己診断の材料)
  getApiCallStats: apiCallStatsSnapshot,
  // (自己改善履歴の読み出しはdaily-report側で行う)
  resolveTeamId: (name) => resolveTeamId(name, { jobCall: true }),
  upstashEnabled: UPSTASH_ENABLED, upstashCmd, upstashGetJSON, upstashSetJSON,
  // Knowledge Engine Layer2(固定知識の自動生成)・Layer3(AIの毎日の見解)は
  // LLMを使う。未設定(APIキー無し)の環境でも安全に動く(dailyJob.js側で
  // generateLLMが無い場合は正直にスキップし、llmSkippedReasonsに記録する)。
  generateLLM,
  // 2026年8月・優先順位⑪: 契約プランの1日あたり上限を自動判定するための関数。
  // これを渡しておくと、日次ジョブがAPI_DAILY_BUDGETの手動設定に頼らず、
  // 実際の契約プランに合わせて自動的に予算を決められる。
  getApiPlanInfo,
  // 2026年8月: 予算インスタンスを共有し、日次ジョブ側で二重計上しないようにする
  getSharedApiBudget: getApiBudget,
  // 第7次監査で追加: 学習の記録キーを、利用者のいる地域(既定=日本)の日付に合わせる。
  // これが無いとUTC基準になり、日本の利用者が「今朝動いた」と感じる実行が
  // 前日の記録として保存され、健康診断が一日中「実行記録がありません」と誤報していた。
  appDateKey,
  // 優先順位⑲/⑳: 知識グラフと、考えの変化の時系列
  knowledgeGraph, thoughtTimeline,
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
  // ---- 第5次監査で発見した「書きっぱなしの知識」の修正 ----
  //   優先順位⑥で毎日ためている順位表・得点/アシストランキングは
  //   knowledge:byTeam:league:◯◯ という別の名前空間へ保存されるが、
  //   **それを読み出す処理が本番コードに1つも無かった**(テストからしか
  //   呼ばれていなかった)。つまり毎日APIを消費して集めたリーグの知識は、
  //   議論モードでも予測でも一度も使われていなかった。
  //   クラブが所属するリーグの知識も、そのクラブの根拠として読めるようにする。
  getActiveKnowledgeForLeague: (leagueEn) => knowledgeStore.getActiveKnowledgeForLeague(leagueEn),
  // 第6次監査での修正: 静的な設定にIDを持たない4リーグ(ブラジル・
  // チャンピオンシップ・ポルトガル・トルコ)は、実行時に解決してUpstashへ
  // キャッシュしたIDでしか照合できない。そのキャッシュも見て逆引きする
  // (見ていなかったため、その4リーグの知識は毎日集めているのに
  //  一度も読み出されていなかった)。
  leagueEntityKeyFromId: (leagueId) => _LEAGUE_CFG.leagueEntityKeyFromId(leagueId, {
    upstashGetJSON, upstashEnabled: UPSTASH_ENABLED,
  }),
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
  // 第7次監査で発見した欠陥への対応:
  //   この処理は1回あたり約23件のAPIリクエストを消費するのに、
  //   キャッシュが一切なく、home/awayは任意の文字列だった。
  //   認証不要のGETを5回投げるだけで、無料プラン(1日100件)の枠を
  //   使い切れる状態だった。文字列の長さを制限し、結果をキャッシュする。
  if (homeRaw.length > 60 || awayRaw.length > 60) {
    return { status: 400, body: { ok: false, error: "club name is too long" } };
  }
  // 分析の中身は1日のうちに大きくは変わらない(直近10試合・順位・怪我人)。
  // 同じ対戦の連打で毎回23件のAPIを使わないよう、30分キャッシュする。
  const maCacheKey = cacheKeyOf("match-analysis", [homeRaw.toLowerCase(), awayRaw.toLowerCase(), appDateKey()]);
  const maCached = cacheGet(maCacheKey);
  if (maCached) return { status: 200, body: maCached };

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

  // ---- 2026年8月・ご指示②③: 共通Feature Engineで特徴量を組み立てる ----
  // 監査で「日次学習側は4つの新特徴量へ実データを供給しているのに、
  // 利用者向けのこの分析では常に0だった」ことが判明した。原因は特徴量の
  // 組み立てが2箇所にあったこと。buildMatchFeatures に一本化し、
  // 両方が必ず同じ経路を通るようにする(二重管理の解消)。
  // 第7次監査での修正: xGの取得は1チームあたり最大5件のAPIを使う(両チームで10件)。
  // 日次ジョブ側は残量を見て見送る仕組み(canSpend)を持っているのに、
  // 利用者向けのこちらには無かったため、無料プランでは9回の分析で枠が尽きた。
  // 残量が十分にあるときだけ取得する。
  const XG_SAMPLE = Number(process.env.XG_SAMPLE_FIXTURES) || 5;
  const maBudget = await getApiBudget().catch(() => null);
  const canSpendXg = maBudget ? maBudget.remainingForUser() > XG_SAMPLE * 2 + 5 : true;
  const [homeXgInfo, awayXgInfo] = canSpendXg
    ? await Promise.all([
      fetchTeamXgAverage(homeForm.fixtures || [], homeTeamId, callApiFootball, { limit: XG_SAMPLE }).catch(() => ({ xgNet: null })),
      fetchTeamXgAverage(awayForm.fixtures || [], awayTeamId, callApiFootball, { limit: XG_SAMPLE }).catch(() => ({ xgNet: null })),
    ])
    : [{ xgNet: null }, { xgNet: null }];
  if (!canSpendXg) dataNotes.push("本日のAPIリクエストの残りが少ないため、xG(チャンスの質)の取得は見送りました。");
  // ---- 2026年8月・知識拡大フェーズ(ご指示⑤「データ不足を極力無くす」) ----
  //   これまでは「今この瞬間のAPI呼び出しが失敗した=データ不足」だった。
  //   日次収集が蓄えたクラブ調査ファイル(kb:club:*)に直近の実測値があれば
  //   それで補い、**いつ取得したデータかを必ず明示**する。
  //   鮮度の上限: 怪我・フォームは72時間、順位・xG・得点王は7日。
  //   それより古いものは使わない(古い実測で新しい試合を語るのは不正確なため)。
  const dossierFill = async (side, sideJa, src) => {
    const d = await clubDossier.getDossier(side.nameEn).catch(() => null);
    if (!d || !d.sections) return src;
    const ageHours = (sec) => {
      const t = sec && sec.computedAt ? new Date(sec.computedAt).getTime() : NaN;
      return Number.isFinite(t) ? Math.round((Date.now() - t) / 3600000) : null;
    };
    const out = { ...src };
    const fills = [];
    // 怪我(72時間以内の実測があれば)
    const injSec = d.sections.injuries;
    const injAge = ageHours(injSec);
    if ((src.injuries.error || !Number.isFinite(src.injuries.injuryCount)) && injSec && injAge !== null && injAge <= 72) {
      out.injuries = { injuryCount: injSec.injuryCount, injuredPlayers: injSec.injuredPlayers || [], suspendedPlayers: injSec.suspendedPlayers || [] };
      fills.push(`負傷者情報(${injAge}時間前に取得)`);
      // 第8次監査(Low)の修正: 上流で積んだ「取得に失敗しました」と、ここで積む
      // 「蓄積した実測値を使用しています」が同時に表示されて矛盾していた。
      // 代打が効いた場合は失敗ノートを取り下げる(取り下げ後の注記が実態)。
      const failNoteIdx = dataNotes.indexOf(`${sideJa}の負傷者情報の取得に失敗しました。`);
      if (failNoteIdx !== -1) dataNotes.splice(failNoteIdx, 1);
    }
    // 順位(7日以内)
    const stSec = d.sections.standings;
    const stAge = ageHours(stSec);
    if ((!src.standings || src.standings.position === null || src.standings.position === undefined) && stSec && stAge !== null && stAge <= 168) {
      out.standings = { position: stSec.position, points: stSec.points, played: stSec.played, goalsForAvg: stSec.goalsForAvg, goalsAgainstAvg: stSec.goalsAgainstAvg };
      fills.push(`順位(${Math.round(stAge / 24)}日前に取得)`);
    }
    // xG(7日以内)
    const xgSec = d.sections.xg;
    const xgAge = ageHours(xgSec);
    if ((!src.xg || src.xg.xgNet === null || src.xg.xgNet === undefined) && xgSec && xgAge !== null && xgAge <= 168 && xgSec.xgNet !== null) {
      out.xg = { xgNet: xgSec.xgNet };
      fills.push(`xG(${Math.round(xgAge / 24)}日前に取得)`);
    }
    // フォーム(直近試合の取得に失敗した場合のみ・72時間以内)
    const formSec = d.sections.form;
    const formAge = ageHours(formSec);
    if ((!src.form || !Array.isArray(src.form.fixtures) || !src.form.fixtures.length) && formSec && formAge !== null && formAge <= 72) {
      out.form = {
        currentFormScore: formSec.currentFormScore, avgGoalsFor: formSec.avgGoalsFor,
        avgGoalsAgainst: formSec.avgGoalsAgainst, matchesLast7Days: formSec.matchesLast7Days,
        fixtures: [],
      };
      // ホーム/アウェイ勝率は fixtures から計算できないため、実測値を直接持ち込む
      out.venueRates = { homeWinRate: formSec.homeWinRate ?? null, awayWinRate: formSec.awayWinRate ?? null };
      fills.push(`直近フォーム(${formAge}時間前に取得)`);
    }
    if (fills.length) {
      dataNotes.push(`${sideJa}の${fills.join("・")}は、毎日の学習で事前に蓄積した実測値を使用しています。`);
    }
    return out;
  };
  const homeSrcRaw = { teamId: homeTeamId, form: homeForm, injuries: homeInjuries, standings: homeStandings, xg: homeXgInfo, topScorer: homeTopScorerInfo };
  const awaySrcRaw = { teamId: awayTeamId, form: awayForm, injuries: awayInjuries, standings: awayStandings, xg: awayXgInfo, topScorer: awayTopScorerInfo };
  const [homeSrc, awaySrc] = await Promise.all([
    dossierFill(home, home.nameJa, homeSrcRaw),
    dossierFill(away, away.nameJa, awaySrcRaw),
  ]);
  const built = buildMatchFeatures(homeSrc, awaySrc, h2h);
  // 調査ファイル由来のホーム/アウェイ勝率を反映(fixturesが無い場合の補完)。
  // ctxを直したら、特徴量と供給判定も必ず作り直す(直さないと0のままになる)。
  let venueFilled = false;
  if (homeSrc.venueRates && built.homeCtx.homeVenueWinRate === null && homeSrc.venueRates.homeWinRate !== null) {
    built.homeCtx.homeVenueWinRate = homeSrc.venueRates.homeWinRate; venueFilled = true;
  }
  if (awaySrc.venueRates && built.awayCtx.awayVenueWinRate === null && awaySrc.venueRates.awayWinRate !== null) {
    built.awayCtx.awayVenueWinRate = awaySrc.venueRates.awayWinRate; venueFilled = true;
  }
  if (venueFilled) {
    built.features = computeMatchFeatures(built.homeCtx, built.awayCtx, h2h);
    built.supplied = computeFeatureAvailability(built.homeCtx, built.awayCtx, h2h);
  }
  const homeCtx = built.homeCtx;
  const awayCtx = built.awayCtx;
  const features = built.features;
  // ご指示⑥の証明用: どの特徴量に実際に値が入ったかを記録する。
  //
  // 第5次監査での拡張: これまでは新しく追加した3項目しか申告していなかった。
  // 順位・怪我人・出場停止などの古い項目は、片側のデータが取れないと
  // **0で埋められて嘘の差が生まれる**状態だったうえ、その事実が
  // どこにも表示されていなかった(順位に至っては「考慮されていません」と
  // 表示しながら、実際には大きな下駄を履かせていた)。
  // 予測モデル側で0埋めをやめたので、ここでは10項目すべてについて
  // 「今回この要素は使えたのか」を正直に伝える。
  const FEATURE_NOTE_JA = {
    formDiff: "直近フォーム",
    goalRateDiff: "得点力・失点率",
    injuryDiff: "怪我人の数",
    standingsDiff: "順位・勝点",
    headToHeadDiff: "過去の直接対戦成績",
    fatigueDiff: "過密日程(疲労)",
    venueDiff: "ホーム/アウェイ別の成績",
    suspensionDiff: "出場停止者の数",
    xgDiff: "xG(チャンスの質)",
    topScorerDiff: "エースの得点力",
  };
  const unusableFeatures = Object.keys(FEATURE_NOTE_JA).filter((k) => !built.supplied[k]);
  if (unusableFeatures.length) {
    dataNotes.push(
      `次のデータは両チーム分そろわなかったため、今回の予測には使っていません(推測で0を入れることはしていません): ${unusableFeatures.map((k) => FEATURE_NOTE_JA[k]).join("・")}。`
    );
  }

  // 第5次監査で発見した「黙って学習前の状態に戻る」問題の修正:
  //   upstashGetJSON は失敗時に null を返す(例外を投げない)ため、Upstashが
  //   一時的に落ちていると **学習済みの重みが読めず、全部0の初期状態のモデル**で
  //   予測しながら、利用者にはいつもと変わらない自信満々の回答を返していた。
  //   本文にも注記にも一切現れず、weightsInfo.version が0になるだけだった。
  //   学習結果が読めなかったことは、利用者に必ず伝える。
  let weights = EXTENDED_DEFAULT_WEIGHTS;
  if (UPSTASH_ENABLED) {
    // upstashGetJSON は失敗を握りつぶして null を返すため、
    // 「まだ学習していない」と「読み込みに失敗した」を区別できない。
    // ここでは生のコマンドを直接使い、例外として受け取る。
    try {
      const raw = await upstashCmd(["GET", "learn:weights"]);
      const stored = (raw === null || raw === undefined) ? null : JSON.parse(raw);
      if (stored) weights = { ...EXTENDED_DEFAULT_WEIGHTS, ...stored };
    } catch (e) {
      dataNotes.push("学習済みの予測モデル(重み)を読み込めなかったため、今回は学習前の初期設定で計算しています。時間をおいて再度お試しください。");
    }
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

  // 第7次監査での修正: 以前は per-IP を先に消費していたため、サイト全体の
  // 上限に達している日は、利用者の「1日10回」の枠がLLMを呼ばないまま減っていた。
  // 全体の枠を先に確認する。
  if (typeof generateLLM === "function" && (await tryConsumeLlmBudget()) && tryConsumeLlmBudgetForIp(clientIp)) {
    try {
      const systemPrompt = [
        "あなたはサッカーの試合展開を予想するアナリストAIです。",
        "与えられた実データ・計算済みの数値だけを根拠にしてください。数字を新しく作らないでください。",
        "出力は次のJSON形式のみ: {\"narrative\": \"...\", \"reverseScenario\": \"...\", \"tacticalCompatibility\": \"...\", \"biggestHighlight\": \"...\"}",
        "narrativeは試合展開の予想を100〜160文字程度の日本語で。reverseScenarioは予想が外れる場合の代替シナリオを80〜140文字程度の日本語で。",
        // 第7次監査で発見した欠陥の修正:
        //   両チームのフォーメーションが「不明」と渡されているのに、
        //   「戦術相性の見立てを80〜140文字で」と無条件に要求していた。
        //   知らないと伝えた事柄について確信的な文章を書かせるのは、
        //   本プロジェクトの「でっち上げない」原則に反する。
        //   データが無い場合は空文字を返させ、決定論的な「省略します」を残す。
        "tacticalCompatibilityは両者のフォーメーション・戦術面の相性についての見立てを80〜140文字程度の日本語で(あなたの見解であることが伝わる書き方をしてください)。",
        "ただし、与えられた情報の中でフォーメーションが「不明」となっている場合は、tacticalCompatibilityを必ず空文字(\"\")にしてください。推測で戦術相性を書いてはいけません。",
        "biggestHighlightはこの試合で最も注目すべき1点を60〜100文字程度の日本語で挙げてください(与えられた情報から言えることに限り、根拠が乏しい場合は空文字にしてください)。",
        "取得できなかった項目については、決して推測で埋めないでください。",
      ].join("\n");
      const userPrompt = [
        `${home.nameJa}(ホーム) vs ${away.nameJa}(アウェイ)`,
        `AI勝率: ${home.nameJa}${winProbability.homeWinPct}% / 引き分け${winProbability.drawPct}% / ${away.nameJa}${winProbability.awayWinPct}%`,
        `予想スコア: ${predictedScoreline}`,
        `重要度が高い要素: ${keyFactors.filter((f) => f.stars > 0).map((f) => `${f.labelJa}(${f.starsDisplay})`).join("、") || "(まだ強く学習された要素はありません)"}`,
        `${home.nameJa}: 直近7日${homeForm.matchesLast7Days}試合、負傷者${homeInjuries.injuryCount ?? "不明"}名${(homeInjuries.injuredPlayers || []).length ? `(${homeInjuries.injuredPlayers.slice(0, 3).join("・")}等)` : ""}、順位${homeStandings.position ?? "不明"}位、フォーメーション${homeFormationInfo.formation || "不明"}、注目選手${homeTopScorerInfo.player ? `${homeTopScorerInfo.player.name}(今季${homeTopScorerInfo.player.goals}得点)` : "特になし"}`,
        `${away.nameJa}: 直近7日${awayForm.matchesLast7Days}試合、負傷者${awayInjuries.injuryCount ?? "不明"}名${(awayInjuries.injuredPlayers || []).length ? `(${awayInjuries.injuredPlayers.slice(0, 3).join("・")}等)` : ""}、順位${awayStandings.position ?? "不明"}位、フォーメーション${awayFormationInfo.formation || "不明"}、注目選手${awayTopScorerInfo.player ? `${awayTopScorerInfo.player.name}(今季${awayTopScorerInfo.player.goals}得点)` : "特になし"}`,
        h2h.sampleSize > 0
          ? `過去対戦: ${h2h.sampleSize}試合中 ${home.nameJa}側${h2h.homeSideWins}勝 ${away.nameJa}側${h2h.awaySideWins}勝 ${h2h.draws}分`
          : "過去対戦: データを取得できませんでした(この観点には触れないでください)",
        // 第7次監査での追加: 「何が取得できなかったか」をモデルにも必ず伝える。
        // これまで dataNotes(正直な欠落一覧)はプロンプトに入っておらず、
        // モデルは欠落を知らないまま断定的な文章を書かされていた。
        dataNotes.length ? `【重要】今回取得できなかったデータ: ${dataNotes.join(" / ")}\nこれらについては推測で書かず、触れないでください。` : "",
      ].filter(Boolean).join("\n");
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

  // ---- 2026年8月・優先順位⑤: Memory Engineを試合予測にも使う ----
  // ご指示どおり「評価が変わった時だけ」記録し、「必要な時だけ」比較を表示する。
  // 比較の生成は読み出し1回+計算のみ(LLMも書き込みも無い)ため、
  // レスポンス速度に影響しない。記録の方は結果を待たない(fire-and-forget)。
  const evaluationForMemory = {
    predictedWinner, homeWinPct: winProbability.homeWinPct,
    features, computedAt: new Date().toISOString(),
    // 第6次監査での追加: どの特徴量に実データが入っていたか・どのバージョンの
    // 重みを使ったかも記録する。これが無いと次回の比較で
    // 「データが取れなくなっただけ」を「サッカー的に状況が変わった」と
    // 誤って説明してしまう(実際にそうなっていた)。
    supplied: built.supplied,
    weightsVersion: Number.isFinite(weights.version) ? weights.version : null,
  };
  let memoryComparison = null;
  try {
    memoryComparison = await buildComparisonForResponse({ memoryStore }, home.nameEn, away.nameEn, evaluationForMemory);
  } catch (e) { /* 付加情報なので失敗しても予測は返す */ }
  recordPredictionEvaluation({ memoryStore }, home.nameEn, away.nameEn, evaluationForMemory)
    .catch(() => { /* ベストエフォート */ });

  const maResult = {
    status: 200,
    body: {
      ok: true,
      home, away,
      winProbability: { ...winProbability, confidenceStars, confidenceStarsDisplay: starsDisplay(confidenceStars) },
      predictedScoreline,
      keyFactors,
      mostImportantFactor: topFactor ? topFactor.labelJa : "(まだ強く学習された要素はありません)",
      // 優先順位⑤: 前回から評価が変わった時だけ入る(変化が無ければnull)。
      memoryComparison,
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
  // 第7次監査での追加: 1回あたり約23件のAPIを消費するため、30分キャッシュする。
  // memoryComparison(前回との違い)は本来リクエストごとに変わりうるが、
  // 同じ対戦を30分以内に何度も開いた場合に「前回との違い」が毎回出るのは
  // むしろノイズなので、まとめてキャッシュしてよい。
  cacheSet(maCacheKey, maResult.body, 30 * 60 * 1000);
  return maResult;
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
  const todayDateKey = appDateKey();
  const runHistory = await getRunHistory(learningDeps, days, todayDateKey).catch(() => ({ available: false, reasonJa: "実行履歴の読み出しに失敗しました。", days: [] }));

  // 第6次監査での追加: 重みを更新しなかった「本当の理由」は
  // learn:weights:history に記録されている。健康診断が理由を推測しないよう、
  // 実際に記録された理由を読み出して渡す。
  try {
    const hist = (await upstashCmd(["LRANGE", "learn:weights:history", "-1", "-1"])) || [];
    if (hist.length) {
      const last = JSON.parse(hist[0]);
      if (last && last.date === todayDateKey && last.note) growthLog.weightsHistoryNoteJa = last.note;
    }
  } catch (e) { /* 読めなくても健康診断自体は返す(その場合は理由を推測しない) */ }

  const metricsTrend = await getMetricsTrend(learningDeps, 7, todayDateKey).catch(() => null);
  const zeroKnowledge = diagnoseZeroKnowledge(growthLog);
  const zeroVerification = diagnoseZeroVerification(growthLog);
  // 2026年8月・「正答率が何日も変わらない」調査を受けて追加:
  // ホーム画面に出る「AI予測の正答率」(pred:* 系)の詰まりを自動で検出させる。
  const predictionAccuracy = await handleAccuracyStats()
    .then((r) => r.body).catch(() => null);
  const engines = buildEngineStatuses({
    growthLog,
    runHistory,
    predictionAccuracy,
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
  // 第6次監査で発見した誤りの修正:
  //   buildEngineStatuses は "unknown"(確認できなかった)という状態も返すのに、
  //   集計では error でも warn でもないため無視され、**確認できていない項目が
  //   あるのに「すべての構成要素が正常に動作しています」**と表示していた。
  //   Renderの無料プランは15分でスリープし、起床直後は契約プランの自動判定が
  //   unknown になるため、これは日常的に起きる状態だった。
  const unknownCount = engines.filter((e) => e.status === "unknown").length;
  const overall = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : unknownCount > 0 ? "unknown" : "ok";
  const overallMessageJa = errorCount > 0
    ? `${errorCount}件の重大な問題が見つかりました(下の一覧の❌印を確認してください)。`
    : warnCount > 0
      ? `重大な問題はありませんが、${warnCount}件の注意点があります。`
      : unknownCount > 0
        ? `異常は見つかりませんでしたが、${unknownCount}件は現時点で状態を確認できていません(下の一覧を確認してください)。`
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
      // 第8次監査(Medium)の修正: /status応答には契約者の氏名・メールアドレスが
      // 含まれ、AUTO_COLLECT_SECRET未設定(手順書の既定)だと誰でも閲覧できた。
      // 診断に必要なプラン情報・リクエスト上限だけを返し、個人情報は返さない。
      const acct = status && status.response ? status.response : null;
      apiFootballInfo.accountInfo = acct ? {
        subscription: acct.subscription ? { plan: acct.subscription.plan ?? null, end: acct.subscription.end ?? null, active: acct.subscription.active ?? null } : null,
        requests: acct.requests ? { current: acct.requests.current ?? null, limit_day: acct.requests.limit_day ?? null } : null,
        noteJa: "個人情報(氏名・メール)は表示しません(第8次監査での修正)。",
      } : null;
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
      // 最終方針「必ず提出するもの」: 応答時間・キャッシュヒット率・CPU/メモリの実測
      perf: perfSnapshot(),
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
  // ---- 2026年8月・第三者監査が発見した「書きっぱなし」の解消 ----
  //   日次学習は次の2つも毎日書いていたのに、**読み出すコードが1つも無かった**。
  //     ・team:<X>:predictionMemory … その日の予測の要点
  //     ・memory:timeline:team:<X>:matches … 予測→結果→学びの因果の連なり
  //   どちらも「AIが何を考え、どう外し、何を学んだか」の中核なので、
  //   ここから読めるようにする(件数だけを増やして中身が見えない状態を解消)。
  const [current, history, predictionMemory, matchTimeline] = await Promise.all([
    memoryStore.getLastConclusion(subjectKey),
    memoryStore.getConclusionHistory(subjectKey, 30),
    memoryStore.getLastConclusion(`team:${teamEn}:predictionMemory`).catch(() => null),
    thoughtTimeline.getTimelineForDisplay(`team:${teamEn}:matches`, 12).catch(() => null),
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      team: teamEn,
      today: current ? { statement: current.statement, computedAt: current.computedAt, revision: current.revision } : null,
      predictionMemory: predictionMemory
        ? { statement: predictionMemory.statement, computedAt: predictionMemory.computedAt, revision: predictionMemory.revision }
        : null,
      predictionMemoryNoteJa: predictionMemory ? null : "このクラブの予測に関する記憶はまだありません(予測を1件以上立てた翌日から記録されます)。",
      matchTimeline: matchTimeline || null,
      matchTimelineNoteJa: matchTimeline && matchTimeline.length ? null : "予測→結果→学びの記録はまだありません(答え合わせが済んだ試合から作られます)。",
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

// 第8次監査(Medium)の修正×2:
//  (1) 日付キーがUTCのままで、per-IP側(appDateKey)と基準がずれていた取り残しを修正。
//  (2) プロセス内メモリだけではRenderスリープのたびに上限がリセットされ、LLM実費の
//      上限として機能しない時間帯が常態化していたため、Upstashへ永続化する
//      (障害時はメモリ側のみで判断=可用性優先)。per-IP側はキーの数が多いため
//      従来どおりメモリ管理(全体上限が永続化されていれば実費の天井は守られる)。
async function tryConsumeLlmBudget() {
  const today = appDateKey();
  if (llmDailyBudget.day !== today) llmDailyBudget = { day: today, count: 0 };
  if (llmDailyBudget.count >= MAX_LLM_CALLS_PER_DAY) return false;
  if (UPSTASH_ENABLED) {
    try {
      const n = await upstashCmd(["INCR", `llm:budget:${today}`]);
      if (Number(n) === 1) await upstashCmd(["EXPIRE", `llm:budget:${today}`, "172800"]).catch(() => {});
      if (Number(n) > MAX_LLM_CALLS_PER_DAY) return false;
    } catch (e) { /* 永続側が読めない場合はメモリ側のみで判断 */ }
  }
  llmDailyBudget.count += 1;
  return true;
}

// IPは末尾の1件のみ厳密照合はせず、既存の簡易レート制限(rateLimited関数)と
// 同じ抽出方法をそのまま踏襲する(x-forwarded-forの先頭が実クライアントIPである
// Renderの構成を想定。プロキシ構成が変わる場合は要調整)。
function tryConsumeLlmBudgetForIp(ip) {
  // 第7次監査での修正: 日本の利用者から見た「1日」に合わせる
  // (UTC基準だと日本時間の朝9時に上限がリセットされていた)
  const today = appDateKey();
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

/**
 * LLMが想定外の形式(生のJSONなど)を返したときに、利用者へ見せられる
 * 日本語の文章だけを取り出す。2026年8月・100問検証で発見した
 * 「生のJSONがそのまま画面に出る」問題への対応。
 * 取り出せなければ空文字を返す(でっち上げるより、何も言わない方がよい)。
 */
function extractReadableJa(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return "";
  // 1) JSONとして読めるなら、値のうち日本語の文章だけを集める
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      const sentences = [];
      const walk = (v, depth) => {
        if (depth > 4 || v === null || v === undefined) return;
        if (typeof v === "string") {
          const t = v.trim();
          // 日本語を含み、ある程度の長さがある文だけを採用する
          if (t.length >= 10 && /[ぁ-んァ-ヶ一-龥]/.test(t)) sentences.push(t);
          return;
        }
        if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
        if (typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
      };
      walk(obj, 0);
      if (sentences.length) return sentences.slice(0, 4).join(" ").slice(0, 800);
      return "";
    } catch (e) { /* JSONではなかった。下の処理へ */ }
  }
  // 2) JSONでないなら、記号だらけの行を除いて日本語の文章だけを残す
  const lines = text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 10 && /[ぁ-んァ-ヶ一-龥]/.test(l) && !/^[\[{"]/.test(l));
  return lines.slice(0, 6).join(" ").slice(0, 800);
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
    // ---- 2026年8月・100問検証で発見した欠陥の修正 ----
    //   LLMが指定フォーマットに従わなかった場合、生成された文章を**そのまま**
    //   AI独自の意見欄へ入れていた。ところがモデルの出力がJSONだった場合、
    //   利用者の画面には `{"narrative":"…","reverseScenario":"…"}` という
    //   生のJSONがそのまま表示されていた(「オフサイドって何ですか?」への回答が
    //   波括弧まみれの文字列になる)。
    //   まずJSONとして読める場合は中の文章を取り出し、それも無理なら
    //   人間が読める文だけを拾う。1文も拾えなければ、無理に表示せず正直に空で返す。
    const cleaned = extractReadableJa(text);
    return {
      generalView: "", aiOpinion: cleaned, counterArgument: "", finalConclusion: "",
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
  // 2026年8月・150問検証で発見した無駄:
  //   「?」1文字や絵文字だけでも、実データの取得とLLM呼び出しが丸ごと走っていた。
  //   意味のある質問になっていない場合は、費用をかけずに聞き返す方が親切。
  const meaningful = question.replace(/[\s?？!！。、.,\-_~＝=+*/\\|]/g, "");
  const hasWordChar = /[ぁ-んァ-ヶ一-龥a-zA-Z0-9]/.test(meaningful);
  if (!hasWordChar || meaningful.length < 2) {
    return {
      status: 200,
      body: {
        ok: false, reason: "question_too_short",
        message: "どんなことを知りたいか、もう少しだけ教えていただけますか?(例:「レアル・マドリードの調子はどう?」「今日はどんな試合がある?」)",
      },
    };
  }

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
  if (!(await tryConsumeLlmBudget())) {
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
  let deliberationResult = null; // 優先順位④: 6段階の熟考の結果
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
        // 第5次監査での追加: 根拠はあるのに全仮説が0点、という配線ミスを
        // 外から検知できるようにする(過去2回の監査で同種の欠陥が再発したため)
        evidencePoolSize: reasoningBundle.evidencePoolSize,
        orphanCategories: reasoningBundle.orphanCategories || [],
      };
      knowledgeMeta.deliberation = null; // 下で6段階の結果を入れる

      // ---- 第5次監査で発見した順序の誤りの修正 ----
      // 「前回の結論」の取得が deliberate() の**後ろ**に書かれていたため、
      // deliberate() には常に null が渡っていた。その結果、優先順位⑭
      // 「以前は『…』と考えていました。しかし新しいデータを学んだ結果…」という
      // 思考の変化の説明が、**一度も出たことがなかった**
      // (changedFromPrevious が毎回 null)。必ず取得してから熟考へ渡す。
      memorySubjectKey = `team:${subject.labelEn}:leadingFactor`;
      try {
        previousConclusion = await memoryStore.getLastConclusion(memorySubjectKey);
      } catch (e) { /* Memory Engine未設定・エラー時は「前回の結論なし」として続行する */ }
      if (previousConclusion) knowledgeMeta.reasoning.previousConclusion = previousConclusion.statement;

      // ---- 2026年8月・優先順位⑲: 知識グラフから「関係として整理された知識」を渡す ----
      //   単に事実を並べるのではなく、「クラブ→監督→布陣」「クラブ→加入選手」のように
      //   つながりの形で渡すことで、推論の材料として使いやすくする。
      //   追加のAPI呼び出しは無い(Redisの読み取りのみ)。
      try {
        // 監査の指摘への対応:
        //   この探索は1リクエストあたり100〜2500回のUpstash往復を発生させており、
        //   クラブについて質問するたびに数秒の遅延を生んでいた。
        //   ・深さを1に下げる(そのクラブに直接つながる関係だけで十分説明になる)
        //   ・1ノードあたりの辺を12件に絞る
        //   ・結果を10分キャッシュする(関係は1日単位でしか変わらない)
        const kgCacheKey = cacheKeyOf("kg-summary", [subject.labelEn]);
        let graphSummary = cacheGet(kgCacheKey);
        if (graphSummary === undefined) {
          graphSummary = await knowledgeGraph.summarizeNeighborhoodJa("team", subject.labelEn, {
            maxDepth: 1, maxLines: 10, maxEdgesPerNode: 12, maxVisited: 20,
          });
          cacheSet(kgCacheKey, graphSummary, 10 * 60 * 1000);
        }
        if (graphSummary && graphSummary.linesJa.length) {
          knowledgeMeta.knowledgeGraph = {
            summaryJa: graphSummary.summaryJa,
            linesJa: graphSummary.linesJa,
            nodeCount: graphSummary.nodeCount,
            edgeCount: graphSummary.edgeCount,
            truncated: graphSummary.truncated,
          };
          // 根拠一覧にも「関係」として加える(事実の羅列との違いが分かる書き方にする)
          graphSummary.linesJa.slice(0, 5).forEach((l) => facts.push(`[関係として整理した知識] ${l}`));
        }
      } catch (e) { /* 付加情報なので失敗しても回答は返す */ }

      // ---- 2026年8月・優先順位⑳: 「以前と比べて考え方が変わった理由」 ----
      //   保存済みの出来事の並びから機械的に組み立てるため、説明そのものが
      //   でっち上げになることがない。変化が記録されていなければ何も出さない。
      try {
        const change = await thoughtTimeline.explainChange(`team:${subject.labelEn}:beliefs`);
        if (change && change.available) {
          // 監査の指摘への対応:
          //   この説明は「今回の回答を出す前」の記録から作られるため、
          //   今回まさに結論が変わった場合、この欄は**1つ前の結論**を
          //   「現在はこう考えています」と述べ、同じ画面の結論欄と食い違う。
          //   いつ時点の話なのかを明示して、矛盾に見えないようにする。
          knowledgeMeta.thoughtChange = {
            narrativeJa: `(今回の回答を出す前までの記録です)${change.narrativeJa}`,
            hasOutcome: change.hasOutcome,
            hasLesson: change.hasLesson,
          };
        }
        const tl = await thoughtTimeline.getTimelineForDisplay(`team:${subject.labelEn}:beliefs`, 8);
        if (tl && tl.available) knowledgeMeta.thoughtTimeline = tl;
      } catch (e) { /* 同上 */ }

      // ---- 2026年8月・優先順位④: 6段階の熟考を実行する ----
      // どのデータが揃っていて何が欠けているかを、実際に取得できた知識から判定する
      // (推測しない: 該当カテゴリの根拠が1件でもあれば「揃っている」とみなす)。
      //
      // 第5次監査での修正: ここの対応付けに3つの誤りがあった。
      //   ・headToHead を matchReflection(AI自身の試合後の振り返り)で判定していた。
      //     gatherClubKnowledge は過去対戦成績をそもそも取得していないので、
      //     **取得していないデータを「揃っている」と申告していた**。
      //   ・xg を leagueTopScorers で判定していた。得点ランキングはxGではないうえ、
      //     リーグ名前空間(league:◯◯)はクラブの根拠プールから読めないため、
      //     この判定は**構造的に永久にfalse**だった(=星が永久に4止まり)。
      //   ・goals を dailyAiView(LLMの意見)でも「揃っている」としていた。
      //     AIの意見は実データではないので、データ充足率に数えてはいけない。
      // 取得していないものは正直に「無い」と申告する。
      // 第5次監査で発見した、より根深い誤りの修正:
      //   これまで「データが揃っているか」を**根拠プールのカテゴリ名**で
      //   判定していた。しかし根拠プールに載るのは日次学習ジョブが過去に
      //   保存した知識が中心で、**今この瞬間APIから取得できた実データが
      //   反映されていなかった**。そのため、得点力も監督も正常に取得できて
      //   いるのに「得点力・失点率のデータが不足している」と表示されていた。
      //   実際に取得できたか(knowledge の中身)を第一の根拠にし、
      //   蓄積された知識はそれを補う形でORする。
      const poolCategories = new Set((evidencePool || []).map((e) => e && e.category).filter(Boolean));
      const fetched = new Set(knowledge.fetchedTypes || []);

      // ---- 2026年8月・知識拡大フェーズ(ご指示④⑤) ----
      //   毎日の収集で蓄えたクラブ調査ファイルを、議論の根拠に必ず使う。
      //   取得時刻を明示し、鮮度の上限を超えたものは使わない。
      let dossierData = null;
      try {
        dossierData = await clubDossier.getDossier(subject.labelEn);
        if (dossierData && dossierData.sections) {
          const secs = dossierData.sections;
          const ageH = (sec) => {
            const t = sec && sec.computedAt ? new Date(sec.computedAt).getTime() : NaN;
            return Number.isFinite(t) ? Math.round((Date.now() - t) / 3600000) : null;
          };
          const fresh = (sec, limitH) => { const a = ageH(sec); return sec && a !== null && a <= limitH; };
          // UEFAランキング(静的スナップショットである旨を必ず添える)
          if (dossierData.uefaRankSnapshot) {
            facts.push(`UEFAクラブランキング: 約${dossierData.uefaRankSnapshot}位(2025年時点の係数に基づくスナップショット。最新の公式順位ではありません)`);
          }
          if (fresh(secs.standings, 168) && secs.standings.position !== null) {
            facts.push(`国内リーグ順位: ${secs.standings.position}位・勝点${secs.standings.points ?? "不明"}(${Math.round(ageH(secs.standings) / 24)}日前の実測)`);
          }
          if (fresh(secs.xg, 168) && secs.xg.xgNet !== null) {
            facts.push(`xG(チャンスの質)の収支: ${secs.xg.xgNet > 0 ? "+" : ""}${secs.xg.xgNet}(直近試合の平均・${Math.round(ageH(secs.xg) / 24)}日前の実測)`);
          }
          if (fresh(secs.squad, 240) && secs.squad.count) {
            facts.push(`登録選手数: ${secs.squad.count}人(名簿は約7日周期で更新)`);
          }
          if ((dossierData.lastChangesJa || []).length) {
            const recent = dossierData.lastChangesJa.slice(0, 3);
            recent.forEach((c) => facts.push(`[最近の変化 ${c.date}] ${c.changeJa}`));
          }
          knowledgeMeta.dossier = {
            available: true,
            sectionsStored: Object.keys(secs),
            lastUpdatedJa: dossierData.updatedAt ? `${ageH({ computedAt: dossierData.updatedAt })}時間前` : null,
          };
        }
      } catch (e) { /* 調査ファイルが無くても従来どおり動く */ }

      // ---- 2026年8月・精度証明ラウンド①: RAG強化「似たクラブ」 ----
      // 毎晩の学習が実測(順位・xG収支・ホーム勝率)の距離で作った索引を読み、
      // 最も似たクラブとその蓄積知識(監督・戦術・フォーム等)を根拠に加える。
      // 質問時のコストは索引1キーの読み出し(10分キャッシュ)+知識1クラブ分のみ。
      try {
        const simCacheKey = "kb:similar:clubs:cache";
        let simIndex = cacheGet(simCacheKey);
        if (simIndex === undefined) {
          simIndex = UPSTASH_ENABLED ? await upstashGetJSON("kb:similar:clubs").catch(() => null) : null;
          cacheSet(simCacheKey, simIndex || null, 10 * 60 * 1000);
        }
        const simEntry = simIndex && simIndex.available && simIndex.index ? simIndex.index[subject.labelEn.toLowerCase()] : null;
        if (simEntry && Array.isArray(simEntry.similar) && simEntry.similar.length) {
          const top = simEntry.similar[0];
          // 成長可視化ラウンド③: 質的な共通点(同じ布陣・怪我人数の近さ)と
          // 監督名も、実測の範囲で根拠に含める(似た監督・似た戦術・似た怪我状況)。
          const traitsPart = (top.sharedTraitsJa && top.sharedTraitsJa.length) ? `共通点: ${top.sharedTraitsJa.join("・")}。` : "";
          const coachPart = top.coachName ? `監督は${top.coachName}。` : "";
          facts.push(`[似たクラブ] 実測データ(${top.basisJa})の距離では、${top.teamJa || top.teamEn}が${subject.labelJa || subject.labelEn}に最も近い状態のクラブです。${traitsPart}${coachPart}(毎晩更新の索引による機械的な判定)`);
          try {
            // ---- 2026年8月・第三者監査が発見した「常に例外で死んでいた」箇所の修正 ----
            //   getActiveKnowledge() が返すのは配列ではなく
            //   { facts, analyses, opinions, profiles, reflections, ... } というオブジェクト。
            //   そこへ .slice() を呼んでいたため **毎回 TypeError** になり、
            //   下の catch が「知識が無かった」ものとして黙って握り潰していた。
            //   つまり「似たクラブの知識を根拠に加える」機能は一度も動いていない。
            const simKnowledge = await knowledgeStore.getActiveKnowledge(top.teamEn);
            const simItems = simKnowledge
              ? [].concat(simKnowledge.facts || [], simKnowledge.analyses || [], simKnowledge.reflections || [])
              : [];
            simItems.slice(0, 2).forEach((k) => {
              if (k && k.statement) facts.push(`[似たクラブ ${top.teamJa || top.teamEn} の知識] ${k.statement}`);
            });
          } catch (e) {
            // ここに来るのは本当に読み出しが失敗したときだけ。理由を握り潰さない。
            knowledgeMeta.similarClubKnowledgeErrorJa = `似たクラブの知識を読み出せませんでした(${e.message})`;
          }
          knowledgeMeta.similarClubs = {
            basisJa: top.basisJa,
            list: simEntry.similar.map((s) => ({ teamEn: s.teamEn, teamJa: s.teamJa, distance: s.distance })),
          };
        }
      } catch (e) { /* 付加情報。失敗しても回答は返す */ }

      deliberationResult = deliberate({
        ranked: reasoningBundle.hypotheses,
        dataAvailability: {
          form: (knowledge.recentForm || []).length > 0
            || poolCategories.has("recentFormTrend") || poolCategories.has("recentForm"),
          goals: (knowledge.goalsForTrend || []).length > 0
            || poolCategories.has("recentFormTrend") || poolCategories.has("goalRate"),
          standings: !!knowledge.standings
            || poolCategories.has("standings") || poolCategories.has("leagueStandings")
            // 第8次監査(Medium)の修正: 順位の代打データにも鮮度上限(168時間)を課す。
            // 従来は「positionが入っていれば何日前でも『揃っている』」と数えており、
            // 収集が止まった古いdossierで自信度が下がらない(根拠なき自信過大)状態だった。
            // xG(下)と同じ基準に揃える。
            || !!(dossierData && dossierData.sections && dossierData.sections.standings
              && dossierData.sections.standings.position !== null
              && (Date.now() - new Date(dossierData.sections.standings.computedAt || 0).getTime()) <= 168 * 3600000),
          // 「取得を試みて失敗しなかった」ことを条件にする。
          // 怪我人0人という結果と、取得失敗はまったく別のことなので区別する。
          injuries: (fetched.has("injuries") && !(knowledge.errors || []).includes("injuries_failed"))
            || poolCategories.has("injuries") || poolCategories.has("injury"),
          // 過去対戦成績はクラブ単体の質問では現在取得していない。
          headToHead: poolCategories.has("headToHead"),
          // 知識拡大フェーズ: xGは調査ファイルの実測(7日以内)があれば「揃っている」
          xg: poolCategories.has("xg") || !!(dossierData && dossierData.sections && dossierData.sections.xg
            && dossierData.sections.xg.xgNet !== null
            && (Date.now() - new Date(dossierData.sections.xg.computedAt || 0).getTime()) <= 168 * 3600000),
          coach: !!knowledge.coachName
            || poolCategories.has("coachChange") || poolCategories.has("coach") || poolCategories.has("managerHistory"),
          venue: !!knowledge.homeAwaySplit || poolCategories.has("homeAway")
            // 第8次監査(Medium)の修正: ホーム/アウェイ成績の代打にも鮮度上限(168時間)。
            || !!(dossierData && dossierData.sections && dossierData.sections.form
              && dossierData.sections.form.homeWinRate !== null
              && (Date.now() - new Date(dossierData.sections.form.computedAt || 0).getTime()) <= 168 * 3600000),
        },
        // 第5次監査での修正: 質問に応じて「本当に必要なデータ」だけを点検する。
        //   従来は質問内容にかかわらず8種類すべてを必須としていたため、
        //   クラブ単体の質問では取得しない xG・過去対戦成績が必ず「不足」と
        //   判定され、**どれだけ完璧にデータが揃っても自信度が★4止まり**に
        //   なっていた。Plannerが「この質問にはこれが必要」と判断した項目を
        //   そのまま使う(取得していない項目は summaryJa で別枠に正直に示す)。
        requiredKeys: (() => {
          const NEED_TO_DATA_KEY = {
            recentForm: ["form", "goals"],
            injuries: ["injuries"],
            coach: ["coach"],
            standings: ["standings"],
            formation: [],   // 布陣は8種類の点検項目には含まれない
            transfers: [],   // 移籍も同様(別途 facts として提示される)
          };
          const keys = new Set();
          for (const n of plan.needs || []) (NEED_TO_DATA_KEY[n] || []).forEach((k) => keys.add(k));
          // ホーム/アウェイ別成績は追加のAPI呼び出し無しで常に算出できるため、
          // クラブの質問では常に必要項目に含める(揃っていなければ正直に減点される)。
          keys.add("venue");
          return Array.from(keys);
        })(),
        previousConclusion,
      });
      knowledgeMeta.deliberation = {
        stages: deliberationResult.stages,
        finalConclusionJa: deliberationResult.finalConclusionJa,
        counterArgumentJa: deliberationResult.counterArgumentJa,
        confidence: deliberationResult.confidence,
        factorBreakdown: deliberationResult.factorBreakdown,
        changedFromPrevious: deliberationResult.changedFromPrevious,
      };

      // ---- 第5次監査で発見した「自信度が上限を無視していた」問題の修正 ----
      // deliberate() は「必要な8種類のデータのうち1つでも欠けていれば★4止まり」
      // という上限を正しく計算していたが、**画面に出ていたのは
      // computeClubConfidence() が別に計算した上限なしの星**だった。
      // そのため「xGや過去対戦のデータが不足しています」と本文で述べながら
      // 星は★5、という矛盾した表示が起きうる状態だった。厳しい方(小さい方)を採る。
      // 星は厳しい方(小さい方)を採り、理由は**両方**を残す。
      // computeClubConfidence には「監督コメントは取得できない」といった
      // このシステム固有の正直な断り書きが含まれており、これを失いたくないため。
      if (deliberationResult && deliberationResult.confidence
          && Number.isFinite(deliberationResult.confidence.stars)
          && confidence && Number.isFinite(confidence.stars)) {
        const dStars = deliberationResult.confidence.stars;
        const dReason = deliberationResult.confidence.reasonJa || "";
        confidence = {
          stars: Math.min(dStars, confidence.stars),
          reasonJa: [dReason, confidence.reasonJa].filter(Boolean).join(" "),
        };
      }
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

  let reasoningPromptBlock = reasoningBundle ? formatReasoningForPrompt(reasoningBundle, previousConclusion) : "";
  // 優先順位④: 6段階の検討結果をLLMへ渡し、「私は○○が最も重要だと考えます」で
  // 締めることを明示的に指示する(テンプレート化を避けるため、根拠の状況に
  // 応じて内容が毎回変わる内部メモをそのまま添える)。
  if (deliberationResult) {
    reasoningPromptBlock += `\n\n${deliberationResult.promptNote}\n` +
      `【必ず守ること】最後は必ず「${deliberationResult.stages.step6_finalConclusion.headlineJa}」という趣旨の一文で締めてください。` +
      `根拠が不足している場合は、無理に断定せず不足していることを正直に述べてください。`;
  }
  const userPrompt = [
    `利用者の質問: 「${question}」`,
    "",
    // 第7次監査で発見した誤りの修正:
    //   facts には、実データだけでなく【AIによる推定】で始まるクラブ/選手
    //   プロフィールも混ざっている。これを一律「取得できた事実」として渡し、
    //   同じプロンプトで「この事実だけを根拠にしてください」と指示していたため、
    //   AI自身の推定が実データと同じ重みの根拠としてモデルへ渡っていた。
    //   採点側(evidenceRanking)はわざわざ推定を軽く扱うようにしたのに、
    //   プロンプト側でそれが台無しになっていた。見出しで明確に区別する。
    "取得できた事実(【AIによる推定】と書かれている項目は実データではなくAIの推測です。実データと同列に扱わず、断定の根拠にしないでください):",
    facts.length ? facts.map((f) => `- ${f}`).join("\n") : "(取得できた事実はありません)",
    ...(reasoningPromptBlock ? ["", reasoningPromptBlock] : []),
  ].join("\n");

  // ---- 2026年8月・精度証明ラウンド⑥: AIモデルの自動切替 ----
  // 機械的なルールで振り分ける(LLM自身に選ばせない):
  //   実データの根拠が十分(6件以上)に揃ったクラブ考察 → 高性能モデル(深い分析に価値がある)
  //   それ以外(一般質問・選手・根拠の薄い質問) → 軽量モデル(コストを抑える)
  // 使ったモデルはmetaで開示する。LLM_TIER_ROUTING=off で全て既定モデルに戻せる。
  const realFactCountForTier = facts.filter((f) => !String(f).startsWith("【AIによる推定】")).length;
  const llmTier = (subject.type === "club" && subject.labelEn && realFactCountForTier >= 6) ? "heavy" : "light";

  let llmOut;
  let llmModelUsed = null, llmTierUsed = null;
  try {
    const { text, tier: usedTier, model: usedModel } = await generateLLM({ systemPrompt: buildDiscussSystemPrompt(), userPrompt, maxTokens: 700, tier: llmTier });
    llmTierUsed = usedTier || null;
    llmModelUsed = usedModel || null;
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
      // 第5次監査で発見した「自己肯定ループ」の修正:
      //   これまでは category に**仮説のID(recent_form 等)をそのまま**入れていた。
      //   仮説IDのうち coach / fatigue / standings は、偶然そのまま
      //   知識カテゴリ名としても使われているため、**AI自身が昨日出した結論が、
      //   翌日その同じ仮説を支持する「根拠」として読み込まれる**状態だった。
      //   しかも根拠の重みは analysis(1.5) > fact(1.0) と、実データより高い。
      //   これは「でっち上げない」という本プロジェクトの原則に真っ向から反する。
      //
      //   結論は根拠から導いたものであって、新しい根拠ではない。したがって
      //   どの仮説の relevantCategories にも属さない専用カテゴリへ保存し、
      //   AI生成であることを明記する。履歴として残るので利用者は読めるが、
      //   次の推論の根拠には数えられない。
      // 優先順位⑳: 今回の見立てを時系列にも書き足す(変化があったときだけ)。
      // 「きっかけ」は、根拠として実際に使った実データの文言をそのまま入れる。
      if (memoryResult && memoryResult.changed && selected.score > 0) {
        const factualEvidence = (selected.evidence || [])
          .filter((e) => e && (e.type === "fact" || e.type === "analysis") && !e.isAiGenerated)
          .map((e) => e.statement).slice(0, 3);
        if (factualEvidence.length) {
          await thoughtTimeline.append(`team:${subject.labelEn}:beliefs`, {
            kind: "trigger",
            statementJa: `${subject.labelJa || subject.labelEn}について新しい実データが入りました`,
            evidence: factualEvidence, at: nowIso,
          }).catch(() => {});
        }
        await thoughtTimeline.append(`team:${subject.labelEn}:beliefs`, {
          kind: "belief", statementJa: selected.statement,
          causeJa: factualEvidence.length ? null : "変化のきっかけとなる実データは特定できていません。",
          evidence: factualEvidence, at: nowIso,
        }).catch(() => {});
      }

      if (selected.score > 0) {
        await knowledgeStore.saveKnowledgeItem({
          teamEn: subject.labelEn, category: "aiLeadingFactor", type: "analysis",
          statement: `【AIの結論】${selected.statement}`,
          isAiGenerated: true,
          computedAt: nowIso,
        });
      }
    } catch (e) { /* ベストエフォート: Memory/Knowledge Engineへの保存失敗は回答自体に影響させない */ }
  }

  // ---- 2026年8月・AI知能計測ラウンド(ご指示③⑤) ----
  // 考察の質(機械的ルーブリック0〜100点)とRAG使用率(取得した知識のうち
  // 実際に回答へ使われた割合)を測定する。ここで行うのはメモリ上の文字列照合
  // (数ミリ秒)と配列への追加だけで、Redisへの書き込みは日次学習ジョブが
  // 1日1回まとめて行う(最終方針⑥「質問した瞬間に重い処理を行う設計は禁止」)。
  let intelligenceForMeta = null;
  try {
    const quality = intelligenceMetrics.scoreReasoningQuality({
      facts,
      answerFields: {
        generalView: llmOut.generalView, aiOpinion: llmOut.aiOpinion,
        counterArgument: llmOut.counterArgument, finalConclusion: llmOut.finalConclusion,
        futureOutlook: llmOut.futureOutlook, mostImportantOpinion: llmOut.mostImportantOpinion,
      },
      confidenceStars: confidence && confidence.stars,
      confidenceReasonJa: confidence && confidence.reasonJa,
    });
    intelligenceMetrics.recordDiscussSample({
      at: new Date().toISOString(),
      subjectType: subject.type || "general",
      // 成長可視化ラウンド⑥: 「以前は答えられなかった質問に今は答えられる」台帳用。
      // 対象を特定できる質問(クラブ・選手)だけ記録する(一般質問は対象外)。
      subjectKey: subject.type === "club" && subject.labelEn ? `club:${subject.labelEn}`
        : (subject.type === "player" && body.playerHint && body.playerHint.name ? `player:${body.playerHint.name}` : null),
      subjectJa: subject.type === "club" ? (subject.labelJa || subject.labelEn)
        : (subject.type === "player" && body.playerHint ? body.playerHint.name : null),
      parsedOk: !!llmOut.parsedOk,
      score: quality.total,
      components: quality.components,
      ragPool: quality.rag.poolCount,
      ragUsed: quality.rag.usedCount,
      // Memory Engineが結線されているのはクラブの質問だけ(上のStage E参照)。
      // 「対象外の質問でメモリが使われなかった」ことを利用率の低下に数えないよう、
      // 対象の質問かどうかを分けて記録する。
      memoryEligible: subject.type === "club" && !!subject.labelEn,
      memoryAttached: !!previousConclusion,
      stars: confidence && Number.isFinite(confidence.stars) ? confidence.stars : null,
    });
    intelligenceForMeta = {
      reasoningQualityScore: quality.total,
      components: quality.components,
      ragUtilization: {
        poolCount: quality.rag.poolCount, usedCount: quality.rag.usedCount,
        unusedCount: quality.rag.unusedCount, utilizationPct: quality.rag.utilizationPct,
      },
      noteJa: quality.noteJa,
    };
  } catch (e) { /* 計測は付加情報。失敗しても回答は返す */ }

  return {
    status: 200,
    body: {
      ok: true,
      facts,
      stats,
      // 2026年8月・「議論できるAI」強化フェーズ(ご要望⑤): 検索AIのような
      // 「事実の要約」ではなく、一般論→AI独自の意見→反対意見→最終結論→
      // 今後どうなるか、という「議論の型」をそのままフィールドとして返す。
      // ---- 2026年8月・100問検証で発見した欠陥の修正 ----
      //   LLMが指定した見出し形式で返さなかった場合(parsedOk=false)、
      //   6つの欄のうち「AI独自の意見」だけに全文が入り、残り5つが空のまま
      //   利用者へ返っていた。画面には見出しだけが並び、しかも
      //   「なぜ他の欄が空なのか」はどこにも書かれていなかった。
      //   何が起きたのかを正直に伝える(でっち上げて欄を埋めることはしない)。
      formatNoteJa: llmOut.parsedOk ? null
        : (llmOut.aiOpinion
          ? "AIの回答を、いつもの6つの観点(一般論/AIの意見/反対意見/最終結論/今後の見通し/最も重要な点)に整えることができませんでした。以下はAIが述べた内容そのものです。"
          : "AIの回答をうまく受け取れなかったため、今回はお答えできませんでした。お手数ですが、もう一度お試しください。"),
      generalView: llmOut.generalView,
      aiOpinion: llmOut.aiOpinion,
      counterArgument: llmOut.counterArgument,
      finalConclusion: llmOut.finalConclusion,
      futureOutlook: llmOut.futureOutlook,
      mostImportantOpinion: llmOut.mostImportantOpinion,
      confidence,
      followUpQuestions: llmOut.followUpQuestions,
      meta: { ...knowledgeMeta, llmProvider: currentProviderName(), llmTier: llmTierUsed, llmModel: llmModelUsed, parsedOk: llmOut.parsedOk, intelligence: intelligenceForMeta },
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
// ---- 2026年8月・全機能監査で実際に再現したソース流出の修正 ----
//   従来のガードは `filePath.startsWith(STATIC_ROOT)` だけだった。ところが
//   本番は「リポジトリのルートで node server.js を動かす」フラット配置のため、
//   STATIC_ROOT はリポジトリのルート**そのもの**になる。
//   つまり /server.js や /learning/dailyJob.js は「STATIC_ROOTの内側」であり、
//   ガードを素通りして **サーバーのソースコードがそのまま配信されていた**
//   (監査では `GET /../server/server.js` で実際に中身が返ることを確認。
//    URLの正規化で `..` が落ちるため、従来のガードには一度も引っかからない)。
//   ソースが読めると、内部のキー名・エンドポイント・レート制限の抜け道が
//   すべて明らかになる。公開してよいものだけを明示的に許可する方式へ変える。
const PUBLIC_STATIC_EXT = new Set([".html", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".txt", ".webmanifest"]);
// 万一 .html などの拡張子でも、置き場所として公開してはいけないもの
const PRIVATE_PATH_RE = /(^|[\\/])(\.[^\\/]*|node_modules|server|learning|knowledge|memory|rag|reasoning|discuss|llm|scripts|backups)([\\/]|$)/i;

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (e) { res.writeHead(400); res.end("Bad request"); return; }
  if (decoded.includes("\0")) { res.writeHead(400); res.end("Bad request"); return; }

  const filePath = path.normalize(path.join(STATIC_ROOT, decoded));
  // ①従来どおり、正規化後にSTATIC_ROOTの外へ出ていないこと
  if (filePath !== STATIC_ROOT && !filePath.startsWith(STATIC_ROOT + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  const relFromRoot = path.relative(STATIC_ROOT, filePath);
  // ②サーバー側のフォルダ・隠しファイルは配信しない
  if (PRIVATE_PATH_RE.test(relFromRoot)) { res.writeHead(404); res.end("Not found"); return; }
  // ③公開してよい拡張子だけ(.js/.json/.yml/.md/.env などは一切配信しない)
  const ext = path.extname(filePath).toLowerCase();
  if (!PUBLIC_STATIC_EXT.has(ext)) { res.writeHead(404); res.end("Not found"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // ソース流出と同じ轍を踏まないための最低限のセキュリティヘッダ
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
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
  // 最終方針: 全リクエストの応答時間を常時計測(perfSnapshotで提出)。
  {
    const perfT0 = Date.now();
    const perfPath = String(req.url || "").split("?")[0].split("/").slice(0, 3).join("/") || "/";
    res.on("finish", () => { try { recordPerf(perfPath, Date.now() - perfT0); } catch (e) { /* 計測は本処理を妨げない */ } });
  }
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
    const ip = clientKeyFromRequest(req);
    if (rateLimited(ip)) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ found: false, error: "レート制限に達しました。しばらく待ってから再試行してください。" }));
      return;
    }
    // 答え合わせと毎日の学習が止まっていないかを確認する(古すぎる場合だけ裏で走る)。
    // await しない = 利用者のリクエストは1ミリ秒も遅くならない。
    maybeSelfHealAutoCollect().catch(() => {});
    maybeSelfHealDailyLearning().catch(() => {});

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
      if (pathname === "/api/predictions/today") {
        // 利用者目線ラウンド: トップページの「🔮 今日のAI予想」。保存済み予測の
        // 読み出しのみ(新しい予測計算・API呼び出しは発生しない)。
        const { status, body } = await handlePredictionsToday();
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // ---- 2026年8月7日・「昨日と今日で何が変わったか」を実測で返す ----
      if (pathname === "/api/daily-diff") {
        const { status, body } = await handleDailyDiff();
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // ---- 2026年8月7日・毎日の学習が「どこまで進んだか」を見る ----
      //   本番で「収集は進んだのに成長ログは前日のまま」= 途中で止まっている
      //   ことが分かったが、どこで止まったのかが分からなかった。
      if (pathname === "/api/learning/progress") {
        const prog = await upstashGetJSON("learn:progress").catch(() => null);
        const lastRebuild = await upstashGetJSON("kb:player:index:lastrebuild").catch(() => null);
        const ageSec = prog && prog.at ? Math.round((Date.now() - new Date(prog.at).getTime()) / 1000) : null;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          available: !!prog,
          reasonJa: prog ? null : "まだ進捗の記録がありません(この機能を入れてから学習が1度も走っていません)。",
          progress: prog || null,
          secondsSinceLastStage: ageSec,
          verdictJa: !prog ? null
            : prog.finished ? `直近の学習は最後まで完了しています(${prog.elapsedSec}秒)。`
              : (ageSec !== null && ageSec > 900
                ? `「${prog.stage}」の段階で ${Math.round(ageSec / 60)}分 止まっています。ここで落ちた可能性が高いです。`
                : `いま「${prog.stage}」の段階を実行中です(開始から${prog.elapsedSec}秒)。`),
          playerIndexLastRebuild: lastRebuild || lastIndexRebuild || null,
          dailyLearningRunning,
        }));
        return;
      }
      // ---- 2026年8月7日・選手データを100クラブぶん集めきる(区切って実行) ----
      //   1回あたり25クラブ(API 50〜100回)。次回は続きから巡回するので、
      //   4回まわせば100クラブすべてが検索対象になる。
      if (pathname === "/api/knowledge/collect-players") {
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        if (!requiredSecret) {
          const got = await upstashCmd([
            "SET", "kb:universe:playercollectlock", new Date().toISOString(), "NX", "EX", "600",
          ]).catch(() => null);
          if (!got) {
            const last = await upstashGetJSON("kb:universe:lastplayercollect").catch(() => null);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              ok: true, started: false, throttled: true,
              messageJa: "選手データの収集は10分に1回までです(外部APIを使うため)。直前の結果を返します。",
              lastCollect: last || lastPlayerCollect || null,
            }));
            return;
          }
        }
        const r = await collectPlayersNow({ trigger: "manual" });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true, collected: r.ok === true, result: r,
          messageJa: r.ok
            ? `${r.clubsFetched}クラブ・${r.playersFetched}人を取得し、索引を ${r.indexCount}人(${r.indexClubs}クラブ)に更新しました`
              + `(API ${r.apiRequests}回・${Math.round(r.tookMs / 1000)}秒)。`
              + (r.cursorAfter !== null ? ` 次回は${r.cursorAfter + 1}番目のクラブから続けます。` : "")
            : (r.reasonJa || "収集できませんでした。"),
        }));
        return;
      }
      // ---- 2026年8月7日・保存済みデータから選手索引を作り直す ----
      //   外部API(API-Football)の呼び出しは0回。毎日の学習が止まっていても
      //   これだけで選手検索が復活する。
      if (pathname === "/api/knowledge/rebuild-player-index") {
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        // シークレット未設定でも外部から連打されないよう、30分に1回に制限する
        // (索引づくりはRedis読み出しが数千回になるため)
        if (!requiredSecret) {
          const got = await upstashCmd([
            "SET", "kb:player:index:rebuildlock", new Date().toISOString(), "NX", "EX", "1800",
          ]).catch(() => null);
          if (!got) {
            const last = await upstashGetJSON("kb:player:index:lastrebuild").catch(() => null);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
              ok: true, started: false, throttled: true,
              messageJa: "索引の作り直しは30分に1回までです(保存先への読み出しが数千回になるため)。直前の結果を返します。",
              lastRebuild: last || lastIndexRebuild || null,
            }));
            return;
          }
        }
        const result = await rebuildPlayerIndexNow({ trigger: "manual" });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true, rebuilt: result.ok === true, result,
          messageJa: result.ok
            ? `保存済みのデータから ${result.count}人 の索引を作り直しました(外部APIの呼び出し 0回・保存先への読み出し ${result.redisReads}回・${result.tookMs}ミリ秒)。`
            : (result.reasonJa || "索引を作り直せませんでした。"),
        }));
        return;
      }
      // ---- 2026年8月7日・「正答率が動かない」調査で必要になった可視化 ----
      //   直前の1回ぶん(pred:autocollect:lastrun)しか外から見えなかったため、
      //   「毎回どうなっているのか」が分からず、原因の切り分けに丸1往復かかった。
      //   直近30回ぶんの実行記録をそのまま返す(保存済みの読み出しのみ)。
      if (pathname === "/api/predictions/autocollect-log") {
        if (!UPSTASH_ENABLED) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, available: false, reasonJa: "保存先(Upstash)が未設定のため、実行記録を読み出せません。", runs: [] }));
          return;
        }
        const raw = (await upstashCmd(["LRANGE", "pred:autocollect:log", "0", "29"]).catch(() => [])) || [];
        const runs = raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
        const resolvedTotal = runs.reduce((a, r) => a + (Number(r.resolved) || 0), 0);
        const loggedTotal = runs.reduce((a, r) => a + (Number(r.logged) || 0), 0);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true, available: runs.length > 0,
          reasonJa: runs.length ? null : "まだ実行記録がありません。",
          runs,
          summary: {
            runCount: runs.length,
            resolvedTotal, loggedTotal,
            // 記録が答え合わせを上回り続けると、待ち行列は永久に縮まない
            queueGrowingJa: loggedTotal > resolvedTotal
              ? `直近${runs.length}回で 新規記録${loggedTotal}件 > 答え合わせ${resolvedTotal}件 のため、答え合わせ待ちは増える一方です。`
              : `直近${runs.length}回で 答え合わせ${resolvedTotal}件 ≧ 新規記録${loggedTotal}件 のため、待ち行列は縮んでいます。`,
            triggers: runs.reduce((acc, r) => { const k = r.trigger || "unknown"; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
          },
        }));
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
        const maRequestIp = clientKeyFromRequest(req);
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
        const discussClientIp = clientKeyFromRequest(req);
        const { status, body } = await handleDiscuss(parsedBody, discussClientIp);
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/backup/export") {
        // 精度証明ラウンド④: 学習状態のバックアップ。内部データを含むため、
        // debug-status等と同じくAUTO_COLLECT_SECRET設定時は?key=一致を要求する。
        const requiredSecret = process.env.AUTO_COLLECT_SECRET || "";
        if (requiredSecret && parsed.searchParams.get("key") !== requiredSecret) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "invalid or missing key" }));
          return;
        }
        const { status, body } = await handleBackupExport();
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
        // 第7次監査で発見した欠陥の修正:
        //   AUTO_COLLECT_SECRET を設定していない場合(手順書での既定)、
        //   `GET /api/learning/run-daily?force=1&sync=1` を繰り返し呼ぶだけで、
        //   ロックも実行中フラグも両方すり抜けて**無制限に学習ジョブを同時起動**
        //   できた(1回あたり数十〜100件のAPIを消費する)。
        //   逃げ道である ?force= は、シークレットを設定している場合にだけ使えるようにする。
        const forceRequested = parsed.searchParams.get("force") === "1";
        // シークレットを設定していない場合、?force=1 は1日あたりの回数を制限する
        // (デバッグ用の逃げ道は残しつつ、無制限の連続起動は防ぐ)。
        if (forceRequested && !requiredSecret && !(await consumeUnprotectedForceRun())) {
          res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: false, error: "force run limit reached",
            messageJa: `?force=1(二重起動の保護を外す指定)は、AUTO_COLLECT_SECRETを設定していない場合、1日${UNPROTECTED_FORCE_RUN_MAX}回までに制限しています。無制限に使えると、外部から何度でも学習ジョブを起動でき、APIの利用枠を使い切られてしまうためです。AUTO_COLLECT_SECRETを設定すると制限なく使えます。`,
          }));
          return;
        }
        const runLockOk = forceRequested
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
        // 第7次監査での修正: ?sync=1 が dailyLearningRunning の確認より前に
        // 書かれていたため、sync指定だけでプロセス内の二重起動防止も
        // すり抜けられた。どちらの経路でも必ずフラグを確認・設定する。
        if (dailyLearningRunning) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, alreadyRunning: true, message: "学習ジョブは既に実行中です(二重起動を防ぐためスキップしました)。数分後に/api/growth-logで結果を確認してください。" }));
          return;
        }
        if (parsed.searchParams.get("sync") === "1") {
          dailyLearningRunning = true;
          try {
            const result = await runDailyLearning(learningDeps);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(result));
          } finally {
            dailyLearningRunning = false;
          }
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
      if (pathname === "/api/knowledge/coverage") {
        // 知識拡大フェーズの「実際に何件入っているか」を実測で返す。
        // 「実装しました」ではなく「実際に動いている」ことの証明用。
        // 全クラブの読み出しはRedisアクセスが多いため5分キャッシュする。
        const covCached = cacheGet("kb:coverage");
        if (covCached) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(covCached));
          return;
        }
        const summary = await clubDossier.getCoverageSummary();
        // 2026年8月・選手スカウティング刷新: 検索索引の実測状態も同梱する
        // (「作りました」ではなく「実際に何件入っているか」を確認するため)。
        const idxState = await loadPlayerIndex(false).catch(() => null);
        const C = playerSearch.COL;
        const rows = (idxState && idxState.rows) || [];
        const playerIndex = {
          available: rows.length > 0,
          partial: !!(idxState && idxState.partial),
          reasonJa: (idxState && idxState.reasonJa) || (rows.length ? null : "索引がまだ作られていません。"),
          count: rows.length,
          // 「目次が無い」のか「目次はあるが中身が0」のかを外から区別できるようにする
          metaFound: idxState ? (idxState.metaFound === true) : null,
          expectedCount: idxState ? (idxState.expectedCount ?? null) : null,
          builtAt: (idxState && idxState.meta && idxState.meta.builtAt) || null,
          shardCount: (idxState && idxState.meta && idxState.meta.shardCount) || null,
          sources: (idxState && idxState.meta && idxState.meta.sources) || null,
          loadMs: idxState ? idxState.loadMs : null,
          withRating: rows.filter((r) => r[C.rating] !== null && r[C.rating] !== undefined).length,
          withDetailedPosition: rows.filter((r) => r[C.detailedPos]).length,
          withNationality: rows.filter((r) => r[C.nationality]).length,
          injured: rows.filter((r) => r[C.injured] === 1).length,
          clubs: new Set(rows.map((r) => r[C.teamEn]).filter(Boolean)).size,
          nationalities: new Set(rows.map((r) => r[C.nationality]).filter(Boolean)).size,
        };
        const body = { ok: true, generatedAt: new Date().toISOString(), ...summary, playerIndex };
        cacheSet("kb:coverage", body, 5 * 60 * 1000);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // ---- 2026年8月・「選手スカウティングへの登録」調査で作った橋渡し ----
      //   毎日の収集で kb:player:<id> に選手記録が貯まっていたのに、
      //   それを読み出すエンドポイントが1つも無く、画面の選手検索は
      //   index.html に直書きされた107人だけを対象にしていた。
      //   収集済みの全選手を名前で引けるようにする。
      //   ---- 2026年8月・全面刷新 ----
      //   名前1本の検索から、複数条件+ページネーション+ファセットへ。
      //   夜間バッチが作った索引をメモリで絞り込むため、
      //   このリクエストの中では Redis も API も呼ばない(索引の再読み込み時を除く)。
      if (pathname === "/api/knowledge/players") {
        const t0 = Date.now();
        const state = await loadPlayerIndex(false);
        if (!state.rows.length) {
          // 索引がまだ無い間は、旧世代の名前索引で従来どおり応答する(劣化禁止)
          const nameOnly = (parsed.searchParams.get("name") || parsed.searchParams.get("q") || "").trim();
          const legacyLimit = Math.max(1, Math.min(50, parseInt(parsed.searchParams.get("limit"), 10)
            || parseInt(parsed.searchParams.get("perPage"), 10) || 10));
          const body = nameOnly
            ? await legacyPlayerNameSearch(nameOnly, legacyLimit).catch(() => playerIndexUnavailableBody(state))
            : playerIndexUnavailableBody(state);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(body));
          return;
        }
        const query = parsePlayerQuery(parsed.searchParams);
        const page = Math.max(1, parseInt(parsed.searchParams.get("page"), 10) || 1);
        const perPage = Math.max(1, Math.min(100, parseInt(parsed.searchParams.get("perPage"), 10)
          || parseInt(parsed.searchParams.get("limit"), 10) || 24));
        const matched = playerSearch.searchIndex(state.rows, query);
        const pageData = playerSearch.paginate(matched, page, perPage);
        const tookMs = Date.now() - t0;
        const body = {
          ok: true,
          available: true,
          query,
          indexedCount: state.rows.length,
          indexBuiltAt: state.meta && state.meta.builtAt ? state.meta.builtAt : null,
          ...pageData,
          // 旧クライアント(名前検索だけを見ていた版)との互換
          players: pageData.items,
          tookMs,
          performanceJa: `索引${state.rows.length}件をメモリ上で絞り込みました(${tookMs}ミリ秒)。この検索でのデータベース・外部APIへのアクセスは0回です。`,
          unavailableFieldsJa: playerSearch.UNAVAILABLE_SEARCH_FIELDS_JA,
          notIncludedJa: PLAYER_NOT_INCLUDED_JA,
          sourceJa: "毎日の学習でAPI-Footballから収集し保存した実測値です。",
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // ---- 2026年8月・「選手検索」1ページ統合で追加したエンドポイント ----
      // ② 入力途中の候補表示(オートコンプリート)。
      //    索引はメモリにあるので、1文字ごとに呼ばれても Redis も外部APIも触らない。
      if (pathname === "/api/players/suggest") {
        const t0 = Date.now();
        const field = parsed.searchParams.get("field") || "name";
        const q = parsed.searchParams.get("q") || "";
        const limit = parseInt(parsed.searchParams.get("limit"), 10) || 8;
        const state = await loadPlayerIndex(false);
        const items = state.rows.length ? playerSearch.suggest(state.rows, field, q, limit) : [];
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          // 候補は数分変わらないので、ブラウザ側にも短く持たせる
          "Cache-Control": "public, max-age=120",
        });
        res.end(JSON.stringify({
          ok: true, field, query: q, items,
          available: state.rows.length > 0,
          reasonJa: state.rows.length ? null : (state.reasonJa || "索引がまだ作られていません。"),
          tookMs: Date.now() - t0,
        }));
        return;
      }
      // ③ AIおすすめ選手
      if (pathname === "/api/players/recommend") {
        const t0 = Date.now();
        const state = await loadPlayerIndex(false);
        if (!state.rows.length) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, available: false, items: [], reasonJa: state.reasonJa || "索引がまだ作られていません。" }));
          return;
        }
        const preset = parsed.searchParams.get("preset") || null;
        const query = parsePlayerQuery(parsed.searchParams);
        // 空の条件は渡さない(プリセットの条件を打ち消さないため)
        const cleaned = {};
        for (const [k, v] of Object.entries(query)) {
          if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
          if (k === "sort" || k === "order") continue;
          cleaned[k] = v;
        }
        const result = playerSearch.recommendPlayers(state.rows, {
          preset, query: cleaned,
          limit: parseInt(parsed.searchParams.get("limit"), 10) || 10,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true, ...result,
          presets: Object.entries(playerSearch.RECOMMEND_PRESETS).map(([k, v]) => ({ key: k, labelJa: v.labelJa, reasonJa: v.reasonJa })),
          tookMs: Date.now() - t0,
        }));
        return;
      }
      // ⑤⑥ 人気検索・急上昇・今日AIが注目する5人
      if (pathname === "/api/players/highlights") {
        const t0 = Date.now();
        // これは「選手検索」タブを開くたびに必ず呼ばれる。中身は1日単位でしか
        // 変わらない(注目5人)か、数分ずれても支障のないもの(閲覧数)なので、
        // サーバー側で数分キャッシュする。これをしないと利用者1人につき
        // Redisコマンドを3回使い、10万人規模で無料枠を即座に使い切る。
        const cachedHl = cacheGet("players:highlights");
        if (cachedHl) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=120" });
          res.end(JSON.stringify({ ...cachedHl, cached: true }));
          return;
        }
        const state = await loadPlayerIndex(false);
        if (!state.rows.length) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, available: false, reasonJa: state.reasonJa || "索引がまだ作られていません。", picks: [], popular: [], trending: [] }));
          return;
        }
        const byId = new Map(state.rows.map((r) => [Number(r[playerSearch.COL.id]), r]));
        const todayKey = appDateKey();
        const yesterdayKey = appDateKey(new Date(Date.now() - 86400000));
        const [todayViews, yesterdayViews, feedRaw] = await Promise.all([
          upstashGetJSON(`kb:player:views:${todayKey}`).catch(() => null),
          upstashGetJSON(`kb:player:views:${yesterdayKey}`).catch(() => null),
          upstashCmd(["LRANGE", "kb:player:scoutfeed", "0", "80"]).catch(() => []),
        ]);
        const tv = todayViews || {};
        const yv = yesterdayViews || {};
        // 今メモリに溜まっているぶんも足す(書き戻し前でも画面に反映される)
        for (const [id, n] of searchTally) tv[id] = (tv[id] || 0) + n;
        const popular = Object.entries(tv)
          .sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([id, n]) => (byId.has(Number(id)) ? { ...playerSearch.fromIndexRow(byId.get(Number(id))), views: n } : null))
          .filter(Boolean);
        // 急上昇 = 昨日より増えた幅が大きい順(昨日0でも増分で測る)
        const trending = Object.entries(tv)
          .map(([id, n]) => ({ id: Number(id), delta: n - (yv[id] || 0), n }))
          .filter((x) => x.delta > 0 && byId.has(x.id))
          .sort((a, b) => b.delta - a.delta).slice(0, 8)
          .map((x) => ({ ...playerSearch.fromIndexRow(byId.get(x.id)), views: x.n, viewsDelta: x.delta }));
        // 今日AIが注目する5人(移籍・怪我復帰はスカウト速報から拾う)
        const feed = (feedRaw || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
        const highlights = playerSearch.dailyHighlights(state.rows, {
          limit: 5,
          recentTransfers: feed.filter((f) => f.type === "transfer").map((f) => ({ playerId: f.playerId, detailJa: f.detailJa })),
          injuryReturns: [],
        });
        const hlBody = {
          ok: true, available: true,
          picks: highlights.items, picksMethodJa: highlights.methodJa, picksReasonJa: highlights.reasonJa,
          popular, trending,
          popularNoteJa: popular.length ? "このサイトで実際に開かれた回数です(本日ぶん)。" : "まだ十分な閲覧がありません(選手を開くと集計が始まります)。",
          trendingNoteJa: trending.length ? "昨日と比べて閲覧が増えた順です。" : "前日との比較ができるだけの記録がまだありません。",
          indexBuiltAt: state.meta && state.meta.builtAt ? state.meta.builtAt : null,
          tookMs: Date.now() - t0,
        };
        cacheSet("players:highlights", hlBody, HIGHLIGHTS_CACHE_MS);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=120" });
        res.end(JSON.stringify(hlBody));
        return;
      }
      // 絞り込みの候補一覧(クラブ・国籍・リーグ・ポジション)。
      // クラブはTOP100の全クラブを返す(索引にまだ選手がいないクラブも
      // 「0人」として出し、なぜ0人なのかが分かるようにする)。
      if (pathname === "/api/knowledge/player-facets") {
        const state = await loadPlayerIndex(false);
        const facets = state.facets || { clubs: [], nationalities: [], leagues: [], positions: [], detailedPositions: [] };
        const byEn = new Map(facets.clubs.map((c) => [c.teamEn, c]));
        const clubs = CLUB_UNIVERSE.map((c) => {
          const hit = byEn.get(c.nameEn);
          return {
            teamEn: c.nameEn, teamJa: c.nameJa, country: c.country,
            leagueId: c.leagueId ?? (hit ? hit.leagueId : null),
            rank: c.rank,
            playerCount: hit ? hit.count : 0,
            noteJa: hit ? null : "このクラブの選手はまだ索引に入っていません(名簿の取得が輪番待ち、またはクラブ名の照合に失敗しています)。",
          };
        });
        // 索引にあるがTOP100の表記と一致しないクラブも落とさずに出す
        for (const c of facets.clubs) {
          if (!CLUB_UNIVERSE.some((u) => u.nameEn === c.teamEn)) {
            clubs.push({ teamEn: c.teamEn, teamJa: c.teamJa, country: null, leagueId: c.leagueId, rank: null, playerCount: c.count, noteJa: null });
          }
        }
        const body = {
          ok: true,
          available: state.rows.length > 0,
          reasonJa: state.rows.length ? null : (state.reasonJa || "索引がまだ作られていません。"),
          indexedCount: state.rows.length,
          // ---- 2026年8月7日の指摘への対応 ----
          //   画面が「クラブ100件」と書いていたが、それは選べる一覧の数であって
          //   実際に選手が入っているクラブ数ではなかった(実測では42クラブ)。
          //   誤解を招くので、実数を渡して画面が正直に書けるようにする。
          clubsWithPlayers: clubs.filter((c) => Number(c.count) > 0).length,
          withRatingCount: state.rows.filter((r) =>
            r[playerSearch.COL.rating] !== null && r[playerSearch.COL.rating] !== undefined).length,
          withNationalityCount: state.rows.filter((r) => r[playerSearch.COL.nationality]).length,
          indexBuiltAt: state.meta && state.meta.builtAt ? state.meta.builtAt : null,
          clubs,
          totalClubs: clubs.length,
          nationalities: facets.nationalities,
          leagues: facets.leagues,
          positions: facets.positions,
          detailedPositions: facets.detailedPositions,
          positionLabelsJa: playerSearch.BROAD_POSITION_JA,
          detailedPositionLabelsJa: playerSearch.DETAILED_POSITION_JA,
          detailedPositionNoteJa: "API-Footballが返すポジションは GK / DF / MF / FW の4分類だけです。CB・SB・DMF・CMF・AMF・WG・CF は、毎日取得しているスタメンの配置データ(3試合以上)から推定したもので、左右の別(RB/LBやRW/LW)は座標系の向きが確定できないため断定していません。",
          unavailableFieldsJa: playerSearch.UNAVAILABLE_SEARCH_FIELDS_JA,
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // 選手1人の詳細 + AI分析(⑧)。索引はメモリ、補助データはキャッシュ。
      //
      // ここは「選手検索」で最もよく叩かれる。1回ごとにRedisを読むと
      // 10万人規模で無料枠(10,000コマンド/日)を即座に超えるため、
      //   ・組み立て済みの本文を数分キャッシュする
      //   ・記録本体(kb:player:<id>)は既定では読まない(?withRecord=1 のときだけ)
      // という2点で、通常の閲覧のRedisコマンドを0回にしている。
      // 閲覧数の集計だけはキャッシュに当たっても必ず数える。
      if (pathname === "/api/knowledge/player") {
        const id = parseInt(parsed.searchParams.get("id"), 10);
        if (!Number.isFinite(id)) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reasonJa: "選手ID(id)を指定してください。" }));
          return;
        }
        const withRecord = parsed.searchParams.get("withRecord") === "1";
        const t0 = Date.now();
        const state = await loadPlayerIndex(false);
        // キャッシュの鍵に索引の世代を入れる。毎朝索引が作り直された瞬間に
        // 古い本文が無効になるので、「移籍したのに前のクラブが出る」が起きない。
        const detailCacheKey = `player:detail:${(state.meta && state.meta.builtAt) || "none"}:${id}`;
        if (!withRecord) {
          const hit = cacheGet(detailCacheKey);
          if (hit) {
            notePlayerViewed(id);
            flushSearchTally().catch(() => {});
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ...hit, cached: true }));
            return;
          }
        }
        const row = state.rows.find((r) => Number(r[playerSearch.COL.id]) === id);
        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: false, available: state.rows.length > 0,
            reasonJa: state.rows.length
              ? "この選手は索引に入っていません(TOP100クラブの所属選手のみを収集しています)。"
              : (state.reasonJa || "索引がまだ作られていません。"),
          }));
          return;
        }
        const analysis = playerSearch.analyzePlayer(state.rows, row);
        // 補助データ(直近5試合・移籍・怪我)は詳細を開いたときだけ読み、
        // 読んだあとは全リクエストで共有する(loadPlayerDetailStoresがキャッシュ)。
        // 記録本体は索引と重複する内容なので、明示的に求められたときだけ読む。
        const [record, stores] = await Promise.all([
          withRecord ? clubDossier.getPlayer(id).catch(() => null) : Promise.resolve(null),
          loadPlayerDetailStores().catch(() => ({ recent5: {}, transfers: {}, injuries: {} })),
        ]);
        // 人気検索・急上昇の集計(まとめて書き戻すので、ここではメモリに足すだけ)
        notePlayerViewed(id);
        flushSearchTally().catch(() => {});
        const view = playerSearch.fromIndexRow(row);
        const recent5 = (stores.recent5 || {})[String(id)] || [];
        const transfers = (stores.transfers || {})[String(id)] || [];
        const injuries = (stores.injuries || {})[String(id)] || [];
        // 同ポジション内での順位(⑤ 同ポジション順位)
        const posRows = state.rows.filter((r) => r[playerSearch.COL.position] === row[playerSearch.COL.position]);
        const rankOf = (col) => {
          const mine = row[col];
          if (mine === null || mine === undefined) return null;
          const vals = posRows.map((r) => r[col]).filter((v) => v !== null && v !== undefined);
          if (vals.length < 20) return null;
          const better = vals.filter((v) => v > mine).length;
          return { rank: better + 1, of: vals.length };
        };
        const body = {
          ok: true, available: true,
          player: view,
          analysis,
          // ---- 2026年8月・「選手検索」統合で追加した情報 ----
          seasonStats: {
            appearances: view.appearances, lineups: view.lineups,
            startRatePct: view.startRatePct, minutes: view.minutes,
            minutesPerAppearance: view.minutesPerAppearance,
            goals: view.goals, assists: view.assists, rating: view.rating,
            keyPasses: view.keyPasses, passAccuracyPct: view.passAccuracyPct,
            dribbleSuccessRatePct: view.dribbleSuccessRatePct,
            defensiveActions: view.defensiveActions, duelWinRatePct: view.duelWinRatePct,
            yellowCards: view.yellowCards, redCards: view.redCards,
            noteJa: "今シーズンの累計です。取得できていない項目は0ではなく「未取得」と表示します。",
          },
          recentMatches: {
            available: recent5.length > 0,
            items: recent5,
            reasonJa: recent5.length ? null : "この選手が出場した直近の試合ごとの記録が、まだ取得できていません(毎日の学習で順次集まります)。",
          },
          positionRanks: {
            positionJa: view.positionJa,
            sampleSize: posRows.length,
            rating: rankOf(playerSearch.COL.rating),
            goals: rankOf(playerSearch.COL.goals),
            assists: rankOf(playerSearch.COL.assists),
            minutes: rankOf(playerSearch.COL.minutes),
            noteJa: "同じポジションの選手の中での順位です(実測値が取れている選手のみを母集団にしています)。",
          },
          transferHistory: {
            available: transfers.length > 0,
            items: transfers,
            reasonJa: transfers.length ? null : "移籍の記録がまだありません(所属クラブの移籍情報を毎日取得しており、そこに現れた時点で表示されます)。",
          },
          injuryHistory: {
            available: injuries.length > 0,
            items: injuries,
            reasonJa: injuries.length ? null : "負傷の記録がまだありません(負傷者リストに載った時点で記録されます)。",
          },
          record: record || null,
          recordNoteJa: withRecord
            ? (record ? null : "個別の記録ファイルはまだ作られていません(索引の実測値のみ表示しています)。")
            : "表示している数値は毎日の学習で作られた索引の実測値です(記録本体は ?withRecord=1 で取得できます)。",
          indexBuiltAt: state.meta && state.meta.builtAt ? state.meta.builtAt : null,
          tookMs: Date.now() - t0,
          unavailableFieldsJa: playerSearch.UNAVAILABLE_SEARCH_FIELDS_JA,
        };
        if (!withRecord) cacheSet(detailCacheKey, body, PLAYER_DETAIL_CACHE_MS);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // 2〜4人の比較(⑨)
      if (pathname === "/api/knowledge/player-compare") {
        const ids = (parsed.searchParams.get("ids") || "")
          .split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
        if (ids.length < 2 || ids.length > 4) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reasonJa: "比較する選手のIDを2〜4人ぶん、ids=1,2,3 の形式で指定してください。" }));
          return;
        }
        const t0 = Date.now();
        const state = await loadPlayerIndex(false);
        const rows = [];
        const missing = [];
        for (const id of ids) {
          const row = state.rows.find((r) => Number(r[playerSearch.COL.id]) === id);
          if (row) rows.push(row); else missing.push(id);
        }
        if (rows.length < 2) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: false, missing,
            reasonJa: state.rows.length
              ? `指定された選手のうち索引にあるのは${rows.length}人でした。比較には2人以上必要です。`
              : (state.reasonJa || "索引がまだ作られていません。"),
          }));
          return;
        }
        const result = playerSearch.comparePlayers(state.rows, rows);
        const body = {
          ok: true, available: true, ...result, missing,
          missingNoteJa: missing.length ? `ID ${missing.join(", ")} は索引に見つからなかったため比較から外しました。` : null,
          indexBuiltAt: state.meta && state.meta.builtAt ? state.meta.builtAt : null,
          tookMs: Date.now() - t0,
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      // クラブ→所属選手(⑥ クラブページ⇄選手ページの相互遷移)
      if (pathname === "/api/knowledge/club-players") {
        const club = (parsed.searchParams.get("club") || "").trim();
        if (!club) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reasonJa: "クラブ名(club)を英語表記で指定してください。" }));
          return;
        }
        const t0 = Date.now();
        const state = await loadPlayerIndex(false);
        const target = CLUB_UNIVERSE.find((c) => c.nameEn.toLowerCase() === club.toLowerCase()
          || (c.nameJa && c.nameJa === club));
        const teamEn = target ? target.nameEn : club;
        const rows = state.rows.filter((r) => r[playerSearch.COL.teamEn] === teamEn);
        const sorted = playerSearch.sortRows(rows, { sort: parsed.searchParams.get("sort") || "rating", order: "desc" });
        const byPosition = {};
        for (const code of playerSearch.BROAD_POSITIONS) {
          const list = sorted.filter((r) => r[playerSearch.COL.position] === code).map(playerSearch.fromIndexRow);
          if (list.length) byPosition[code] = list;
        }
        const unknownPos = sorted.filter((r) => !playerSearch.BROAD_POSITIONS.includes(r[playerSearch.COL.position])).map(playerSearch.fromIndexRow);
        const body = {
          ok: true,
          available: state.rows.length > 0,
          reasonJa: state.rows.length ? null : (state.reasonJa || "索引がまだ作られていません。"),
          club: target ? { teamEn: target.nameEn, teamJa: target.nameJa, country: target.country, leagueId: target.leagueId, rank: target.rank } : { teamEn, teamJa: null },
          count: sorted.length,
          players: sorted.map(playerSearch.fromIndexRow),
          byPosition,
          unknownPosition: unknownPos,
          positionLabelsJa: playerSearch.BROAD_POSITION_JA,
          emptyReasonJa: sorted.length ? null : "このクラブの選手はまだ索引に入っていません(名簿の取得が輪番待ち、またはクラブ名の照合に失敗しています)。",
          indexBuiltAt: state.meta && state.meta.builtAt ? state.meta.builtAt : null,
          tookMs: Date.now() - t0,
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === "/api/knowledge/scouting") {
        // 新規登録・移籍・若手有望株・フォーム急上昇/急下降の検知結果。
        // 実測値の変化からのみ生成される(推測は一切入れない)。
        const cached = cacheGet("kb:scouting");
        if (cached) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(cached));
          return;
        }
        const feed = await clubDossier.getScoutFeed(60);
        const byType = {};
        for (const it of feed.items || []) {
          if (!byType[it.type]) byType[it.type] = [];
          byType[it.type].push(it);
        }
        const body = {
          ok: true, generatedAt: new Date().toISOString(),
          available: feed.available !== false, reasonJa: feed.reasonJa || null,
          counts: Object.fromEntries(Object.keys(byType).map((k) => [k, byType[k].length])),
          byType, items: feed.items || [],
          categoriesJa: {
            new: "新規登録(この選手を初めて記録した)",
            transfer: "移籍(前回の記録と所属クラブが変わった)",
            prospect: "若手有望株(21歳以下・出場450分以上・平均評価6.8以上)",
            formUp: "フォーム急上昇(平均評価が+0.15以上)",
            formDown: "フォーム急下降(平均評価が-0.15以上)",
          },
          notComputedJa: "「怪我からの復帰」は、API-Footballの負傷者リストからの消失で判定できますが、離脱の開始日が提供されないため復帰かどうかを断定できません。断定できない項目は出していません。",
        };
        cacheSet("kb:scouting", body, 5 * 60 * 1000);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
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
          const trend = await getMetricsTrend(learningDeps, 3, appDateKey()).catch(() => null);
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
        const todayDateKey = appDateKey();
        const trend = await getMetricsTrend(learningDeps, days, todayDateKey)
          .catch((e) => ({ available: false, reasonJa: `指標の読み出しに失敗しました(${e.message})。`, days: [] }));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), ...trend }));
        return;
      }
      if (pathname === "/api/learning/daily-report") {
        // 2026年8月・「本当に毎日賢くなるAI」フェーズ(ご指示②)。
        // 「学習しました」ではなく数字で証明するための日次ダッシュボード:
        //   何クラブ・何選手更新したか / 知識の増加・重複・失敗 / API使用数 /
        //   予測件数・答え合わせ件数 / 前日より精度が何%改善したか /
        //   学習で予測がどう変わったか / 特徴量の有効性 / 次に学ぶテーマ。
        // すべて実測の保存値から組み立てる(このエンドポイントは何も推測しない)。
        const drCached = cacheGet("learn:daily-report");
        if (drCached) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(drCached));
          return;
        }
        const todayKey = appDateKey();
        const [growthRaw, accuracyTrend, agenda, intelReport, answerability, selfImproveHistory, coverage, weightsImpact] = await Promise.all([
          learningDeps.upstashGetJSON("learn:growthlog:latest").catch(() => null),
          getAccuracyTrend(learningDeps, todayKey).catch(() => ({ available: false })),
          loadLatestAgenda(learningDeps).catch(() => null),
          // AI知能計測ラウンド(ご指示①〜⑨): 日次学習ジョブが保存した知能レポート
          // (自己評価・エンジン別成長率・知識の寄与ランキング・精度低下の自己分析)
          learningDeps.upstashGetJSON("learn:intel:report:latest").catch(() => null),
          // 成長可視化ラウンド⑥: 「答えられるようになった」実績
          intelligenceMetrics.getAnswerabilitySummary({ upstashEnabled: UPSTASH_ENABLED, upstashCmd }).catch(() => ({ available: false })),
          // 自己改善ループ⑤: この1か月の自己改善履歴
          getSelfImprovementHistory({ upstashEnabled: UPSTASH_ENABLED, upstashCmd }, 30).catch(() => ({ available: false })),
          // 第8次監査(Low)の修正: /api/knowledge/coverage と同じ5分キャッシュを共有し、
          // ホーム画面が両方を叩いたときに全クラブの読み出し(約100コマンド)が
          // 二重に走らないようにする。
          (async () => {
            const covCached = cacheGet("kb:coverage");
            if (covCached) return covCached;
            const summary = await clubDossier.getCoverageSummary().catch(() => null);
            if (summary) cacheSet("kb:coverage", { ok: true, generatedAt: new Date().toISOString(), ...summary }, 5 * 60 * 1000);
            return summary;
          })(),
          // ---- 2026年8月・第三者監査が発見した「書きっぱなし」の解消 ----
          //   learn:weights:impact は「学習で重みを変えた結果、予測がどう変わったか」を
          //   30件ぶん貯めていたのに、**読み出すコードがテスト以外に無かった**。
          //   「本当に賢くなっているのか」を数字で示す中核なので、日次レポートに載せる。
          (async () => {
            const raw = (await upstashCmd(["LRANGE", "learn:weights:impact", "-10", "-1"]).catch(() => [])) || [];
            const items = raw.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean).reverse();
            return items.length
              ? { available: true, items, noteJa: "重みを更新した日に、その更新が過去の実試合の予測をどう変えたかを再計算した記録です(直近10件)。" }
              : { available: false, noteJa: "重みの更新がまだ行われていないため、学習が予測に与えた影響の記録はありません(検証済みの試合が必要件数に達すると始まります)。" };
          })(),
        ]);
        const g = growthRaw || {};
        const body = {
          ok: true,
          generatedAt: new Date().toISOString(),
          date: g.date || todayKey,
          // 学習が実際に予測を変えた記録(実測)
          weightsImpact,
          // 2026年8月・本番確認で判明: 予測カバー率と無駄削減の実測を
          //   日次学習では保存していたのに、このレポートに載せていなかったため
          //   「TOP100に漏れがないか」を利用者が数字で確認できなかった。
          predictionCoverage: g.predictionCoverage || null,
          apiRunMemo: g.apiRunMemo || null,
          // 2026年8月・共同開発者レビュー対応:
          //   過去試合による旧モデル vs 新モデルの多指標比較と、採用/不採用の理由。
          //   「精度が上がったこと」を数字で示すための中核。
          modelTuning: g.modelTuning || null,
          isToday: g.date === todayKey,
          noteJa: g.date
            ? (g.date === todayKey ? "本日の学習実行の実測値です。" : `最新の学習記録は${g.date}のものです(本日分はまだ実行されていません)。`)
            : "学習ジョブの記録がまだありません。",
          // ---- ② 更新量(何クラブ・何選手・何件) ----
          updates: {
            universeClubsUpdated: (g.universe && g.universe.coreClubsUpdated) ?? 0,
            universeClubsPlanned: (g.universe && g.universe.coreClubsPlanned) ?? 0,
            universePlayersUpdated: (g.universe && g.universe.playersUpdated) ?? 0,
            registeredClubsAnalyzed: g.teamsAnalyzed ?? 0,
            leaguesAnalyzed: g.leaguesAnalyzedToday ?? 0,
            playersChecked: g.playersCheckedToday ?? 0,
            knowledgeAdded: g.knowledgeItemsSavedToday ?? 0,
            knowledgeDuplicate: g.knowledgeItemsDuplicateToday ?? 0,
            failures: Array.isArray(g.errors) ? g.errors.length : 0,
            universeSkipped: (g.universe && g.universe.skipped) || [],
            // 本番エラー調査: データ提供元の表記差で照合できなかったクラブ
            unresolvedClubs: (g.universe && g.universe.unresolvedClubs) || [],
            // ---- 2026年8月・全機能監査で判明した開示漏れ ----
            //   収集エラーは件数(failures)だけが出ていて中身が出ていなかったため、
            //   「何が失敗したのか」を画面から一切追えなかった。
            universeErrors: (g.universe && g.universe.errors) || [],
            universeErrorCount: (g.universe && g.universe.errorCount) ?? ((g.universe && g.universe.errors) || []).length,
            universeSquadsUpdated: (g.universe && g.universe.squadsUpdated) ?? null,
            universeXgClubsUpdated: (g.universe && g.universe.xgClubsUpdated) ?? null,
            universeStandingsLeagues: (g.universe && g.universe.standingsLeaguesUpdated) ?? null,
            universePlayersIndexed: (g.universe && g.universe.playersIndexed) ?? null,
            universePlayersFromSquadSync: (g.universe && g.universe.playersFromSquadSync) ?? null,
            universePlayersFromDetailStats: (g.universe && g.universe.playersFromDetailStats) ?? null,
            universeRan: !!(g.universe),
          },
          // ---- ② API使用数 ----
          apiUsage: g.apiBudget ? {
            usedToday: g.apiBudget.totalSpent ?? null,
            dailyBudget: g.apiBudget.dailyBudget ?? null,
            detectedPlan: g.apiBudget.detectedPlan || null,
          } : null,
          // ---- ② 予測件数・答え合わせ件数 ----
          predictions: {
            newToday: g.newPredictionsLogged ?? 0,
            resolvedToday: g.matchesResolvedToday ?? 0,
            scoredToday: g.accuracyScoredToday ?? 0,
            resolvedTotal: g.totalOwnPredictionsResolved ?? 0,
          },
          // ---- ⑨ 精度(的中率・Brier・LogLoss・較正、昨日/先週/先月比較) ----
          accuracy: accuracyTrend,
          // ---- ① 学習で予測がどう変わったか ----
          predictionShift: g.predictionShift || null,
          // ---- ③④ 「昨日の学習が今日の予測に反映された」証明 ----
          learningProof: g.learningProof || null,
          weightsUpdatedToday: !!(g.weightsUpdated || g.weightsUpdatedV2),
          // ---- ⑧ 特徴量の有効性 ----
          featureEffectiveness: g.featureEffectiveness || null,
          // ---- ⑩ AIが自分で決めた学習テーマと、今日実際に反映した内容 ----
          learningAgenda: agenda || g.learningAgenda || null,
          agendaAppliedToday: g.agendaAppliedToday || null,
          // ---- ⑤ 信頼度の凡例(どの出所を何点とし、何時間で半減するか) ----
          trustLegend: {
            sources: Object.entries(SOURCE_TRUST).map(([k, v]) => ({ source: k, base: v.base, labelJa: v.labelJa })),
            halfLifeHours: HALF_LIFE_HOURS,
            noteJa: "信頼度 = 出所の基礎点 × 鮮度(半減期方式)。古い情報ほど自動的に評価が下がり、信頼度の高いデータほど重み学習に強く反映されます。",
          },
          // ---- 知識蓄積の実数(TOP100) ----
          knowledgeCoverage: coverage && coverage.available ? {
            clubCount: coverage.clubCount, playerCount: coverage.playerCount,
            staleClubs: coverage.staleClubs,
          } : null,
          // ---- 最終方針「使用回数まで管理」: 実際によく使われている知識の上位 ----
          // (使用回数は応答速度を守るためメモリ集計→日次保存の近似値)
          topUsedKnowledge: await knowledgeStore.getTopUsedKnowledge(5).catch(() => []),
          // ---- AI知能計測ラウンド(ご指示①〜⑨) ----
          // AI自身の毎日の自己評価「今日のAIは昨日より賢くなったか?」、
          // エンジン別成長率、Knowledgeの寄与ランキング、精度低下の自己分析、
          // 考察の質・RAG使用率の推移。すべて日次学習ジョブ保存の実測値。
          intelligence: intelReport || null,
          // ---- 成長可視化ラウンド ----
          // ① 今日なにを覚えたか(カテゴリ別の採用/重複除外の内訳)
          knowledgeByCategoryToday: g.knowledgeByCategoryToday || null,
          // ② 学習品質パネル(取得検討・採用・重複除外・鮮度切れ・エラー・API成功率)
          learningQuality: {
            consideredToday: (g.knowledgeItemsSavedToday ?? 0) + (g.knowledgeItemsDuplicateToday ?? 0),
            adoptedToday: g.knowledgeItemsSavedToday ?? 0,
            duplicatesExcludedToday: g.knowledgeItemsDuplicateToday ?? 0,
            staleExcludedTotal: g.knowledgeStaleTotal ?? null,
            errorsToday: Array.isArray(g.errors) ? g.errors.length : 0,
            apiCalls: apiCallStatsSnapshot(),
            noteJa: "取得検討=採用+重複除外。鮮度切れは失効して根拠から自動除外されている知識の累計。API成功率はサーバー起動からの実測。",
          },
          // ⑥ 「以前は答えられなかった質問に、今は答えられる」実績
          answerability: answerability && answerability.available ? answerability : null,
          // ---- 自己改善ループ⑤: 「この1か月でAIが何を改善してきたか」 ----
          // (本日のループの中身は intelligence.selfImprovement に入っている)
          selfImprovementHistory: selfImproveHistory && selfImproveHistory.available ? selfImproveHistory : null,
        };
        cacheSet("learn:daily-report", body, 5 * 60 * 1000);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
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
        // 第8次監査(Medium)の修正: この診断は1回で数百のRedis読み出し+LLMの実呼び出し
        // (実費)を伴うため、5分キャッシュする(壊れた状態の診断が5分遅れるより、
        // ページを開くたびに実費と数百コマンドが発生する方が害が大きい)。
        const dbgCached = cacheGet("debug:status");
        if (dbgCached) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ...dbgCached, cachedNoteJa: "5分キャッシュされた診断結果です。" }));
          return;
        }
        const { status, body } = await handleDebugStatus();
        if (status === 200) cacheSet("debug:status", body, 5 * 60 * 1000);
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

/**
 * ---- テスト専用のフック(本番の動作には一切影響しない) ----
 * 2026年8月・「正答率が更新されない」調査への対応で追加。
 *
 * なぜ必要か: この調査で見つかった欠陥(保留キューの先頭詰まり・
 * 一時的なUpstash障害での恒久的な取りこぼし・予測データが無い試合による
 * 枠の食い潰し)は、いずれも **「Redisの中身が実行後どう変わるか」でしか
 * 検証できない**。過去に「index.htmlに文字列が含まれるか」だけを見る
 * テストが、例外を投げるコードを合格させてしまった反省から、
 * 依存(Upstash / API-Football)を差し替えて実際にハンドラを動かせるようにする。
 * 本番では誰も呼ばないため、挙動は変わらない。
 */
function __setTestHooks(hooks) {
  if (!hooks) return;
  if (hooks.upstashCmd) upstashCmd = hooks.upstashCmd;
  if (hooks.upstashGetJSON) upstashGetJSON = hooks.upstashGetJSON;
  if (hooks.upstashSetJSON) upstashSetJSON = hooks.upstashSetJSON;
  if (hooks.callApiFootball) callApiFootball = hooks.callApiFootball;
  if (hooks.handleFixturesToday) handleFixturesToday = hooks.handleFixturesToday;
  // 自己修復のテストで「学習が始まったか」だけを見たいときに差し替える
  if (hooks.runDailyLearning) runDailyLearning = hooks.runDailyLearning;
}

module.exports = {
  server,
  __setTestHooks,
  handlePlayerSeasonStats,
  handleFixturesToday,
  handleFixtureAnalysis,
  handlePredictionsToday, buildTodayPredictionEntry, selectUpcomingPredictionRecords, // 利用者目線ラウンド: 今日のAI予想
  prioritizeFixturesForDisplay, // 利用者目線ラウンド: 表示上限の優先順位つき適用(テスト対象)
  handleBackupExport, // 精度証明ラウンド④: 学習状態の週次バックアップ
  handleCoachSearch,
  handleAccuracyStats,
  handleAutoCollectPredictions,
  handleDailyDiff, rebuildPlayerIndexNow,
  __clearCache: () => cache.clear(),   // テストで時間依存のキャッシュを跨ぐため
  handlePredictMatch,
  perfSnapshot, // 最終方針: 性能の常時計測(テスト・負荷試験から参照)
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
  getApiBudget, // 監査・検証用に公開(予算の実消費を外から確認できるようにする)
  getApiPlanInfo,
  recordRateLimitHeaders,
  handleTeamViewHistory,
  handleMatchAnalysis,
  learningDeps,
  knowledgeStore,
  memoryStore,
  relationshipIndex,
  // 2026年8月・優先順位⑲/⑳
  knowledgeGraph,
  thoughtTimeline,
  clubDossier,
  clubProfileEngine,
  playerProfileEngine,
};
