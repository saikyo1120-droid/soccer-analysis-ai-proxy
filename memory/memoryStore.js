/**
 * server/memory/memoryStore.js
 * ------------------------------------------------
 * Memory Engine ― AIが「昨日何を結論づけたか」を覚えておき、新しい情報によって
 * 結論が変わった場合は「なぜ変わったか」まで記録する。
 *
 * 「サブジェクト」という考え方: 何についての結論かを表す文字列キー
 * (例: "team:Bayern Munich:form" や "team:Real Madrid:defense" のように、
 * 呼び出し側(Reasoning Engineなど)が用途に応じて決める)。
 *
 * 保存する情報:
 *   memory:current:<subjectKey>  … 現在の結論 { statement, confidence, reasoning,
 *                                    computedAt, evidence, revision }
 *   memory:history:<subjectKey> … 過去の結論の履歴(リスト)。結論が変わるたびに
 *                                  「前の結論」+「変化理由」+「いつ・何に置き換わったか」
 *                                  を追記する(削除しない。「AIは昨日こう考えていたが、
 *                                  今日はこう考える」という履歴を再現するためのもの)。
 *
 * 正直な設計範囲(重要):
 *   - 結論が「変わった」かどうかは statement 文字列の完全一致で判定する
 *     (意味的な類似度判定はしていない)。呼び出し側が同じ内容を毎回同じ文言で
 *     表現すればよい。表現ゆれによって「別の結論になった」と誤判定される可能性は
 *     既知の制約として README に明記する。
 *   - 「変化理由」は呼び出し側(Reasoning Engine)が明示的に渡した文字列をそのまま
 *     保存するだけで、AIが変化理由を自動生成する機能ではない。理由が渡されなかった
 *     場合は「(変化理由は記録されていません)」と正直に表示する(でっち上げない)。
 */
const MAX_HISTORY_PER_SUBJECT = 50;

function createMemoryStore({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON }) {
  async function getLastConclusion(subjectKey) {
    if (!upstashEnabled || !subjectKey) return null;
    return (await upstashGetJSON(`memory:current:${subjectKey}`)) || null;
  }

  /**
   * @param {string} subjectKey
   * @param {object} conclusion - { statement, confidence?, reasoning?, computedAt(ISO), evidence? }
   * @param {string} [changeReason] - 「なぜ結論が変わったか」の説明文。結論が変わった場合のみ意味を持つ。
   * @returns {{ saved:boolean, changed:boolean, reason:string, revision?:number, previousStatement?:string }}
   */
  async function saveConclusion(subjectKey, conclusion, changeReason) {
    if (!upstashEnabled) return { saved: false, changed: false, reason: "NO_UPSTASH" };
    if (!subjectKey || !conclusion || !conclusion.statement) {
      return { saved: false, changed: false, reason: "INVALID_ITEM" };
    }

    const previous = await getLastConclusion(subjectKey);

    if (!previous) {
      const record = { ...conclusion, subjectKey, revision: 1 };
      await upstashSetJSON(`memory:current:${subjectKey}`, record);
      await upstashCmd(["INCR", "memory:totalConclusionsSavedCounter"]).catch(() => {});
      return { saved: true, changed: true, reason: "INITIAL", revision: 1 };
    }

    const changed = previous.statement !== conclusion.statement;

    if (!changed) {
      // 結論は変わっていない。「昨日と同じ考えを today も再確認した」という事実だけ更新する。
      const record = { ...previous, lastConfirmedAt: conclusion.computedAt };
      await upstashSetJSON(`memory:current:${subjectKey}`, record);
      return { saved: true, changed: false, reason: "UNCHANGED", revision: previous.revision || 1 };
    }

    // 結論が変わった: 前の結論を履歴に退避し、変化理由を記録してから新しい結論に置き換える。
    const historyEntry = {
      statement: previous.statement,
      confidence: previous.confidence,
      reasoning: previous.reasoning,
      computedAt: previous.computedAt,
      supersededAt: conclusion.computedAt,
      supersededBy: conclusion.statement,
      changeReason: changeReason || "(変化理由は記録されていません)",
    };
    await upstashCmd(["RPUSH", `memory:history:${subjectKey}`, JSON.stringify(historyEntry)]).catch(() => {});
    await upstashCmd(["LTRIM", `memory:history:${subjectKey}`, String(-MAX_HISTORY_PER_SUBJECT), "-1"]).catch(() => {});

    const revision = (previous.revision || 1) + 1;
    const record = { ...conclusion, subjectKey, revision };
    await upstashSetJSON(`memory:current:${subjectKey}`, record);
    // 2026年8月・「AIの成長レポート」ウィジェット(ご要望⑦)対応: 登録クラブ
    // 全件をループするhandleDebugStatusの集計方式はホーム画面には重すぎるため、
    // 軽量な累計カウンター(knowledgeStore.jsと同じパターン)を別途持つ。
    await upstashCmd(["INCR", "memory:totalConclusionsSavedCounter"]).catch(() => {});
    return { saved: true, changed: true, reason: "CHANGED", revision, previousStatement: previous.statement };
  }

  /**
   * 直近の履歴を新しい順で返す(「AIは昨日こう考えていたが、今日はこう考える」の一覧表示用)。
   */
  async function getConclusionHistory(subjectKey, limit) {
    if (!upstashEnabled || !subjectKey) return [];
    const n = Number.isFinite(limit) && limit > 0 ? limit : 20;
    const raw = (await upstashCmd(["LRANGE", `memory:history:${subjectKey}`, String(-n), "-1"]).catch(() => [])) || [];
    return raw
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  }

  return { getLastConclusion, saveConclusion, getConclusionHistory };
}

module.exports = { createMemoryStore, MAX_HISTORY_PER_SUBJECT };
