"use strict";
/**
 * v104(2026年11月12日)・会話①「質問の種類に合わせた答え方」
 * ----------------------------------------------------------------------------
 * これまで /api/discuss はどんな質問にも同じ7欄(一般論/AI独自の意見/反対意見/最終結論/
 * 今後/最も重要/フォローアップ)で答えていた。「オフサイドって何?」にも7欄の論文が返る。
 * ここでは質問文を機械的なルールで5種類に分け、種類ごとに出力の型を変える:
 *   smalltalk  … 挨拶・お礼・感想(短く自然に。サッカーの話題を1つ添える)
 *   offtopic   … サッカーと無関係(丁寧に断って話題を提案)
 *   fact       … 事実・用語・一覧の質問(見出し無しで1〜4文。実データの数字を引用)
 *   prediction … 予想・勝敗・スコア・確率の質問(予想/根拠/注意/フォローアップ)
 *   discussion … 意見・仮説・議論(従来どおりの7欄)
 * ルールは LLM を使わない(費用ゼロ・決定的・テストで固定できる)。迷ったら fact。
 * 4言語(日本語・英語・中文・スペイン語)の言い回しを含める(画面の言語設定と独立に
 * 質問文そのものから判定する)。
 */

const MODES = ["smalltalk", "offtopic", "fact", "prediction", "discussion"];

// 挨拶・お礼(文全体が短いときだけ)
const SMALLTALK_RE = /^(こんにちは|こんばんは|おはよう|おはようございます|やあ|はじめまして|ありがとう|ありがとうございます|ありがと|助かった|助かります|よろしく|お疲れ様|おつかれ|元気\?|元気？|調子はどう|hi|hello|hey|thanks|thank you|thx|good (morning|evening|afternoon)|how are you|hola|buenos días|buenas|gracias|muchas gracias|你好|您好|谢谢|早上好|晚上好|hallo)(?![a-z])[!！。、.,\s]*[^\n]{0,24}$/i;

// サッカーと明らかに無関係な話題(短い語で確実に分かるものだけ。網羅はしない=残りは回答AIが判断)
const OFFTOPIC_RE = /(天気|天気予報|気温|株価|株式|為替|ビットコイン|仮想通貨|料理|レシピ|献立|宿題|数学の|英語の宿題|恋愛|占い|政治|選挙|野球|バスケ|テニス|ゴルフ|将棋|囲碁|映画のおすすめ|アニメのおすすめ|weather|stock price|bitcoin|recipe|homework|baseball|basketball|tennis|golf|天气|股票|菜谱|作业|棒球|篮球|clima|receta|tarea|béisbol|baloncesto)/i;

// 予想・勝敗・スコア・確率
const PREDICTION_RE = /(勝つ|勝てる|勝敗|勝率|予想|予測|見立て|スコア|何点|何対|オッズ|的中|当た(る|り)|引き分け|負ける|どっちが(勝|強|有利)|どちらが(勝|強|有利)|有利|不利|forecast|predict|prediction|who (will|would) win|who wins|win(s|ning)? (today|tonight|tomorrow)|scoreline|score prediction|odds|likely to win|chances?|probability|¿?quién (gana|ganará)|pronóstico|predicción|probabilidad|marcador|预测|谁会赢|谁能赢|比分|胜率|赔率)/i;

// 意見・仮説・議論(画面側 isDiscussionTrigger と同じ系統+英中西)
const DISCUSSION_RE = /(と思(う|います)|どう思(う|います)|気がする|ではないか|ではないでしょうか|もし.{0,20}(たら|なら)|なぜ|何故|本当に|意見|考察|議論|評価して|どう(です|だ)か\?|どう(です|だ)か？|賛成|反対|what do you think|do you think|why\b|really\b|your (opinion|view|take)|should\b|would you|agree|debate|argue|overrated|underrated|你觉得|你认为|为什么|真的|意见|讨论|qué opinas|crees que|por qué|realmente|opinión|debat)/i;

