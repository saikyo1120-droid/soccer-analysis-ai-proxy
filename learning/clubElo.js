/**
 * server/learning/clubElo.js
 * ------------------------------------------------
 * 2026年8月19日・v57「クラブElo特徴量」(利用者のご要望①)。
 *
 * ■ 何か
 *   clubelo.com は無料・無認証の独立系クラブEloレーティングAPI。
 *   自前のDixon-Coles地力(v50)とは独立に計算された「第二の意見」を
 *   特徴量 clubEloDiff として予測モデルへ渡す(重みは実データで学習・初期0)。
 *
 * ■ 取得の設計(先方への礼儀と自分の予算)
 *   ・日次: api.clubelo.com/YYYY-MM-DD を1日1回だけ(全クラブぶんが1回で返る)。
 *     結果は learn:clubelo:daily に保存し、同日中は再取得しない。
 *   ・過去照合(バックフィル): チーム別の履歴CSVを一度だけ取得(約190回・
 *     150ms間隔で間引き)。learn:clubelo:hist に保存し、以後は再取得しない。
 *     これで保存済みの過去試合(約1.2万件)にEloの差を付与でき、
 *     重みを初日からホールドアウト検証つきで学習できる。
 *   ・失敗はすべて「Eloなし=特徴量0」に倒す(推測で埋めない)。
 *
 * ■ 名前照合の正直な扱い
 *   ClubEloは短い表記(Man City / Paris SG など)を使う。照合は正規化+
 *   別名表+トークン包含で行い、**候補が2件以上の曖昧な名前は使わない**。
 *   照合できなかったクラブは件数として記録する(黙って捨てない)。
 */

const { normName, namesMatch } = require("./oddsApi");
const http = require("http");
const https = require("https");

const DAILY_KEY = "learn:clubelo:daily";   // { date, list: [[club, country, elo], ...] }
const HIST_KEY = "learn:clubelo:hist";     // { builtAt, byTeamId: { id: [[fromMs, elo], ...] } }
const HIST_LOCK_KEY = "learn:clubelo:hist:lock";
const THROTTLE_MS = 150;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** ClubEloのCSV(Rank,Club,Country,Level,Elo,From,To)を解析する */
function parseCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const iClub = header.indexOf("club"), iCountry = header.indexOf("country"),
    iElo = header.indexOf("elo"), iFrom = header.indexOf("from"), iTo = header.indexOf("to");
  if (iClub < 0 || iElo < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const elo = Number(c[iElo]);
    if (!c[iClub] || !Number.isFinite(elo)) continue;
    out.push({
      club: c[iClub].trim(),
      country: iCountry >= 0 ? (c[iCountry] || "").trim() : null,
      elo: Math.round(elo * 10) / 10,
      from: iFrom >= 0 ? (c[iFrom] || "").trim() : null,
      to: iTo >= 0 ? (c[iTo] || "").trim() : null,
    });
  }
  return out;
}

/**
 * v73(2026年8月29日・利用者の承認): 依存ゼロのまま接続を強化する自前トランスポート。
 *
 * 背景(利用者経由で受けた指摘は正しかった):
 *   Node組み込みfetch(undici)の接続確立タイムアウト(既定約10秒)は
 *   AbortSignalでは延長できない。ただし解決に npm パッケージ(undici)は不要で、
 *   Node標準の https.request なら接続〜応答全体を1つのタイマーで制御でき、
 *   ECONNREFUSED / ETIMEDOUT / ENOTFOUND 等の生のエラーコードが直接取れる
 *   (これまで謎だった「http:23」のような包まれたコードも、次の失敗から正体が残る)。
 *   このプロジェクトの土台「依存パッケージゼロ(GitHub画面のドラッグだけで更新可能)」を
 *   壊さないため、undici導入案は採らずこの実装にした。
 */
const DEFAULT_TIMEOUT_MS = 15000;
const USER_AGENT = "soccer-analysis-ai/1.0 (daily learning job)";

