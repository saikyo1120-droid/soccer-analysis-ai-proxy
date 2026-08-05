/**
 * server/memory/thoughtTimeline.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑳「Memory Engine強化」の実装。
 *
 * ■ ご指示の原文
 *   「Memory Engineは単なる履歴ではなく、AI自身の考え方の変化を記録してください。
 *     以前は『レアル優勢』→ 怪我人が増えた → 評価変更 → 予測変更 → 試合終了 →
 *     答え合わせ → 学んだこと まで時系列で保存してください。
 *     AI自身が『以前と比べて考え方が変わった理由』を説明できるようにしてください。」
 *
 * ■ 既存の memoryStore.js との違い(なぜ別に作ったか)
 *   memoryStore は「今の結論」と「過去の結論のリスト」を持つ、いわば**点の記録**です。
 *   ご指示にあるのは点ではなく**1本の物語**でした。
 *     ある見立て → それが変わったきっかけ(実データ) → 変わった後の見立て →
 *     実際に立てた予測 → 試合の結果 → 当たったのか外れたのか → だから何を学んだのか
 *   これらは互いに因果でつながっていて、途中の1つが欠けると
 *   「なぜ考えが変わったのか」を説明できません。
 *   そこで、1つの対象(例: ある試合、あるクラブ)について起きた出来事を
 *   **順番と因果を保ったまま1本の線として持つ**構造を新設しました。
 *
 * ■ 保存形式
 *   memory:timeline:<subjectKey>  … 出来事のリスト(古い順)
 *   各出来事: {
 *     at,              いつ
 *     kind,            種類(belief/trigger/prediction/result/lesson)
 *     statementJa,     何が起きたか・何を考えたか(日本語1文)
 *     causeJa,         なぜそうなったか(直前の出来事との因果。無ければnull)
 *     evidence,        根拠にした実データ(配列。でっち上げ防止のため必ず実データのみ)
 *     meta,            数値など(予測確率・実際のスコアなど)
 *   }
 *
 * ■ でっち上げ防止
 *   ・causeJa は「呼び出し側が実データから機械的に導いた文」だけを受け取る。
 *     LLMに理由を書かせて入れることはしない。
 *   ・因果が分からない場合は null のままにし、表示では
 *     「変化のきっかけは特定できていません」と正直に出す。
 */

const TIMELINE_MAX = 60;         // 1対象あたりに保持する出来事の上限
const KINDS = ["belief", "trigger", "prediction", "result", "lesson"];
const KIND_LABELS_JA = {
  belief: "そのときの見立て",
  trigger: "考えが変わったきっかけ",
  prediction: "立てた予測",
  result: "試合の結果",
  lesson: "そこから学んだこと",
};

