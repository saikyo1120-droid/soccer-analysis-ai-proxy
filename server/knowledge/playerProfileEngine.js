/**
 * server/knowledge/playerProfileEngine.js
 * ------------------------------------------------
 * Knowledge Engine Layer2(固定知識)の選手版。server/knowledge/clubProfileEngine.js
 * と全く同じ設計方針(実データを根拠にLLMへ生成させる・必ず「AIによる推定」と
 * 明示する・既に有効なプロフィールがあれば再生成しない)を選手単位に適用する。
 *
 * 「主要リーグ全選手について」のご要望への正直な回答: 107名(登録選手)は
 * おろか主要リーグの全選手を毎日バッチ処理で総なめにすることは、API-Football
 * 無料枠(1日100リクエスト)は言うまでもなく、有料プランでもLLM呼び出しの
 * コストの観点で現実的ではありません(1選手ごとに実データ取得+LLM生成が
 * 発生するため)。そのため、選手のKnowledge Engineは「毎日全選手をバッチ処理」
 * ではなく、「議論モード等で実際に質問された選手について、その場で生成し
 * キャッシュする(既定60日)」というオンデマンド方式にしています。これにより
 * 理論上は"主要リーグの任意の選手"に対応でき(質問された選手から知識が
 * 蓄積されていく)、かつコストを利用実態に比例させられます。
 *
 * 保存するデータの分離:
 *   - 実際の成績数値(出場数・得点・アシスト・キーパス・ドリブル成功率・
 *     守備指標・デュエル勝率・パス成功率など)は、LLMには一切生成させず、
 *     API-Footballの実データ(server/learning/playerFeatures.js)をそのまま
 *     Layer1「事実」として保存する(捏造の余地をなくすため)。
 *   - プレースタイル・特徴・長所・短所だけをLLMに生成させ、Layer2「固定知識」
 *     として保存する(必ずisAiGenerated:trueを付与)。
 */

function buildPlayerProfilePrompt(playerNameJa, playerNameEn, groundingFacts) {
  const factsBlock = groundingFacts.length
    ? groundingFacts.map((f) => `- ${f}`).join("\n")
    : "(現時点で参照できる実データはありません。一般的なサッカーの知識のみに基づいて推定してください。)";
  const systemPrompt = [
    "あなたはサッカー選手のプレースタイルを分析するアシスタントです。",
    "与えられた実データ(出場数・得点・アシスト・キーパス・ドリブル成功率・守備指標・デュエル勝率等)を踏まえ、",
    "その選手のプレースタイルについてまとめてください。",
    "存在しない具体的な数値(市場価値・年俸・契約期間・利き足など、与えられていない情報)を作ってはいけません。",
    "必ず次の見出し形式でJSONを1つだけ出力してください(説明文は不要):",
    '{"playstyle": "...", "traits": ["...", "..."], "strengths": ["...", "..."], "weaknesses": ["...", "..."]}',
    "各値は30〜70文字程度の日本語で、断定しすぎず「傾向がある」「とされる」のような表現を使ってください。",
  ].join("\n");
  const userPrompt = [
    `対象選手: ${playerNameJa}${playerNameEn ? `(${playerNameEn})` : ""}`,
    "",
    "参照できる実データ:",
    factsBlock,
  ].join("\n");
  return { systemPrompt, userPrompt };
}

function parsePlayerProfileJson(rawText) {
  const text = String(rawText || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      playstyle: String(obj.playstyle || "").slice(0, 200),
      traits: Array.isArray(obj.traits) ? obj.traits.slice(0, 5).map((s) => String(s).slice(0, 100)) : [],
      strengths: Array.isArray(obj.strengths) ? obj.strengths.slice(0, 5).map((s) => String(s).slice(0, 120)) : [],
      weaknesses: Array.isArray(obj.weaknesses) ? obj.weaknesses.slice(0, 5).map((s) => String(s).slice(0, 120)) : [],
    };
  } catch (e) {
    return null;
  }
}

/**
 * @param {object} deps - { generateLLM, knowledgeStore, setRelation?, onProfileGenerated? }
 *   onProfileGenerated(playerKey) - 任意。新しく選手プロフィールを生成した瞬間に
 *   呼ばれる(登録選手のような固定リストが無いため、/api/debug-status で
 *   「累計で何人の選手について知識を持つようになったか」を可視化するための
 *   軽量なカウンター用フック。失敗しても本処理には影響させない)。
 */