function httpGetRaw(url, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code, msg) => {
      if (settled) return; settled = true;
      const e = new Error(msg || String(code));
      e.code = String(code);
      e.elapsedMs = Date.now() - startedAt;
      reject(e);
    };
    const go = (u, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return fail("BAD_URL", String(u).slice(0, 60)); }
      const mod = parsed.protocol === "http:" ? http : https;
      let req;
      try {
        req = mod.request(parsed, { method: "GET", headers: { "User-Agent": o.userAgent || USER_AGENT, Accept: "text/csv,text/plain,*/*" } }, (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume(); // 本文は読み捨てて転送先へ(clubeloはhttp→httpsの転送があり得る)
            return go(new URL(res.headers.location, parsed).toString(), redirectsLeft - 1);
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            if (settled) return; settled = true;
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ ok: status >= 200 && status < 300, status, elapsedMs: Date.now() - startedAt, text: async () => body });
          });
          res.on("error", (e) => fail(e.code || "RES_ERROR", e.message));
        });
      } catch (e) { return fail(e.code || "REQ_BUILD_ERROR", e.message); }
      // 接続確立を含む全体のタイムアウト(undiciと違い自由に延長できる)
      req.setTimeout(timeoutMs, () => {
        req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: `TIMEOUT_${timeoutMs}MS` }));
      });
      req.on("error", (e) => fail(e.code || e.errno || "REQ_ERROR", e.message));
      req.end();
    };
    go(url, 3);
  });
}

/** 注入が無いときに使う既定の取得関数(fetch互換の最小形: ok/status/text) */
function defaultFetchFn(url, opts) {
  return httpGetRaw(url, { timeoutMs: (opts && opts.__timeoutMs) || DEFAULT_TIMEOUT_MS });
}

/** e.cause を掘って一番具体的なコードを返す(undici形・生エラー形の両対応) */
function causeOf(e) {
  const parts = [];
  let cur = e;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = cur.code || cur.errno || null;
    const msg = String(cur.message || "").slice(0, 40);
    if (code) parts.push(String(code));
    else if (msg && msg !== "fetch failed") parts.push(msg);
    cur = cur.cause;
  }
  return parts.length ? parts.join("<") : String((e && e.message) || e).slice(0, 24);
}

/** 試行ログを人が読める1行へ(例: r1 https:TIMEOUT_12000MS@12005ms/r1 http:ECONNREFUSED@230ms) */
function summarizeAttempts(attempts) {
  return (attempts || []).map((a) => `r${a.round} ${a.scheme}:${a.code}@${a.ms}ms`).join("/");
}

/**
 * v60: https と http の両方を試す(どちらで失敗したかを理由として残す)。
 * v73: ラウンド制のリトライ(既定1ラウンド=従来どおり)と試行ごとの
 *      {ラウンド, 方式, コード, 所要ms} の記録を追加。
 *      リトライを使うのは日次一覧(1日1リクエスト)だけ。クラブ別の履歴取得は
 *      従来どおり1ラウンド+v69遮断器(62分事件を再発させない)。
 */
async function fetchWithScheme(fetchFn, path, retryOpts) {
  const o = retryOpts || {};
  const rounds = Math.max(1, Number(o.rounds) || 1);
  const timeouts = Array.isArray(o.timeoutsMs) && o.timeoutsMs.length ? o.timeoutsMs : [DEFAULT_TIMEOUT_MS];
  const backoffs = Array.isArray(o.backoffMs) ? o.backoffMs : [2000, 8000];
  const doFetch = fetchFn || defaultFetchFn;
  const attempts = [];
  for (let r = 1; r <= rounds; r++) {
    if (r > 1) await sleep(backoffs[Math.min(r - 2, backoffs.length - 1)] || 0);
    const t = timeouts[Math.min(r - 1, timeouts.length - 1)];
    const opts = { headers: { "User-Agent": USER_AGENT }, __timeoutMs: t };
    try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) opts.signal = AbortSignal.timeout(t); } catch (e) { /* 古い実行環境では無しで続行 */ }
    for (const scheme of ["https", "http"]) {
      const t0 = Date.now();
      try {
        const res = await doFetch(`${scheme}://api.clubelo.com/${path}`, opts);
        const ms = res && Number.isFinite(res.elapsedMs) ? res.elapsedMs : Date.now() - t0;
        if (res && res.ok) {
          attempts.push({ round: r, scheme, code: "OK", status: res.status || 200, ms });
          res.__attempts = attempts;
          return res;
        }
        attempts.push({ round: r, scheme, code: `HTTP_${res ? res.status : "no_response"}`, ms });
      } catch (e) {
        const ms = Number.isFinite(e && e.elapsedMs) ? e.elapsedMs : Date.now() - t0;
        attempts.push({ round: r, scheme, code: causeOf(e), ms });
      }
    }
  }
  // 旧形式(https:コード/http:コード)も先頭に残す(既存の監視・表示との互換のため)
  const legacy = attempts.slice(0, 2).map((a) => `${a.scheme}:${a.code}`).join("/");
  const err = new Error(rounds > 1 ? `${legacy} | ${summarizeAttempts(attempts)}` : legacy);
  err.allSchemesFailed = true;
  err.attempts = attempts;
  throw err;
}

