/**
 * server/learning/duelLeaderboard.js
 * ------------------------------------------------
 * 2026年8月18日・v54「対決の全国ランキング(AI撃破数)」(利用者の選択)。
 *
 * ■ 仕組み
 *   ・参加は任意。端末内の匿名ID(playerId)+ニックネームだけで、アカウント不要。
 *   ・予想(ピック)は**キックオフ前にサーバーへ登録した分だけ**が集計対象。
 *     結果を見てから登録する「後出し」は構造的に不可能(サーバー時刻で判定)。
 *   ・採点は毎日の答え合わせ(dailyJob)の中でサーバーが行う。
 *     AI撃破 = その試合で「自分は的中・AIは外れ」。
 *   ・ランキングはAI撃破数の多い順(通算と月間)。
 *
 * ■ でっち上げ・不正への態度(正直な限界も明記)
 *   ・後出し登録は不可能(上記)。
 *   ・複数端末で複数IDを作ること自体は防げない(アカウントが無いため)。
 *     ランキングは「遊び」であり、その限界はREADMEと画面の注記で開示する。
 *   ・ニックネームは無害化(HTML除去・長さ制限・NGワード)して保存し、
 *     表示時にもエスケープする(二重防御)。
 *
 * ■ Upstashコマンド予算(無料枠1万/日)への配慮
 *   ・ピック登録: 3コマンド/件(HLEN+HSET+EXPIRE)。IP別に1日60件まで(server.js側)。
 *   ・採点: 解決した試合ごとにHGETALL+DEL+参加者数×約3。
 *   ・ランキング表示: TOP20を5分キャッシュ。自分の順位は2コマンド/回。
 */

const PICKS_KEY_PREFIX = "duel:picks:";          // duel:picks:<fixtureId> = HASH playerId -> JSON
const PLAYER_KEY_PREFIX = "duel:player:";        // duel:player:<playerId> = JSON 集計
const LB_ALLTIME_KEY = "duel:lb:alltime";        // ZSET score=AI撃破数
const LB_MONTH_PREFIX = "duel:lb:month:";        // duel:lb:month:<YYYY-MM>(JST) score=AI撃破数
const PICKS_TTL_SEC = 21 * 86400;                // 中止試合等で採点されなかったピックの掃除
const MAX_PICKS_PER_FIXTURE = 500;               // 1試合あたりの参加上限(枠の保護)
const NICKNAME_MAX = 12;
const PLAYER_ID_RE = /^[a-z0-9][a-z0-9-]{7,39}$/;
const VALID_PICKS = new Set(["home", "draw", "away"]);

// 最低限のNGワード(完全なフィルタは不可能。表示エスケープと併せた多層防御)
const NG_WORDS = [
  /死ね|殺す|きもい|キモい|うんこ|ちんこ|まんこ|くたばれ/,
  /fuck|shit|bitch|cunt|nigg|faggot/i,
  /https?:\/\//i, // URLの持ち込み(スパム)禁止
];

/** ニックネームの無害化。使えない場合はnull(呼び出し側が既定名にする)。 */
function sanitizeNickname(raw) {
  let s = String(raw || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "") // 制御文字の除去(明示エスケープ表記)
    .trim();
  s = s.replace(/\s+/g, " ");
  if (!s) return null;
  if ([...s].length > NICKNAME_MAX) s = [...s].slice(0, NICKNAME_MAX).join("");
  for (const re of NG_WORDS) { if (re.test(s)) return null; }
  return s;
}

