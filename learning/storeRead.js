/**
 * server/learning/storeRead.js
 * ------------------------------------------------
 * v97(2026年10月・全体監査): 保存先(Upstash)から「複数キーをまとめて・正直に」読むための共通部品。
 *
 * なぜ必要か:
 *   9月に Upstash 無料枠(月50万コマンド)が枯渇した原因の一つが、「N日ぶん・N件ぶんを
 *   1件ずつ GET する」コードが各所に散らばっていたこと(1件=1コマンド)。
 *   MGET なら往復1回で済み、各モジュールで同じ書き方を繰り返す必要も無くなる。
 *
 * もう一つの目的は「読めなかった」と「無かった」の区別。
 *   upstashGetJSON は失敗を null に潰すため、呼び出し側は停止中に「記録なし」と誤表示していた
 *   (9/25〜30 の実例)。ここでは失敗を readFailures / readFailed として必ず返す。
 *
 * 使い方:
 *   const { values, readFailed } = await readManyJSON(deps, keys);
 *   values は keys と同じ長さ(無かった要素は null)。readFailed が true のとき values は信用しない。
 *
 * 互換性:
 *   MGET に対応しない保存先(テストのモックなど。応答が配列でない/例外を投げる)では、
 *   1件ずつの GET に落ちる(結果は同じ。readMode:"per-key" として残す)。
 */

function parseStored(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v; // 既に展開済みの応答にも耐える
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function readManyJSON(deps, keys, { chunk = 100 } = {}) {
  const { upstashCmd, upstashGetJSON } = deps || {};
  const list = (keys || []).filter(Boolean);
  if (!list.length) return { values: [], readMode: "none", readFailures: 0, readFailed: false };
  const values = new Array(list.length).fill(null);
  let readFailures = 0;
  let mgetUnsupported = false;
  let firstError = null;
  if (typeof upstashCmd === "function") {
    for (let i = 0; i < list.length; i += chunk) {
      const part = list.slice(i, i + chunk);
      let raw;
      try {
        raw = await upstashCmd(["MGET", ...part]);
      } catch (e) {
        // MGET そのものが失敗 = 保存先が読めない。1件ずつ読み直しても同じ失敗を重ねるだけなので
        // この塊は「読めなかった」として数える(全体が失敗なら readFailed:true)。
        // ただし "unimplemented"/"does not implement" を名乗るモックは「非対応」として1件ずつへ落とす。
        const msg = String((e && e.message) || e);
        if (/unimplemented|not implement|unknown command|ERR unknown/i.test(msg)) { mgetUnsupported = true; break; }
        readFailures += part.length;
        if (!firstError) firstError = msg.slice(0, 160);
        continue;
      }
      if (!Array.isArray(raw) || raw.length !== part.length) { mgetUnsupported = true; break; }
      raw.forEach((v, j) => { values[i + j] = parseStored(v); });
    }
    if (!mgetUnsupported) {
      return {
        values, readMode: "mget", readFailures,
        readFailed: readFailures >= list.length,
        partial: readFailures > 0 && readFailures < list.length,
        firstError,
      };
    }
  }
  // ---- 1件ずつ(MGET 非対応の保存先) ----
  readFailures = 0;
  for (let i = 0; i < list.length; i++) {
    if (typeof upstashCmd === "function") {
      try { values[i] = parseStored(await upstashCmd(["GET", list[i]])); }
      catch (e) { readFailures++; values[i] = null; if (!firstError) firstError = String((e && e.message) || e).slice(0, 160); }
    } else if (typeof upstashGetJSON === "function") {
      values[i] = await upstashGetJSON(list[i]).catch(() => { readFailures++; return null; });
    } else {
      values[i] = null;
    }
  }
  return {
    values, readMode: "per-key", readFailures,
    readFailed: readFailures >= list.length,
    partial: readFailures > 0 && readFailures < list.length,
    firstError,
  };
}

/** 日付キー(YYYY-MM-DD)を今日から n 日ぶん、新しい順に作る(UTC基準の文字列演算) */
function dateKeysBack(todayDateKey, n) {
  const base = new Date(`${todayDateKey}T00:00:00Z`).getTime();
  const out = [];
  for (let i = 0; i < n; i++) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}

module.exports = { readManyJSON, dateKeysBack, parseStored };