/**
 * その日の全クラブEloを返す(1日1回だけ実取得。同日ぶんは保存を再利用)。
 * @returns { date, rows, fetchedFresh, staleDays, error } rowsは[]の可能性あり
 */
async function getDailyElo(deps, runAt) {
  const { fetchFn, upstashGetJSON, upstashSetJSON } = deps;
  const dateStr = new Date(runAt).toISOString().slice(0, 10);
  const saved = upstashGetJSON ? await upstashGetJSON(DAILY_KEY).catch(() => null) : null;
  if (saved && saved.date === dateStr && Array.isArray(saved.list)) {
    return { date: dateStr, rows: saved.list.map(([club, country, elo]) => ({ club, country, elo })), fetchedFresh: false, staleDays: 0, error: null };
  }
  // v73: 日次一覧は1日1リクエストだけの大事な取得なので、ここだけ多段リトライで粘る。
  //   本番実測(8/27にデータ取得成功→以後失敗)から「先方が時々しか応答しない」状態が
  //   濃厚で、リトライが効く見込みが高い。最悪でも合計約2.5分で諦める(62分事件とは
  //   桁が違う)。クラブ別の履歴取得はこのリトライを使わない(v69遮断器を維持)。
  const retryPlan = deps.dailyRetryPlan || { rounds: 3, timeoutsMs: [12000, 30000, 30000], backoffMs: [2000, 8000] };
  try {
    const res = await fetchWithScheme(fetchFn, dateStr, retryPlan);
    if (!res || !res.ok) throw new Error(`http_${res ? res.status : "no_response"}`);
    const rows = parseCsv(await res.text());
    if (rows.length) {
      if (upstashSetJSON) await upstashSetJSON(DAILY_KEY, { date: dateStr, list: rows.map((r) => [r.club, r.country, r.elo]) }).catch(() => {});
      return { date: dateStr, rows, fetchedFresh: true, staleDays: 0, error: null, attempts: res.__attempts || null };
    }
    throw new Error("empty_csv");
  } catch (e) {
    const attempts = (e && e.attempts) || null;
    // 今日ぶんが取れない日は、7日以内の保存があればそれを使う(正直にstaleDaysを返す)
    if (saved && Array.isArray(saved.list) && saved.date) {
      const staleDays = Math.round((Date.parse(dateStr) - Date.parse(saved.date)) / 86400000);
      if (staleDays >= 0 && staleDays <= 7) {
        return { date: saved.date, rows: saved.list.map(([club, country, elo]) => ({ club, country, elo })), fetchedFresh: false, staleDays, error: String(e.message || e).slice(0, 300), attempts };
      }
    }
    return { date: dateStr, rows: [], fetchedFresh: false, staleDays: null, error: String(e.message || e).slice(0, 300), attempts };
  }
}

/**
 * その日のElo行を「正規化名 → {elo, club}」に変換する。
 * 正規化後に同名が2件以上ある場合は両方捨てる(誤マッチ防止)。
 */