// AI自身の記録(外した理由・的中率・反省・答え合わせ)についての質問は、意見ではなく実測の照会なので fact(道具で取る)
const SELF_RECORD_RE = /(外した|外れた|外れの|外れは|外れ理由|的中率|的中した|当たった|当たり率|反省|答え合わせ|予想の成績|予想は当た|hit rate|accuracy|missed|wrong prediction|why (did|was) (the|your) (prediction|forecast)|预测.*(错|准)|命中率|acert|precisión de las predicciones)/i;

// 事実の聞き方(明示)。prediction/discussion に当たらなければ既定で fact なので、ここは優先度の判断にだけ使う
const FACT_HINT_RE = /(とは|って何|って誰|誰|何人|何歳|いつ|どこ|何回|何位|監督は|所属|ルール|意味|教えて|一覧|リスト|what is|who is|when|where|how many|how old|which team|rule|meaning|explain|什么是|谁是|多少|哪里|什么时候|qué es|quién es|cuándo|dónde|cuántos|explica)/i;

/**
 * @param {string} question
 * @param {{subject?:{type:string|null}, hasMatchContext?:boolean}} [ctx]
 * @returns {{mode:string, reasonJa:string}}
 */
function classifyIntent(question, ctx) {
  const q = String(question || "").trim();
  const c = ctx || {};
  if (!q) return { mode: "fact", reasonJa: "質問文が空のため既定(事実)" };
  const compact = q.replace(/\s+/g, " ");
  if (compact.length <= 40 && SMALLTALK_RE.test(compact)) return { mode: "smalltalk", reasonJa: "挨拶・お礼の短い文" };
  const soccerish = /(サッカー|試合|クラブ|選手|リーグ|監督|ゴール|得点|フォーメーション|戦術|football|soccer|match|club|player|league|coach|goal|足球|比赛|球员|联赛|fútbol|partido|jugador|liga)/i.test(compact)
    || !!(c.subject && c.subject.type);
  if (!soccerish && OFFTOPIC_RE.test(compact)) return { mode: "offtopic", reasonJa: "サッカーと無関係な話題の語を含む" };
  if (SELF_RECORD_RE.test(compact)) return { mode: "fact", reasonJa: "AI自身の記録(外した理由・的中率・反省)の照会" };
  const isPred = PREDICTION_RE.test(compact);
  const isDisc = DISCUSSION_RE.test(compact);
  if (isPred && (!isDisc || !!(c.subject && c.subject.type) || c.hasMatchContext === true)) {
    return { mode: "prediction", reasonJa: isDisc ? "予想の語と意見の語が両方あるが、対象(クラブ・試合)が特定できるため予想として扱う" : "予想・勝敗・スコアの語を含む" };
  }
  if (isDisc) return { mode: "discussion", reasonJa: "意見・仮説・議論の言い回しを含む" };
  if (compact.length >= 90 && /[。.!?！？]/.test(compact.slice(0, -1))) return { mode: "discussion", reasonJa: "複数の文からなる長い問い(議論として扱う)" };
  return { mode: "fact", reasonJa: FACT_HINT_RE.test(compact) ? "事実・用語の聞き方" : "既定(事実の問い)" };
}

/** 出力の型(見出しマーカー)。discussion は従来の7欄(server.js の buildDiscussSystemPrompt が担当) */
const PREDICTION_LABELS = ["予想", "根拠", "注意", "フォローアップ"];