function createPlayerProfileEngine({ generateLLM, knowledgeStore, setRelation, onProfileGenerated }) {
  /**
   * @param {string} playerKey - knowledgeStoreの主キー(既存の"teamEn"フィールドを
   *   汎用の主体キーとして流用。例: "player:642"。クラブのteamEnと名前空間が
   *   衝突しないよう必ず"player:"プレフィックスを付ける)。
   */
  async function ensurePlayerProfile(playerKey, playerNameJa, playerNameEn, groundingFacts, nowIso, teamEnForRelation) {
    const existing = await knowledgeStore.getActiveKnowledge(playerKey);
    const existingProfile = existing.profiles && existing.profiles.length ? existing.profiles[0] : null;
    if (existingProfile) return { generated: false, profile: existingProfile };

    if (typeof generateLLM !== "function") {
      return { generated: false, profile: null, reason: "LLM_NOT_CONFIGURED" };
    }

    // 第5次監査での修正(clubProfileEngine.jsと同じ理由):
    //   実データが1件も無い状態でLLMに推定させ、それを知識として保存するのは
    //   「でっち上げない」原則に反する。実データが無ければ作らない。
    if (!groundingFacts || !groundingFacts.length) {
      return { generated: false, profile: null, reason: "NO_GROUNDING_DATA" };
    }

    const { systemPrompt, userPrompt } = buildPlayerProfilePrompt(playerNameJa, playerNameEn, groundingFacts || []);
    let parsed = null;
    try {
      const { text } = await generateLLM({ systemPrompt, userPrompt, maxTokens: 400 });
      parsed = parsePlayerProfileJson(text);
    } catch (e) {
      return { generated: false, profile: null, reason: `LLM_ERROR:${e.code || e.message}` };
    }
    if (!parsed) return { generated: false, profile: null, reason: "PARSE_FAILED" };
    // 第7次監査で発見した欠陥の修正:
    //   JSONとして解釈できさえすれば(例: `{}` や `{"error":"insufficient data"}`)
    //   中身が空文字だけのオブジェクトが返り、これは真値なので上のガードを素通りしていた。
    //   結果として「戦術スタイル: 不明 / フォーメーション傾向: 不明」という
    //   中身の無い文章が知識として保存され、
    //     ・「今日追加した知識」として1件数えられ(成長の水増し)
    //     ・利用者には「📊 根拠にした事実」として提示され
    //     ・60日間は再生成もされない
    //   という三重の害があった。実質的に空の応答は失敗として扱う。
    if (!String(parsed.playstyle || "").trim()) {
      return { generated: false, profile: null, reason: "EMPTY_RESPONSE" };
    }

    const statement = [
      `【AIによる推定・プレースタイル】${parsed.playstyle || "不明"}`,
      parsed.traits.length ? `特徴: ${parsed.traits.join("、")}` : null,
      parsed.strengths.length ? `長所: ${parsed.strengths.join("、")}` : null,
      parsed.weaknesses.length ? `短所: ${parsed.weaknesses.join("、")}` : null,
    ].filter(Boolean).join(" / ");

    const item = {
      teamEn: playerKey, teamJa: playerNameJa, category: "playerProfile", type: "profile",
      statement, detail: parsed, isAiGenerated: true,
      computedAt: nowIso, source: "AIによる推定(API-Footballの実成績データを参考情報として使用。公式のスカウティングレポートではありません)",
    };
    const result = await knowledgeStore.saveKnowledgeItem(item);

    // Knowledge Graph: 「この選手は◯◯クラブに所属」という関係を記録する
    // (team→(所属選手)は逆引きができない制約があるため、player→teamの一方向のみ)。
    if (result.saved && typeof setRelation === "function" && teamEnForRelation) {
      setRelation("player", playerKey, "club", "team", teamEnForRelation).catch(() => {});
    }
    if (result.saved && typeof onProfileGenerated === "function") {
      try { onProfileGenerated(playerKey); } catch (e) { /* ベストエフォート */ }
    }

    return { generated: true, saved: result.saved, profile: { ...item, hash: result.hash } };
  }

  return { ensurePlayerProfile };
}

module.exports = { createPlayerProfileEngine, buildPlayerProfilePrompt, parsePlayerProfileJson };