function buildEloByNorm(rows) {
  const counts = new Map();
  for (const r of rows) {
    const k = normName(r.club);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const map = new Map();
  for (const r of rows) {
    const k = normName(r.club);
    if (counts.get(k) === 1) map.set(k, { elo: r.elo, club: r.club });
  }
  return map;
}

/**
 * うちのチーム名から、その日のEloを引く。
 * 完全一致(正規化)を最優先し、無ければトークン照合(候補1件のときだけ)。
 */
function eloForTeamName(eloByNorm, rows, teamName) {
  if (!teamName) return null;
  const direct = eloByNorm.get(normName(teamName));
  if (direct) return direct.elo;
  const hits = [];
  for (const r of rows) {
    if (namesMatch(r.club, teamName)) hits.push(r);
    if (hits.length > 2) break;
  }
  return hits.length === 1 ? hits[0].elo : null; // 0件・2件以上は正直に「無し」
}

/**
 * チーム別の過去Elo履歴を一度だけ取得して保存する(バックフィル)。
 * @param teams [{ id, name }](ratings.namesById などから)
 * @param sinceMs これより古い区間は保存しない(データセットの範囲だけで十分)
 * @returns { ran, fetched, matchedTeams, failures, savedBytes, reasonJa }
 */
async function backfillHistory(deps, teams, sinceMs, runAt) {
  const { fetchFn, upstashCmd, upstashGetJSON, upstashSetJSON } = deps;
  if (!upstashSetJSON || !upstashCmd) return { ran: false, reasonJa: "保存先(Upstash)が未設定のため見送りました。" };
  const existing = await upstashGetJSON(HIST_KEY).catch(() => null);
  if (existing && existing.byTeamId && Object.keys(existing.byTeamId).length > 0) {
    return { ran: false, alreadyDone: true, teams: Object.keys(existing.byTeamId).length, reasonJa: "取得済みのため再取得しません(一度きりの設計)。" };
  }
  // 二重実行の防止(日次ジョブが多重に走った場合の保護)
  const lock = await upstashCmd(["SET", HIST_LOCK_KEY, "1", "NX", "EX", "3600"]).catch(() => null);
  if (lock !== "OK") return { ran: false, reasonJa: "別の実行が取得中のため見送りました(1時間ロック)。" };

  // その日の一覧から「うちのチーム名 → ClubElo名」を先に決める(URLは ClubElo名から作る)
  const daily = await getDailyElo(deps, runAt);
  if (!daily.rows.length) return { ran: false, reasonJa: `ClubEloの一覧を取得できませんでした(${daily.error || "理由不明"})。` };
  const eloByNorm = buildEloByNorm(daily.rows);
  const byTeamId = {};
  const failures = [];
  let fetched = 0;
  let consecutiveConnFails = 0; // v69: 接続レベルの連続失敗(3でホスト障害と判断して中断)
  let abortedForHostDown = false;
  for (const t of teams) {
    if (!t || !Number.isFinite(Number(t.id)) || !t.name) continue;
    // ClubElo側の正式名を特定(曖昧なら見送り=正直)
    let clubEloName = null;
    const direct = eloByNorm.get(normName(t.name));
    if (direct) clubEloName = direct.club;
    else {
      const hits = daily.rows.filter((r) => namesMatch(r.club, t.name));
      if (hits.length === 1) clubEloName = hits[0].club;
    }
    if (!clubEloName) { failures.push(`unmatched:${t.name}`); continue; }
    // ---- v69: 連続失敗ブレーカー(本番実測での欠陥への修正) ----
    //   ホストが無応答の日にクラブごとに約30秒(https10s+http15s+再試行)を
    //   費やし、朝の学習が62分(通常12〜17分)へ膨らんだ。接続レベルの失敗が
    //   3クラブ連続したら「ホスト自体が落ちている」と判断して中断する
    //   (1クラブだけの個別失敗と、ホスト全体の障害を区別する)。
    if (consecutiveConnFails >= 3) {
      abortedForHostDown = true;
      break;
    }
    try {
      // v60: 日次取得と同じく https → http の順で試す
      const res = await fetchWithScheme(fetchFn, encodeURIComponent(clubEloName.replace(/\s+/g, "")));
      if (!res || !res.ok) throw new Error(`http_${res ? res.status : "no_response"}`);
      const hist = parseCsv(await res.text());
      const intervals = [];
      for (const h of hist) {
        const fromMs = h.from ? Date.parse(h.from) : NaN;
        if (!Number.isFinite(fromMs)) continue;
        if (Number.isFinite(sinceMs) && fromMs < sinceMs) {
          // 範囲より古い区間は、直近1件だけ「開始時点のElo」として残す
          if (!intervals.length || intervals[0][0] < fromMs) intervals[0] = [fromMs, Math.round(h.elo)];
          continue;
        }
        intervals.push([fromMs, Math.round(h.elo)]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      if (intervals.length) { byTeamId[t.id] = intervals; fetched++; }
      else failures.push(`empty:${t.name}`);
      consecutiveConnFails = 0; // 応答があった=ホストは生きている(連続失敗を数え直す)
    } catch (e) {
      failures.push(`fetch_failed:${t.name}:${String(e.message || e).slice(0, 30)}`);
      consecutiveConnFails++;
    }
    await sleep(THROTTLE_MS); // 無料APIへの礼儀(集中アクセスしない)
  }
  const payload = { builtAt: new Date(runAt).toISOString(), byTeamId };
  // v69: 1件も取れずホスト障害で中断した場合は、空の履歴を保存しない
  //   (空を保存すると「取得済み」と誤判定され、回復後に永久に再試行されない)。
  if (abortedForHostDown && fetched === 0) {
    await upstashCmd(["DEL", HIST_LOCK_KEY]).catch(() => {}); // 回復後すぐ試せるようロックも返す
    return {
      ran: true, fetched: 0, matchedTeams: 0, abortedForHostDown: true,
      failures: failures.slice(0, 8), failureCount: failures.length,
      saved: false,
      reasonJa: "接続レベルの失敗が3クラブ連続したため、ホスト障害と判断して中断しました(回復した日に自動で再試行します)。",
    };
  }
  const savedOk = await upstashSetJSON(HIST_KEY, payload).catch(() => false);
  return {
    ran: true, fetched, matchedTeams: Object.keys(byTeamId).length,
    abortedForHostDown,
    failures: failures.slice(0, 8), failureCount: failures.length,
    saved: savedOk !== false,
    reasonJa: savedOk === false ? "履歴の保存に失敗しました(サイズ超過の可能性)。"
      : (abortedForHostDown ? "途中から接続できなくなったため、取得できた分だけ保存して中断しました。" : null),
  };
}

/** 履歴からその日付時点のEloを引く(その日以前の最後の区間) */
function eloAt(intervals, dateMs) {
  if (!Array.isArray(intervals) || !intervals.length || !Number.isFinite(dateMs)) return null;
  let best = null;
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i][0] <= dateMs) best = intervals[i][1];
    else break;
  }
  return best;
}