/** prediction / fact / smalltalk / offtopic 用の出力指示(system prompt の末尾に付ける) */
function formatInstructionsFor(mode, lang) {
  const nonJa = lang && lang !== "ja";
  const marker = nonJa ? "見出しマーカー(###で挟まれた行)は画面の解析に使う機械用の目印です。一字も変えず日本語のまま出力し、中身の文章だけを回答言語で書いてください。" : "";
  if (mode === "prediction") {
    return [
      "必ず次の形式で出力してください。見出し以外の余計な文章は含めないでください。",
      marker,
      "",
      "###予想###",
      "(1〜2文。どちらが有利か、確率(%)、確信度(高/中/低)。実データに予想が無い試合は『この試合のAI予想は保存されていません』と正直に書く)",
      "",
      "###根拠###",
      "(2〜5文。道具や事実にある数字(確率・フォーム・順位・怪我人・市場オッズ・主力評価点)を必ず引用して説明する。無い数字は作らない)",
      "",
      "###注意###",
      "(1〜3文。引き分けの可能性・スタメン未確定・データ不足・学習していない大会など、予想を割り引くべき点。無ければ「特になし」)",
      "",
      "###フォローアップ###",
      "(続けて聞けそうな質問を1〜2個、1行に1つずつ)",
    ].filter((l) => l !== null).join("\n");
  }
  if (mode === "smalltalk") {
    return "挨拶や雑談には1〜2文で自然に返し、最後にサッカーの話題(今日の試合・気になるクラブや選手など)を1つだけ軽く提案してください。見出しは使わないでください。";
  }
  if (mode === "offtopic") {
    return "あなたはサッカー分析AIです。サッカーと無関係な質問には、1〜2文で正直に「サッカー以外はお答えできない」旨を伝え、代わりにサッカーの話題を1〜2個提案してください。見出しは使わず、無理にサッカーへこじつけないでください。";
  }
  // fact
  return [
    "事実・用語・一覧の質問です。見出しは使わず、1〜4文(一覧なら箇条書き可)で質問に正面から答えてください。",
    "道具や事実にある数字・固有名詞だけを使い、無いものは「取得できません」「データにありません」と正直に書いてください(推測で埋めない)。",
    "利用者の詳しさ設定が「初心者」なら専門用語を避けて一言で補足し、「専門」なら数字を中心に簡潔に。",
    "続けて聞けそうな質問があれば、最後に「###フォローアップ###」の見出しの後に1〜2個(1行に1つ)書いてもよい(任意)。",
    marker,
  ].filter(Boolean).join("\n");
}

/** prediction モードの出力を4欄に分ける(見出しが無ければ全文を prediction に入れ parsedOk:false) */
function parsePredictionOutput(rawText) {
  const text = String(rawText || "");
  const grab = (label, nextLabels) => {
    const startIdx = text.indexOf(`###${label}###`);
    if (startIdx === -1) return "";
    let end = text.length;
    for (const n of nextLabels) {
      const idx = text.indexOf(`###${n}###`, startIdx + 1);
      if (idx !== -1 && idx < end) end = idx;
    }
    return text.slice(startIdx + label.length + 6, end).trim();
  };
  const prediction = grab("予想", PREDICTION_LABELS.slice(1));
  const basis = grab("根拠", PREDICTION_LABELS.slice(2));
  const caution = grab("注意", PREDICTION_LABELS.slice(3));
  const followRaw = grab("フォローアップ", []);
  const parsedOk = !!(prediction || basis);
  const followUpQuestions = splitFollowups(followRaw);
  if (!parsedOk) {
    return { prediction: stripMarkers(text), basis: "", caution: "", followUpQuestions, parsedOk: false };
  }
  return { prediction, basis, caution, followUpQuestions, parsedOk: true };
}

/** fact / smalltalk / offtopic の出力: 本文(見出し無し)と任意のフォローアップ */
function parsePlainOutput(rawText) {
  const text = String(rawText || "");
  const fIdx = text.indexOf("###フォローアップ###");
  const body = fIdx === -1 ? text : text.slice(0, fIdx);
  const followRaw = fIdx === -1 ? "" : text.slice(fIdx + "###フォローアップ###".length);
  return { answerText: stripMarkers(body).trim(), followUpQuestions: splitFollowups(followRaw) };
}

function splitFollowups(raw) {
  return String(raw || "").split("\n").map((s) => s.replace(/^[・\-\d.、\s]+/, "").trim()).filter(Boolean).slice(0, 2);
}

function stripMarkers(text) {
  return String(text || "").replace(/###[^#\n]{1,20}###/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { MODES, classifyIntent, formatInstructionsFor, parsePredictionOutput, parsePlainOutput, PREDICTION_LABELS, SMALLTALK_RE, PREDICTION_RE, DISCUSSION_RE, OFFTOPIC_RE, SELF_RECORD_RE };
