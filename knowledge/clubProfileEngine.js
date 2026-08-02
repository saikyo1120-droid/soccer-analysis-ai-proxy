/**
 * server/knowledge/clubProfileEngine.js
 * ------------------------------------------------
 * Knowledge Engine Layer2(固定知識)を生成・維持するモジュール。
 *
 * 正直な設計方針(重要): API-Football(契約中の唯一の実データソース)には
 * 「戦術の特徴」「プレースタイル」「長所・短所」のような定性的な情報は
 * 存在しない(数値・結果・名簿を中心としたデータAPIのため)。またクラブ
 * 公式サイトやニュース記事のスクレイピングは、著作権・利用規約上のリスクを
 * 避けるためこのプロジェクトでは意図的に行わない(server/knowledge/
 * knowledgeStore.js 冒頭のコメントと同じ方針)。
 *
 * そのため、この固定知識はLLM(Anthropic)に生成させる。ただし「捏造しない」
 * という全体方針を守るため、
 *   ①生成時には必ずLayer1の実データ(直近成績・監督名・フォーメーション等)を
 *     根拠として一緒に渡し、それに基づいた解釈をさせる
 *   ②保存する知識には必ず isAiGenerated:true フラグと、人間が読む文言にも
 *     「AIによる推定」という明示を含める(公式情報と誤認させない)
 *   ③頻繁に作り直さない(既定60日に一度。「固定知識」は事実ほど頻繁には
 *     変わらないという前提。もちろん監督交代など大きな変化があれば手動で
 *     再生成を促す運用も可能)
 * という3つの歯止めを設ける。
 */

function buildProfilePrompt(teamJa, teamEn, groundingFacts) {
  const factsBlock = groundingFacts.length
    ? groundingFacts.map((f) => `- ${f}`).join("\n")
    : "(現時点で参照できる実データはありません。一般的なサッカーの知識のみに基づいて推定してください。)";
  const systemPrompt = [
    "あなたはサッカークラブの戦術傾向を分析するアシスタントです。",
    "与えられた実データ(直近成績・監督名・フォーメーション・ホームアウェイ別成績等)を踏まえつつ、",
    "一般的に知られているそのクラブの傾向についてまとめてください。",
    "存在しない具体的な数値(移籍金額・年俸・xG・保持率など)を作ってはいけません。",
    "必ず次の見出し形式でJSONを1つだけ出力してください(説明文は不要):",
    '{"tacticalStyle": "...", "formationTendency": "...", "strengths": ["...", "..."], "weaknesses": ["...", "..."], "buildUp": "...", "pressing": "...", "setPieces": "...", "counterAttack": "...", "possessionStyle": "...", "homeAwayNote": "..."}',
    "各値は40〜80文字程度の日本語で、断定しすぎず「傾向がある」「とされる」のような表現を使ってください。",
    "counterAttackはカウンター攻撃の活用傾向、possessionStyleはボール保持の傾向(数値の保持率は作らず定性的に)、",
    "homeAwayNoteは与えられたホーム/アウェイ別成績の実データがあればそれに基づいたコメント(無ければ「データ不足のため言及しない」のような一言)にしてください。",
  ].join("\n");
  const userPrompt = [
    `対象クラブ: ${teamJa}(${teamEn})`,
    "",
    "参照できる実データ:",
    factsBlock,
  ].join("\n");
  return { systemPrompt, userPrompt };
}

function parseProfileJson(rawText) {
  const text = String(rawText || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      tacticalStyle: String(obj.tacticalStyle || "").slice(0, 200),
      formationTendency: String(obj.formationTendency || "").slice(0, 200),
      strengths: Array.isArray(obj.strengths) ? obj.strengths.slice(0, 5).map((s) => String(s).slice(0, 120)) : [],
      weaknesses: Array.isArray(obj.weaknesses) ? obj.weaknesses.slice(0, 5).map((s) => String(s).slice(0, 120)) : [],
      buildUp: String(obj.buildUp || "").slice(0, 200),
      pressing: String(obj.pressing || "").slice(0, 200),
      setPieces: String(obj.setPieces || "").slice(0, 200),
      counterAttack: String(obj.counterAttack || "").slice(0, 200),
      possessionStyle: String(obj.possessionStyle || "").slice(0, 200),
      homeAwayNote: String(obj.homeAwayNote || "").slice(0, 200),
    };
  } catch (e) {
    return null;
  }
}