function createThoughtTimeline({ upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON }) {
  const keyFor = (subjectKey) => `memory:timeline:${subjectKey}`;

  /**
   * 出来事を1つ書き足す。
   * 同じ内容が直前と完全に同じ場合は書かない(「何も変わっていない日」に
   * 履歴だけが伸びると、成長しているように見えてしまうため)。
   */
  async function append(subjectKey, event) {
    if (!upstashEnabled || !subjectKey || !event || !event.kind || !event.statementJa) {
      return { saved: false, reason: "INVALID" };
    }
    if (!KINDS.includes(event.kind)) return { saved: false, reason: "INVALID_KIND" };

    const list = await read(subjectKey);
    // 監査で発見した欠陥の修正:
    //   直前の1件としか比べていなかったため、「予測→結果→学び」を毎回書くと
    //   学びの文が常に「結果」の後ろに来て、**同じ定型文が毎日積み上がって**
    //   いた。「考えの移り変わり(N件)」の数字だけが増えて中身は増えない、
    //   という水増しになる。同じ種類の直近の記録と比べる。
    const lastSameKind = [...list].reverse().find((e) => e.kind === event.kind) || null;
    if (lastSameKind && lastSameKind.statementJa === String(event.statementJa).slice(0, 300)) {
      return { saved: false, reason: "UNCHANGED" };
    }

    const record = {
      at: event.at || new Date().toISOString(),
      kind: event.kind,
      statementJa: String(event.statementJa).slice(0, 300),
      // 直前の出来事との因果。実データから導けなかった場合は正直にnull。
      causeJa: event.causeJa ? String(event.causeJa).slice(0, 300) : null,
      evidence: Array.isArray(event.evidence) ? event.evidence.slice(0, 5).map((e) => String(e).slice(0, 200)) : [],
      meta: event.meta || null,
    };
    await upstashCmd(["RPUSH", keyFor(subjectKey), JSON.stringify(record)]).catch(() => {});
    await upstashCmd(["LTRIM", keyFor(subjectKey), String(-TIMELINE_MAX), "-1"]).catch(() => {});
    return { saved: true, event: record };
  }

  async function read(subjectKey) {
    if (!upstashEnabled || !subjectKey) return [];
    const raw = (await upstashCmd(["LRANGE", keyFor(subjectKey), "0", "-1"]).catch(() => [])) || [];
    return raw.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  }

  /**
   * ご指示の中核: 「以前と比べて考え方が変わった理由」をAI自身に説明させる。
   *
   * LLMは使わない。保存済みの出来事の並びから、
   *   「以前は◯◯と考えていました」
   *   →「しかし△△という実データが入りました」
   *   →「そのため□□と考えを変えました」
   *   →「実際の結果は××で、この判断は当たり/外れでした」
   *   →「そこから☆☆を学びました」
   * という文章を機械的に組み立てる。だから内容は必ず記録どおりで、
   * 説明そのものがでっち上げになることがない。
   */
  async function explainChange(subjectKey) {
    const events = await read(subjectKey);
    if (!events.length) {
      return { available: false, reasonJa: "この対象については、まだ考えの記録がありません。", narrativeJa: null, events: [] };
    }
    const beliefs = events.filter((e) => e.kind === "belief");
    if (beliefs.length < 2) {
      return {
        available: false,
        reasonJa: beliefs.length === 1
          ? "この対象についての見立ては、まだ1度しか記録していません(比べる前回がありません)。"
          : "この対象については、まだ見立てを記録していません。",
        narrativeJa: null,
        events,
      };
    }
    const prevBelief = beliefs[beliefs.length - 2];
    const curBelief = beliefs[beliefs.length - 1];
    const prevIdx = events.indexOf(prevBelief);
    const curIdx = events.indexOf(curBelief);
    // 2つの見立ての「あいだ」に起きたことが、考えが変わった理由そのもの
    const between = events.slice(prevIdx + 1, curIdx);
    const triggers = between.filter((e) => e.kind === "trigger");
    // 監査で発見した欠陥の修正:
    //   results / lessons を**時系列全体**から拾っていたため、2つの見立てより
    //   前に起きた試合結果を「そのため現在はこう考えています」の直後に置き、
    //   **今の見立てがその結果で検証されたかのように**読める文章になっていた。
    //   今の見立てより後に起きたものだけを、答え合わせとして扱う。
    const afterCurrent = events.slice(curIdx + 1);
    const results = afterCurrent.filter((e) => e.kind === "result");
    const lessons = afterCurrent.filter((e) => e.kind === "lesson");

    const lines = [];
    lines.push(`以前(${String(prevBelief.at).slice(0, 10)})は「${prevBelief.statementJa}」と考えていました。`);
    if (triggers.length) {
      // 監査で発見した表現の重複の修正:
      //   きっかけの文が既に「〜が入りました」で終わっている場合に
      //   「〜という実データが入りました」を足すと
      //   「新しい実データが入りましたという実データが入りました」になっていた。
      const joinedTriggers = triggers.map((t) => t.statementJa).join("、また、");
      lines.push(/(ました|ます|です)。?$/.test(joinedTriggers)
        ? `その後、${joinedTriggers.replace(/。$/, "")}。`
        : `その後、${joinedTriggers}という実データが入りました。`);
      const withEvidence = triggers.filter((t) => t.evidence && t.evidence.length);
      if (withEvidence.length) {
        lines.push(`根拠にしたのは、${withEvidence.flatMap((t) => t.evidence).slice(0, 3).join(" / ")} です。`);
      }
    } else {
      // 因果が分からないときに、それらしい理由を作らない
      lines.push("ただし、この間に考えを変えるきっかけとなる実データは記録されていません。表現の揺れによる違いの可能性もあります。");
    }
    lines.push(`そのため現在(${String(curBelief.at).slice(0, 10)})は「${curBelief.statementJa}」と考えています。`);
    if (curBelief.causeJa) lines.push(curBelief.causeJa);

    if (results.length) {
      const last = results[results.length - 1];
      lines.push(`実際の結果は「${last.statementJa}」でした。`);
    }
    if (lessons.length) {
      lines.push(`ここから学んだこと: ${lessons[lessons.length - 1].statementJa}`);
    } else if (results.length) {
      lines.push("この結果からの学びは、まだ言語化できていません(次の答え合わせで整理します)。");
    }

    return {
      available: true,
      narrativeJa: lines.join(" "),
      previousBelief: prevBelief,
      currentBelief: curBelief,
      triggers,
      hasOutcome: results.length > 0,
      hasLesson: lessons.length > 0,
      events,
    };
  }

  /**
   * 画面表示用に、時系列をそのまま返す(見出し付き)。
   * ご指示の「時系列で保存してください」を、利用者が読める形で見せる部分。
   */
  async function getTimelineForDisplay(subjectKey, limit = 12) {
    const events = await read(subjectKey);
    const recent = events.slice(-limit);
    return {
      available: recent.length > 0,
      steps: recent.map((e) => ({
        at: e.at,
        kindLabelJa: KIND_LABELS_JA[e.kind] || e.kind,
        kind: e.kind,
        statementJa: e.statementJa,
        causeJa: e.causeJa,
        evidence: e.evidence,
      })),
      totalRecorded: events.length,
      // 省略した場合は正直に伝える(黙って切り捨てない)
      omittedCount: Math.max(0, events.length - recent.length),
    };
  }

  /**
   * 予測の答え合わせが済んだときに、「予測 → 結果 → 学んだこと」を
   * 一度にまとめて書き足す。日次学習ジョブから呼ばれる。
   */
  async function recordOutcome(subjectKey, { predictionJa, resultJa, correct, lessonJa, evidence, at }) {
    const stamp = at || new Date().toISOString();
    const out = [];
    if (predictionJa) out.push(await append(subjectKey, { kind: "prediction", statementJa: predictionJa, at: stamp }));
    if (resultJa) {
      out.push(await append(subjectKey, {
        kind: "result", statementJa: resultJa, at: stamp,
        meta: { correct: correct === true ? true : correct === false ? false : null },
      }));
    }
    if (lessonJa) {
      out.push(await append(subjectKey, {
        kind: "lesson", statementJa: lessonJa, at: stamp,
        evidence: evidence || [],
        causeJa: correct === true
          ? "予測が当たったため、この判断基準は今後も使います。"
          : correct === false
            ? "予測が外れたため、この判断基準を見直します。"
            : null,
      }));
    }
    return { saved: out.some((r) => r && r.saved), results: out };
  }

  return { append, read, explainChange, getTimelineForDisplay, recordOutcome };
}

module.exports = { createThoughtTimeline, KINDS, KIND_LABELS_JA, TIMELINE_MAX };