function monthKeyJst(nowMs) {
  const d = new Date(nowMs + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * ピック登録の検証(純関数)。record=learn:ownpred:<fixtureId>(無ければnull)。
 * @returns {{ ok:true } | { ok:false, reason, messageJa }}
 */
function validatePick({ playerId, nickname, fixtureId, pick, record, nowMs }) {
  if (!PLAYER_ID_RE.test(String(playerId || ""))) {
    return { ok: false, reason: "bad_player", messageJa: "参加IDの形式が不正です(ページを再読み込みして、もう一度参加登録してください)。" };
  }
  if (!VALID_PICKS.has(pick)) {
    return { ok: false, reason: "bad_pick", messageJa: "予想はホーム勝ち・引き分け・アウェイ勝ちのどれかです。" };
  }
  if (!/^\d{1,12}$/.test(String(fixtureId || ""))) {
    return { ok: false, reason: "bad_fixture", messageJa: "試合IDが不正です。" };
  }
  if (!record) {
    return { ok: false, reason: "unknown_fixture", messageJa: "この試合はAIの予想対象ではないため、対決の対象外です。" };
  }
  if (record.resolved === true) {
    return { ok: false, reason: "already_resolved", messageJa: "この試合はすでに結果が出ているため、登録できません(後出しは不正防止のためできません)。" };
  }
  const ko = record.kickoff ? Date.parse(record.kickoff) : NaN;
  if (!Number.isFinite(ko)) {
    return { ok: false, reason: "no_kickoff", messageJa: "この試合の開始時刻が不明なため、登録できません。" };
  }
  if (nowMs >= ko - 60 * 1000) {
    return { ok: false, reason: "fixture_started", messageJa: "キックオフ直前・開始後は登録できません(後出し防止のため、締切は開始1分前です)。" };
  }
  if (sanitizeNickname(nickname) === null) {
    return { ok: false, reason: "bad_nickname", messageJa: "そのニックネームは使えません(12文字以内・URLや不適切な言葉は不可)。" };
  }
  return { ok: true };
}

/**
 * ピックを保存する(検証済み前提)。上限超過は正直に断る。
 */
async function storePick(deps, { playerId, nickname, fixtureId, pick, nowMs }) {
  const { upstashCmd } = deps;
  const key = `${PICKS_KEY_PREFIX}${fixtureId}`;
  const count = await upstashCmd(["HLEN", key]).catch(() => null);
  if (Number(count) >= MAX_PICKS_PER_FIXTURE) {
    return { ok: false, reason: "fixture_full", messageJa: `この試合の参加が上限(${MAX_PICKS_PER_FIXTURE}人)に達しました。` };
  }
  const val = JSON.stringify({ p: pick, n: sanitizeNickname(nickname), at: new Date(nowMs).toISOString() });
  await upstashCmd(["HSET", key, String(playerId), val]);
  await upstashCmd(["EXPIRE", key, String(PICKS_TTL_SEC)]).catch(() => {});
  return { ok: true, closesAtNote: "締切: キックオフ1分前(それまで何度でも変更できます)" };
}

/**
 * 1試合の対決を採点する(dailyJobの答え合わせ直後に呼ぶ)。
 * 冪等性: 採点後にピックのHASHをDELするため、二重採点は起こらない。
 * 読み出しに失敗した回はDELもしない(=次回の学習で再挑戦。黙って捨てない)。
 * @returns {{ scored: number, errors: string[] }}
 */
async function scoreFixtureDuels(deps, fixtureId, aiPick, actualWinner, nowMs) {
  const { upstashCmd, upstashGetJSON, upstashSetJSON } = deps;
  const errors = [];
  const key = `${PICKS_KEY_PREFIX}${fixtureId}`;
  let flat = null;
  try {
    flat = await upstashCmd(["HGETALL", key]);
  } catch (e) {
    return { scored: 0, errors: [`duel_read_failed:${fixtureId}`] };
  }
  if (!flat || !flat.length) return { scored: 0, errors: [] };
  // Upstash REST の HGETALL は [field, value, field, value, ...] 形式
  const entries = [];
  for (let i = 0; i + 1 < flat.length; i += 2) entries.push([flat[i], flat[i + 1]]);
  const monthKey = `${LB_MONTH_PREFIX}${monthKeyJst(nowMs)}`;
  let scored = 0;
  for (const [playerId, raw] of entries) {
    try {
      const pickObj = typeof raw === "string" ? JSON.parse(raw) : raw;
      const userPick = pickObj && pickObj.p;
      if (!VALID_PICKS.has(userPick)) continue;
      const userHit = userPick === actualWinner;
      const aiHit = aiPick === actualWinner;
      const outcome = userHit && !aiHit ? "W" : (!userHit && aiHit ? "L" : "D");
      const pKey = `${PLAYER_KEY_PREFIX}${playerId}`;
      const cur = (await upstashGetJSON(pKey).catch(() => null)) || { w: 0, d: 0, l: 0, userHits: 0, aiHits: 0, n: 0 };
      cur.nickname = (pickObj && pickObj.n) || cur.nickname || "名無しのファン";
      cur.n += 1;
      if (userHit) cur.userHits += 1;
      if (aiHit) cur.aiHits += 1;
      if (outcome === "W") cur.w += 1; else if (outcome === "L") cur.l += 1; else cur.d += 1;
      cur.updatedAt = new Date(nowMs).toISOString();
      const okSave = await upstashSetJSON(pKey, cur);
      if (okSave === false) { errors.push(`duel_player_save_failed:${String(playerId).slice(0, 8)}`); continue; }
      if (outcome === "W") {
        await upstashCmd(["ZINCRBY", LB_ALLTIME_KEY, "1", String(playerId)]).catch(() => errors.push("duel_zincr_failed"));
        await upstashCmd(["ZINCRBY", monthKey, "1", String(playerId)]).catch(() => {});
        await upstashCmd(["EXPIRE", monthKey, String(62 * 86400)]).catch(() => {});
      } else {
        // 撃破0の参加者もランキングに載せる(スコア0で登録。既にいれば維持=NX)
        await upstashCmd(["ZADD", LB_ALLTIME_KEY, "NX", "0", String(playerId)]).catch(() => {});
      }
      scored++;
    } catch (e) {
      errors.push(`duel_score_failed:${fixtureId}`);
    }
  }
  await upstashCmd(["DEL", key]).catch(() => errors.push(`duel_cleanup_failed:${fixtureId}`));
  return { scored, errors };
}

module.exports = {
  PICKS_KEY_PREFIX, PLAYER_KEY_PREFIX, LB_ALLTIME_KEY, LB_MONTH_PREFIX,
  MAX_PICKS_PER_FIXTURE, NICKNAME_MAX,
  sanitizeNickname, validatePick, storePick, scoreFixtureDuels, monthKeyJst,
};