/**
 * @param {object} deps - { generateLLM, knowledgeStore, setRelation? }
 */
function createClubProfileEngine({ generateLLM, knowledgeStore, setRelation }) {
  /**
   * 既存の有効なプロフィールがあればそれを返し(再生成しない=コストを節約)、
   * 無い/失効している場合だけ新しく生成する。「知識の不足を自動で補完する」
   * 仕組みの一部(Layer2版)。
   */
  async function ensureClubProfile(teamEn, teamJa, groundingFacts, nowIso, coachName) {
    const existing = await knowledgeStore.getActiveKnowledge(teamEn);
    const existingProfile = existing.profiles && existing.profiles.length ? existing.profiles[0] : null;
    if (existingProfile) return { generated: false, profile: existingProfile };

    if (typeof generateLLM !== "function") {
      return { generated: false, profile: null, reason: "LLM_NOT_CONFIGURED" };
    }

    const { systemPrompt, userPrompt } = buildProfilePrompt(teamJa, teamEn, groundingFacts || []);
    let parsed = null;
    try {
      const { text } = await generateLLM({ systemPrompt, userPrompt, maxTokens: 550 });
      parsed = parseProfileJson(text);
    } catch (e) {
      return { generated: false, profile: null, reason: `LLM_ERROR:${e.code || e.message}` };
    }
    if (!parsed) return { generated: false, profile: null, reason: "PARSE_FAILED" };

    const statement = [
      `【AIによる推定・戦術傾向】戦術スタイル: ${parsed.tacticalStyle || "不明"}`,
      `フォーメーション傾向: ${parsed.formationTendency || "不明"}`,
      parsed.strengths.length ? `強み: ${parsed.strengths.join("、")}` : null,
      parsed.weaknesses.length ? `弱み: ${parsed.weaknesses.join("、")}` : null,
      parsed.buildUp ? `ビルドアップ: ${parsed.buildUp}` : null,
      parsed.pressing ? `プレス: ${parsed.pressing}` : null,
      parsed.setPieces ? `セットプレー: ${parsed.setPieces}` : null,
      parsed.counterAttack ? `カウンター: ${parsed.counterAttack}` : null,
      parsed.possessionStyle ? `ボール保持傾向: ${parsed.possessionStyle}` : null,
      parsed.homeAwayNote ? `ホーム/アウェイ傾向: ${parsed.homeAwayNote}` : null,
    ].filter(Boolean).join(" / ");

    const item = {
      teamEn, teamJa, category: "clubProfile", type: "profile",
      statement, detail: parsed, isAiGenerated: true,
      computedAt: nowIso, source: "AIによる推定(API-Footballの実データを参考情報として使用。クラブ公式発表ではありません)",
    };
    const result = await knowledgeStore.saveKnowledgeItem(item);

    // Knowledge Graph: 「このクラブの戦術的特徴は○○」という関係も併せて記録する
    // (単なるデータベースではなく、後で「チーム→戦術→…」とたどれるようにするため)。
    // coachNameが分かっている場合は「監督→好むフォーメーション」の関係も記録し、
    // team→manager→formation という2ホップの連鎖(ご要望の多段リンクの例)を
    // たどれるようにする。
    if (result.saved && typeof setRelation === "function") {
      if (parsed.tacticalStyle) setRelation("team", teamEn, "tacticalStyle", "tactic", parsed.tacticalStyle).catch(() => {});
      if (parsed.formationTendency) setRelation("team", teamEn, "formationTendency", "formation", parsed.formationTendency).catch(() => {});
      if (coachName && parsed.formationTendency) setRelation("person", coachName, "preferredFormation", "formation", parsed.formationTendency).catch(() => {});
    }

    return { generated: true, saved: result.saved, profile: { ...item, hash: result.hash } };
  }

  return { ensureClubProfile };
}

module.exports = { createClubProfileEngine, buildProfilePrompt, parseProfileJson };
