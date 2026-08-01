/**
 * server/knowledge/knowledgeStore.js
 * ------------------------------------------------
 * Knowledge Engine ― 「事実」「分析」「意見」を分離して保存し、重複を防ぎ、
 * 古くなった情報を失効させる知識ベース。
 *
 * 正直な設計範囲(重要): このモジュールは「クラブ公式サイト・ニュース記事・
 * 監督の生の発言」をスクレイピングして取り込む機能ではありません。任意の外部
 * サイトを無断でスクレイピングすることは利用規約・著作権上のリスクがあるため、
 * 今回はあえて実装していません。知識の取得元は、このアプリが既に契約している
 * API-Football(実データAPI)からの情報(直近成績・怪我・移籍・フォーメーション・
 * 監督名など)、および server/learning/dailyJob.js や server/reasoning/ が
 * そのデータから導き出した「分析」(fact→analysisへの格上げ。下記参照)に限定
 * しています。「監督の生の発言」は引き続き取得できません(既存の
 * MANAGER_QUOTE_UNAVAILABLE_REASON と同じ理由)。将来、正規のニュースAPIや
 * クラブの公式RSSフィードなど、利用規約上問題のない情報源を具体的に決めて
 * いただければ、その情報源専用のfetcherを追加する形で拡張できます。
 *
 * 3種類の知識タイプ(混ぜて保存しない):
 *   "fact"     ― 客観的に計算できる数値(例: 得失点差の変化、怪我人リスト)
 *   "analysis" ― 事実を根拠にした解釈(例: Hypothesis Engineが実際の試合結果で
 *                検証し「確からしい」と判定した仮説)
 *   "opinion"  ― LLMが下した主観的な考察(議論モードの「考察」欄そのもの)
 *
 * 重複排除: 同じクラブ・カテゴリ・内容の知識は、内容のハッシュ値で判定して
 * 二重登録しない(全く同じ「事実」を毎日再登録して知識ベースが際限なく
 * 膨らむのを防ぐ)。
 *
 * 失効管理: 各アイテムは type ごとに既定の有効日数を持ち、その日数を過ぎたら
 * 「アクティブな知識」の一覧からは除外される(削除はしない。履歴としては
 * 残るが、RAG・推論には使われなくなる)。
 */
const crypto = require("crypto");

const DEFAULT_EXPIRY_DAYS = { fact: 14, analysis: 30, opinion: 3 };
const MAX_ITEMS_PER_TEAM = 80;

function stableHash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function computeItemHash(item) {
  const normalized = `${item.teamEn}|${item.category}|${item.type}|${(item.statement || "").trim()}`;
  return stableHash(normalized);
}

function isExpired(item, nowMs) {
  const days = item.expiresRelevanceDays || DEFAULT_EXPIRY_DAYS[item.type] || 14;
  const computedAtMs = new Date(item.computedAt).getTime();
  if (!Number.isFinite(computedAtMs)) return false;
  return nowMs - computedAtMs > days * 24 * 60 * 60 * 1000;
}

function createKnowledgeStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON }) {
  /**
   * @param {object} item - { teamEn, category, type: "fact"|"analysis"|"opinion",
   *   statement, computedAt(ISO), expiresRelevanceDays?, source }
   * @returns {{ saved: boolean, reason?: string, hash: string }}
   */
  async function saveKnowledgeItem(item) {
    if (!upstashEnabled) return { saved: false, reason: "NO_UPSTASH", hash: null };
    if (!item || !item.teamEn || !item.type || !item.statement) return { saved: false, reason: "INVALID_ITEM", hash: null };
    if (!["fact", "analysis", "opinion"].includes(item.type)) return { saved: false, reason: "INVALID_TYPE", hash: null };

    const hash = computeItemHash(item);
    const existing = await upstashGetJSON(`knowledge:item:${hash}`);
    if (existing) {
      // 既に全く同じ内容が登録済み。重複登録はしないが、鮮度だけ更新する
      // (「今日も変わらず観測されている」という事実は意味があるため)。
      existing.lastSeenAt = item.computedAt;
      await upstashSetJSON(`knowledge:item:${hash}`, existing);
      return { saved: false, reason: "DUPLICATE", hash };
    }

    const record = { ...item, hash, firstSeenAt: item.computedAt, lastSeenAt: item.computedAt };
    await upstashSetJSON(`knowledge:item:${hash}`, record);
    await upstashCmd(["RPUSH", `knowledge:byTeam:${item.teamEn}`, hash]).catch(() => {});
    await upstashCmd(["LTRIM", `knowledge:byTeam:${item.teamEn}`, String(-MAX_ITEMS_PER_TEAM), "-1"]).catch(() => {});
    return { saved: true, hash };
  }

  /**
   * このクラブについて現在「有効」な知識(失効していないもの)を、事実/分析/意見に
   * 分けて返す。失効した知識は除外される(=削除はされないが、以後のRAG・推論には
   * もう使われない、という設計)。
   */
  async function getActiveKnowledge(teamEn, nowMs) {
    const empty = { facts: [], analyses: [], opinions: [], totalStored: 0, totalActive: 0 };
    if (!upstashEnabled || !teamEn) return empty;
    const now = nowMs || Date.now();
    const hashes = (await upstashCmd(["LRANGE", `knowledge:byTeam:${teamEn}`, "0", "-1"]).catch(() => [])) || [];
    const items = [];
    for (const h of hashes) {
      const record = await upstashGetJSON(`knowledge:item:${h}`);
      if (record) items.push(record);
    }
    const active = items.filter((i) => !isExpired(i, now));
    return {
      facts: active.filter((i) => i.type === "fact"),
      analyses: active.filter((i) => i.type === "analysis"),
      opinions: active.filter((i) => i.type === "opinion"),
      totalStored: items.length,
      totalActive: active.length,
    };
  }

  return { saveKnowledgeItem, getActiveKnowledge };
}

module.exports = { createKnowledgeStore, computeItemHash, isExpired, DEFAULT_EXPIRY_DAYS };
