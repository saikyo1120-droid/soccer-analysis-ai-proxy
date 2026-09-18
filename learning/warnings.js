"use strict";
/**
 * v92(2026年9月18日): 「黙って飲み込む失敗」に痕跡を残すための最小の記録器。
 *
 *  背景: クラブElo中継(v87④→v91)で、失敗した日にサーバー側へ痕跡が1つも残らず、
 *  11日間「GitHubが動いていないのか、提供元が落ちているのか」を切り分けられなかった。
 *  同じ欠陥クラス=「catch して黙って続行する箇所」が learning/ 配下に27か所あった。
 *  「学習を止めない」のは正しい設計だが、「記録しない」のは別問題。
 *
 *  方針:
 *   ・挙動は一切変えない(記録するだけ。制御の流れ・戻り値・保存内容は従来どおり)
 *   ・記録器自身は絶対に例外を外へ出さない(記録の失敗で本体を壊さない)
 *   ・件数に上限を設け、超過分は件数だけ数える(成長ログの肥大化を防ぐ。第5次監査の方針)
 *   ・公開画面には出さない(情報過多禁止)。/api/learning/daily-report と成長ログに載せる
 */
const WARNINGS_CAP = 80;

function formatWarning(tag, err) {
  const msg = err === undefined || err === null ? "" : (err && err.message ? String(err.message) : String(err));
  return msg ? `${String(tag)}:${msg.slice(0, 200)}` : String(tag);
}

/** target.warnings(配列)へ1行追加する。target.warningsDropped は上限超過の件数。 */
function noteWarning(target, tag, err, cap) {
  try {
    if (!target || typeof target !== "object") return false;
    if (!Array.isArray(target.warnings)) target.warnings = [];
    if (!Number.isFinite(target.warningsDropped)) target.warningsDropped = 0;
    const max = Number.isFinite(cap) && cap > 0 ? cap : WARNINGS_CAP;
    if (target.warnings.length < max) target.warnings.push(formatWarning(tag, err));
    else target.warningsDropped++;
    return true;
  } catch (e) { return false; } // 記録器自身は絶対に失敗を外へ出さない(v92_silent_failures_test が唯一許可する黙認箇所)
}

/** deps.noteWarning が渡されていれば呼ぶ(無ければ何もしない=従来と同一)。 */
function noteVia(deps, tag, err) {
  try {
    if (deps && typeof deps.noteWarning === "function") { deps.noteWarning(tag, err); return true; }
  } catch (e) { /* 呼び出し先の失敗も本体へは出さない(v92_silent_failures_test が唯一許可する黙認箇所) */ }
  return false;
}

/** 成長ログ用の要約(件数+先頭の内訳)。 */
function summarizeWarnings(target, keep) {
  const items = (target && Array.isArray(target.warnings)) ? target.warnings : [];
  const dropped = (target && Number.isFinite(target.warningsDropped)) ? target.warningsDropped : 0;
  const n = Number.isFinite(keep) && keep > 0 ? keep : 40;
  return {
    count: items.length + dropped,
    dropped: dropped + Math.max(0, items.length - n),
    items: items.slice(0, n),
    noteJa: (items.length + dropped) > 0
      ? `学習は完走しましたが、付加的な処理が${items.length + dropped}件記録できませんでした(本体の学習・予測は従来どおり動いています。内容はitemsに実測で残しています)。`
      : "付加的な処理の失敗はありませんでした。",
  };
}

/** 同日再実行の合算用: 内訳は内容で重複排除して上限、件数は合算。 */
function mergeWarningSummaries(prev, cur, keep) {
  if (!prev) return cur || null;
  if (!cur) return prev;
  const n = Number.isFinite(keep) && keep > 0 ? keep : 40;
  const items = Array.from(new Set([...(prev.items || []), ...(cur.items || [])]));
  const count = (prev.count || 0) + (cur.count || 0);
  return {
    count,
    dropped: Math.max(0, count - Math.min(items.length, n)),
    items: items.slice(0, n),
    noteJa: count > 0
      ? `学習は完走しましたが、付加的な処理が${count}件記録できませんでした(本体の学習・予測は従来どおり動いています。内容はitemsに実測で残しています)。`
      : "付加的な処理の失敗はありませんでした。",
  };
}

module.exports = { WARNINGS_CAP, noteWarning, noteVia, summarizeWarnings, mergeWarningSummaries, formatWarning };