/** 保存済み履歴から lookup(teamId, dateMs) を作る(無ければnullを返すlookup) */
function makeHistoryLookup(hist) {
  const byTeamId = (hist && hist.byTeamId) || {};
  return (teamId, dateMs) => eloAt(byTeamId[teamId], dateMs);
}

/**
 * v73: 診断用の単発プローブ(/api/diag/clubelo から呼ばれる)。
 * その場で https/http を1回ずつ短いタイムアウトで叩き、試行ごとの
 * {方式, コード, 所要ms} を返す。保存は一切しない(診断は読み取り専用)。
 * 呼び出し側(server.js)が10分キャッシュするため、外から連打されても
 * 実際の接続試行は10分に1回に抑えられる。
 */
async function probeDaily(deps) {
  const d = deps || {};
  const dateStr = new Date(d.nowMs || Date.now()).toISOString().slice(0, 10);
  const out = { at: new Date(d.nowMs || Date.now()).toISOString(), target: `api.clubelo.com/${dateStr}`, ok: false, rowCount: null, attempts: [] };
  try {
    const res = await fetchWithScheme(d.fetchFn, dateStr, { rounds: 1, timeoutsMs: [Number.isFinite(d.timeoutMs) ? d.timeoutMs : 6000] });
    out.attempts = res.__attempts || [];
    const rows = parseCsv(await res.text());
    out.ok = rows.length > 0;
    out.rowCount = rows.length;
    out.sample = rows.slice(0, 3).map((r) => r.club);
    if (!rows.length) out.noteJa = "接続はできましたが、CSVとして解釈できる行がありませんでした。";
  } catch (e) {
    out.attempts = (e && e.attempts) || [];
    out.errorJa = "接続できませんでした(試行ごとのコードと所要msを参照)。";
  }
  return out;
}

module.exports = {
  DAILY_KEY, HIST_KEY, HIST_LOCK_KEY,
  parseCsv, getDailyElo, buildEloByNorm, eloForTeamName,
  backfillHistory, eloAt, makeHistoryLookup,
  httpGetRaw, defaultFetchFn, fetchWithScheme, summarizeAttempts, probeDaily,
};
