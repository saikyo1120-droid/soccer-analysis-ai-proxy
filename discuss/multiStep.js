/**
 * server/discuss/multiStep.js
 * ------------------------------------------------
 * 2026年8月18日・v47「会話を多段思考に」(利用者の選択③)。
 *
 * ■ これまでの1段構成の弱点(実測に基づく診断)
 *   質問 → (ルールベースの計画) → 対象クラブ1つ分のデータ取得 → LLM1回 → 回答。
 *   このため「レアルとバルサはどっちが強い?」のような比較の質問でも、
 *   実データは片方のクラブの分しか渡らず、もう片方は一般知識で答えていた。
 *
 * ■ 多段思考の構成(このファイル)
 *   ステージ1(計画): 軽量モデルに「回答の質を上げるために追加で取得すべき
 *     データ」を選ばせる(回答はまだ書かない)。出力は厳密なJSONのみ。
 *   ステージ2(実行): サーバー側が、許可済みのアクションだけを最大2件実行する。
 *     - club_knowledge: 別クラブの実データ取得(比較質問用。取得はAPI予算に計上)
 *     - own_prediction_history: AI自身の過去予測と的中実績(Redis読み出しのみ)
 *   ステージ3(統合): 従来どおりの回答生成へ、追加事実と「計画AIが特定した論点」を
 *     渡す(server.js側)。
 *
 * ■ 安全設計(でっち上げ防止・コスト暴走防止・劣化禁止)
 *   ・アクションはホワイトリスト方式。クラブ名は予測対象100クラブに限定して
 *     解決し、解決できない名前は実行しない(任意のAPI呼び出しをさせない)。
 *   ・計画のJSONが1文字でも壊れていたら、多段思考を諦めて従来の1段構成に
 *     フォールバックする(回答が返らなくなる経路は存在しない)。
 *   ・環境変数 DISCUSS_MULTISTEP=0 で完全に無効化できる(従来と同一の動作)。
 *   ・追加のLLM呼び出しはサイト全体の日次予算に正直に計上する(server.js側)。
 */
const { CLUB_UNIVERSE } = require("../learning/clubUniverse");

const MULTISTEP_MAX_ACTIONS = 2;
const ALLOWED_ACTION_TYPES = new Set(["club_knowledge", "own_prediction_history"]);

function isMultiStepEnabled() {
  return String(process.env.DISCUSS_MULTISTEP ?? "1") !== "0";
}

/** クラブ名(日本語/英語・大文字小文字問わず)を予測対象100クラブの中で解決する。 */
function resolveUniverseClub(name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return null;
  for (const c of CLUB_UNIVERSE) {
    if (c.nameEn.toLowerCase() === q || c.nameJa === String(name).trim()) return c;
  }
  // 部分一致(「バルサ」→FCバルセロナ 等は呼び名辞書を持たないため、
  // ここでは「含む」だけを許す。曖昧に2件以上当たる場合は解決しない=実行しない)
  const hits = CLUB_UNIVERSE.filter((c) =>
    c.nameEn.toLowerCase().includes(q) || c.nameJa.includes(String(name).trim()));
  return hits.length === 1 ? hits[0] : null;
}

function buildPlanPrompt(question, subject, factHeadings) {
  return [
    "あなたはサッカー考察AIの「調査計画」担当です。回答はまだ書きません。",
    "利用者の質問と、すでに手元にある情報を見て、回答の質を上げるために追加で取得すべきデータを選んでください。",
    "",
    `利用者の質問: 「${question}」`,
    `現在の考察対象: ${subject && subject.labelJa ? subject.labelJa : "(特定クラブなし)"}`,
    "すでに手元にある情報(見出しのみ):",
    (factHeadings && factHeadings.length ? factHeadings.map((h) => `- ${h}`).join("\n") : "- (なし)"),
    "",
    "使えるアクション(最大2つまで。不要なら空配列):",
    '1. {"type":"club_knowledge","club":"<クラブ名>"} — 別のクラブの実データ(フォーム・順位・怪我人など)を取得。比較の質問で有効。すでに手元にあるクラブには使わない。',
    '2. {"type":"own_prediction_history","club":"<クラブ名>"} — このAI自身がそのクラブに出した過去の予測と的中実績を読み出す。「AIの予想は当たるの?」等で有効。',
    "",
    "出力は次の1行のJSONだけ。説明文・コードブロック・改行装飾は禁止:",
    '{"actions":[{"type":"...","club":"..."}],"focusJa":"回答で最も重視すべき論点を1文で"}',
  ].join("\n");
}

/**
 * ステージ1: 計画。LLMの出力が厳密なJSONでなければ ok:false(フォールバック)。
 * 呼び出し側は ok:false のとき従来の1段構成をそのまま実行する。
 */
async function planExtraDataNeeds({ question, subject, factHeadings, generateLLM }) {
  let raw = "";
  try {
    const out = await generateLLM({
      systemPrompt: "出力は指定されたJSONのみ。それ以外の文字を1文字も出力しないでください。",
      userPrompt: buildPlanPrompt(question, subject, factHeadings),
      maxTokens: 300,
      tier: "light",
    });
    raw = String(out && out.text || "");
    // 前後の余計な文字(コードフェンス等)へ最低限の耐性を持たせるが、
    // JSON本体が壊れていたら潔く諦める(修復して誤読するより正直)。
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reason: "plan_not_json", raw: raw.slice(0, 200) };
    const parsed = JSON.parse(m[0]);
    if (!parsed || !Array.isArray(parsed.actions)) return { ok: false, reason: "plan_bad_shape", raw: raw.slice(0, 200) };
    const actions = [];
    for (const a of parsed.actions) {
      if (actions.length >= MULTISTEP_MAX_ACTIONS) break;
      if (!a || !ALLOWED_ACTION_TYPES.has(a.type)) continue;
      const club = resolveUniverseClub(a.club);
      if (!club) continue; // 解決できないクラブは実行しない(勝手なAPI呼び出し防止)
      // すでに考察対象として取得済みのクラブのclub_knowledgeは重複なので除く
      if (a.type === "club_knowledge" && subject && subject.labelEn
        && club.nameEn.toLowerCase() === String(subject.labelEn).toLowerCase()) continue;
      if (actions.some((x) => x.type === a.type && x.club.nameEn === club.nameEn)) continue;
      actions.push({ type: a.type, club });
    }
    return {
      ok: true,
      actions,
      focusJa: typeof parsed.focusJa === "string" ? parsed.focusJa.slice(0, 200) : null,
    };
  } catch (e) {
    return { ok: false, reason: `plan_failed:${e.code || e.message}`, raw: raw.slice(0, 200) };
  }
}

/**
 * ステージ2: 実行。deps注入でテスト可能にする。
 * 返り値: { addedFacts: string[], executed: [{type, clubJa, ok, noteJa}] }
 */
async function executePlannedActions(actions, deps) {
  const { gatherClubKnowledge, formatClubFacts, defaultNeeds, upstashCmd } = deps || {};
  const addedFacts = [];
  const executed = [];
  for (const a of actions || []) {
    if (a.type === "club_knowledge") {
      try {
        if (typeof gatherClubKnowledge !== "function" || typeof formatClubFacts !== "function") throw new Error("deps_missing");
        const needs = (Array.isArray(defaultNeeds) && defaultNeeds.length) ? defaultNeeds : ["recentForm", "coach", "injuries"];
        const knowledge = await gatherClubKnowledge(a.club.nameEn, needs, a.club.nameJa);
        const clubFacts = formatClubFacts(knowledge, needs) || [];
        if (clubFacts.length) {
          clubFacts.slice(0, 8).forEach((f) => addedFacts.push(`[多段思考で追加取得: ${a.club.nameJa}] ${f}`));
          executed.push({ type: a.type, clubJa: a.club.nameJa, ok: true, noteJa: `${a.club.nameJa}の実データを${Math.min(clubFacts.length, 8)}件追加取得しました。` });
        } else {
          executed.push({ type: a.type, clubJa: a.club.nameJa, ok: false, noteJa: `${a.club.nameJa}の実データは取得できませんでした(取得失敗を推測で補うことはしません)。` });
        }
      } catch (e) {
        executed.push({ type: a.type, clubJa: a.club.nameJa, ok: false, noteJa: `${a.club.nameJa}のデータ取得でエラーが発生しました。` });
      }
    } else if (a.type === "own_prediction_history") {
      try {
        if (typeof upstashCmd !== "function") throw new Error("deps_missing");
        const rawList = await upstashCmd(["LRANGE", "learn:ownpred:recent", "-300", "-1"]);
        const records = (Array.isArray(rawList) ? rawList : [])
          .map((x) => { try { return JSON.parse(x); } catch { return null; } })
          .filter((r) => r && r.resolved === true);
        const nameLc = a.club.nameEn.toLowerCase();
        // v49: originTeamEn(予測を作った対象クラブ=このアプリの表記)も照合する。
        // 相手側の表記はAPI-Football由来でスペルが違うことがあるため
        // (例: Bayern Munich / Bayern München)、home/awayだけでは取りこぼす。
        const mine = records.filter((r) =>
          String(r.homeTeamEn || "").toLowerCase() === nameLc
          || String(r.awayTeamEn || "").toLowerCase() === nameLc
          || String(r.originTeamEn || "").toLowerCase() === nameLc);
        if (!mine.length) {
          addedFacts.push(`[AI自身の予測実績] ${a.club.nameJa}について答え合わせ済みの予測はまだありません(正直にお伝えします)。`);
          executed.push({ type: a.type, clubJa: a.club.nameJa, ok: true, noteJa: "答え合わせ済みの予測はまだありませんでした。" });
        } else {
          const hits = mine.filter((r) => r.correct === true).length;
          addedFacts.push(`[AI自身の予測実績] ${a.club.nameJa}が絡む答え合わせ済みの予測: ${mine.length}件中${hits}件的中(${Math.round((hits / mine.length) * 100)}%)。`);
          mine.slice(-3).reverse().forEach((r) => {
            const predJa = r.predictedWinner === "home" ? "ホーム勝ち" : r.predictedWinner === "away" ? "アウェイ勝ち" : "引き分け";
            const resJa = r.correct === true ? "的中" : "外れ";
            addedFacts.push(`[AI自身の予測実績] ${String(r.kickoff || "").slice(0, 10)} ${r.homeTeamEn}対${r.awayTeamEn}: ${predJa}と予想→${r.actualScore ? `実際${r.actualScore}` : "結果記録あり"}(${resJa})`);
          });
          executed.push({ type: a.type, clubJa: a.club.nameJa, ok: true, noteJa: `${mine.length}件の答え合わせ済み予測を根拠に追加しました。` });
        }
      } catch (e) {
        executed.push({ type: a.type, clubJa: a.club.nameJa, ok: false, noteJa: "予測実績の読み出しに失敗しました。" });
      }
    }
  }
  return { addedFacts, executed };
}

module.exports = {
  isMultiStepEnabled, planExtraDataNeeds, executePlannedActions,
  resolveUniverseClub, buildPlanPrompt, MULTISTEP_MAX_ACTIONS,
};
