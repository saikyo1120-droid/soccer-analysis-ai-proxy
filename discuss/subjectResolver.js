"use strict";
/**
 * v104(2026年11月12日)・会話⑥「対象の解決をサーバー側へ」+⑦「聞き返し」
 * ----------------------------------------------------------------------------
 * これまで「どのクラブの話か」は画面側の辞書(登録クラブ+UEFA TOP100 の正確な日本語表記)
 * だけで決めていた。辞書に無い表記(略称・英語・ひらがな・軽い誤字・学習で増えた
 * 292クラブ)は主題なし=実データ無しの一般論に落ちていた。
 *
 * ここでは、対戦分析(v59)が既に持っている名寄せ(matchupAnalysis.resolveClub:
 * 日本語別名表 → 正規化した完全一致 → 表記ゆらぎ → 特徴語の一意照合)を、自由文の
 * 質問にも使えるようにする。
 *   ・質問文から候補語(カタカナ連続・ラテン文字連続・辞書の日本語名の部分一致)を取り出す
 *   ・候補語ごとに resolveClub で1つのチームIDに解決する
 *   ・1つに定まらない語(候補2〜4件)は「聞き返し」の材料として返す(推測で決めない)
 * でっち上げ防止の原則(v59)はそのまま: 確実に1つに定まらないクラブは採用しない。
 * 外部APIは呼ばない(純関数。索引は呼び出し側が保存済みデータから渡す)。
 */
const matchupLib = require("../learning/matchupAnalysis");

// 「選手名・用語」としてよく出るカタカナ語は、クラブ候補から外す(無駄な照合を減らすだけ。
// 外しても resolveClub が一意に当てられなければ採用されないので、ここは網羅しなくてよい)
const NON_CLUB_WORDS = new Set([
  "サッカー", "フットボール", "クラブ", "チーム", "リーグ", "カップ", "シーズン", "スタメン", "フォーメーション",
  "ゴールキーパー", "キーパー", "ディフェンダー", "ミッドフィルダー", "フォワード", "ストライカー", "ウイング",
  "プレミアリーグ", "プレミア", "ラリーガ", "ブンデスリーガ", "ブンデス", "セリエ", "リーグアン", "チャンピオンズリーグ",
  "ヨーロッパリーグ", "ワールドカップ", "ユーロ", "データ", "オッズ", "スコア", "ポゼッション", "カウンター", "プレス",
  "ハイプレス", "ビルドアップ", "セットプレー", "コンディション", "モチベーション", "ランキング", "レーティング",
  "ホーム", "アウェイ", "アウェー", "ダービー", "トップ", "ベスト", "スタイル", "タイプ", "レベル", "パス", "ドリブル",
  "シュート", "クロス", "ヘディング", "オフサイド", "ファウル", "イエローカード", "レッドカード", "ハットトリック",
]);

/** 質問文からクラブ名の候補語を取り出す(長い語から順に)。複合語は分割しない(「インテル・マイアミ」を「インテル」にしない) */
function extractCandidateTokens(question) {
  const q = String(question || "");
  const out = [];
  const seen = new Set();
  const push = (t) => { const s = String(t || "").trim(); if (s.length >= 3 && !seen.has(s) && !NON_CLUB_WORDS.has(s)) { seen.add(s); out.push(s); } };
  // カタカナ連続(・で繋がる複合語は1語として扱い、要素には分けない=別クラブへの化けを防ぐ)
  (q.match(/[ァ-ヶー]+(?:[・･][ァ-ヶー]+)*/g) || []).forEach(push);
  // ラテン文字(最大3語の連なり。"Real Madrid", "Man City", "PSG")。単語への分割は後段(全体が解決しないときだけ)
  const latin = [];
  (q.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*){0,2}/g) || []).forEach((t) => { push(t); latin.push(t); });
  const sorted = out.sort((a, b) => b.length - a.length);
  // 分割候補(全体で解決できなかったときの予備。単語は長さ4以上)
  const parts = [];
  for (const t of latin) {
    const words = t.split(/\s+/).filter((w) => w.length >= 4);
    if (words.length > 1) { parts.push(words.slice(0, 2).join(" ")); words.forEach((w) => parts.push(w)); }
  }
  return { tokens: sorted, parts: parts.filter((w) => !seen.has(w) && !NON_CLUB_WORDS.has(w)) };
}

const KATA_RE = /[ァ-ヶー]/;
/** 語の境界: 辞書のキーの直前・直後がカタカナなら「別の名前の一部」とみなして採用しない */
function boundaryOk(key, idx, k) {
  const before = idx > 0 ? key.charAt(idx - 1) : "";
  const after = key.charAt(idx + k.length);
  if (before && KATA_RE.test(before) && KATA_RE.test(k.charAt(0))) return false;
  if (after && KATA_RE.test(after) && KATA_RE.test(k.charAt(k.length - 1))) return false;
  return true;
}

/**
 * 辞書の日本語名・別名が質問文に含まれていれば、その英語名を返す(質問文での出現順)。
 * @param {string} question
 * @param {Map<string,{nameEn:string,nameJa:string|null}>} jaMap
 */
function dictionaryHits(question, jaMap) {
  const key = matchupLib.jaKey(question);
  if (!key || !jaMap) return [];
  const hits = [];
  for (const [k, v] of jaMap.entries()) {
    if (k.length < 2) continue;
    let from = 0;
    for (;;) {
      const idx = key.indexOf(k, from);
      if (idx === -1) break;
      if (boundaryOk(key, idx, k)) { hits.push({ key: k, pos: idx, nameEn: v.nameEn, nameJa: v.nameJa || null }); break; }
      from = idx + 1;
    }
  }
  hits.sort((a, b) => (a.pos - b.pos) || (b.key.length - a.key.length));
  // 同じ英語名・同じ位置から始まる短いキー(「レアル」と「レアルマドリード」)の重複を除く
  const seen = new Set();
  const out = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (seen.has(h.nameEn)) continue;
    if (h.pos < lastEnd) continue; // 直前に採用した長いキーの内側
    seen.add(h.nameEn);
    out.push(h);
    lastEnd = h.pos + h.key.length;
  }
  return out;
}

/**
 * 辞書のキーのうち、候補語を**先頭に持つ**もの(「マンチェスター」→ マンチェスター・シティ / ・ユナイテッド、
 * 「鹿島」→ 鹿島アントラーズ)。1件なら解決、2〜4件なら聞き返しの材料。
 */
function prefixCandidates(token, jaMap) {
  const tk = matchupLib.jaKey(token);
  if (!tk || tk.length < 2 || !jaMap) return [];
  const byEn = new Map();
  for (const [k, v] of jaMap.entries()) {
    if (k === tk || !k.startsWith(tk)) continue;
    if (!byEn.has(v.nameEn)) byEn.set(v.nameEn, { nameEn: v.nameEn, nameJa: v.nameJa || null, key: k });
  }
  return [...byEn.values()];
}

const KANJI_RE = /^[一-龥]{2,}/;
/**
 * 漢字で始まる辞書キー(J1 等)の先頭漢字列が質問文に含まれるものを集める。
 * @returns {Array<[token:string, candidates:Array<{nameEn,nameJa}>]>}
 */
function kanjiPrefixCandidates(question, jaMap) {
  const q = String(question || "");
  const byToken = new Map();
  if (!jaMap) return [];
  for (const v of jaMap.values()) {
    const nameJa = v && v.nameJa;
    if (!nameJa) continue;
    const m = String(nameJa).match(KANJI_RE);
    if (!m) continue;
    const token = m[0];
    const idx = q.indexOf(token);
    if (idx === -1) continue;
    const after = q.charAt(idx + token.length);
    if (after && /[一-龥]/.test(after)) continue; // 「鹿島」の後にさらに漢字が続く=別の語
    if (!byToken.has(token)) byToken.set(token, new Map());
    const mp = byToken.get(token);
    if (!mp.has(v.nameEn)) mp.set(v.nameEn, { nameEn: v.nameEn, nameJa: String(nameJa) });
  }
  return [...byToken.entries()].map(([token, mp]) => [token, [...mp.values()]]);
}

/**
 * 自由文の質問から主題(クラブ)を解決する。
 * @param {string} question
 * @param {{index:Array<{id:number,name:string}>, jaMap:Map, ratedIds?:Set}} ctx - loadMatchupContext() と同形
 * @returns {{
 *   subject: {type:"club", labelJa:string|null, labelEn:string, teamId:number}|null,
 *   clubs: Array<{labelJa:string|null, labelEn:string, teamId:number}>,
 *   clarify: {token:string, candidates:string[]}|null,
 *   method: string
 * }}
 */
function resolveSubjectFromQuestion(question, ctx) {
  const empty = { subject: null, clubs: [], clarify: null, method: "none" };
  const q = String(question || "").trim();
  if (!q || !ctx || !Array.isArray(ctx.index) || !ctx.index.length) return empty;
  const jaMap = ctx.jaMap || matchupLib.buildJaMap();
  const clubs = [];
  const seenIds = new Set();
  const addClub = (r, nameJaHint) => {
    if (!r || !r.ok || seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    clubs.push({ labelJa: r.nameJa || nameJaHint || null, labelEn: r.name, teamId: r.id });
    return true;
  };
  let method = "none";
  // ① 辞書(日本語名・別名)の語境界つき部分一致 → 英語名で索引を引く(質問文での出現順)
  for (const h of dictionaryHits(q, jaMap)) {
    const r = matchupLib.resolveClub(h.nameEn, ctx);
    if (r.ok && addClub(r, h.nameJa) && method === "none") method = "dictionary";
  }
  // ② カタカナ・ラテン文字の候補語を順に名寄せ(曖昧な語は聞き返しの材料に)
  let clarify = null;
  const noteClarify = (token, candidates) => {
    if (clarify || clubs.length) return;
    const uniq = [...new Set((candidates || []).filter(Boolean))];
    if (uniq.length >= 2) clarify = { token, candidates: uniq.slice(0, 4) };
  };
  const { tokens, parts } = extractCandidateTokens(q);
  // ③ 漢字で始まる名前(鹿島アントラーズ・浦和レッズ・横浜F・マリノス)は、先頭の漢字の連なりだけで聞かれることが多い
  //   (「鹿島の監督は?」)。辞書のキーの先頭漢字列が質問に含まれ、1クラブに定まるときだけ採用(2〜4件なら聞き返し)。
  for (const [token, cands] of kanjiPrefixCandidates(q, jaMap)) {
    if (cands.length === 1) {
      const r = matchupLib.resolveClub(cands[0].nameEn, ctx);
      if (r.ok && addClub(r, cands[0].nameJa) && method === "none") method = "kanji-prefix";
    } else if (cands.length >= 2 && cands.length <= 4) noteClarify(token, cands.map((c) => c.nameJa || c.nameEn));
  }
  const tryToken = (token) => {
    const r = matchupLib.resolveClub(token, ctx);
    if (r.ok) { if (addClub(r) && method === "none") method = "token"; return true; }
    if (r.reason === "ambiguous") { noteClarify(token, r.candidates); return false; }
    // 辞書のキーを先頭に持つ名前(「マンチェスター」「鹿島」)
    const pc = prefixCandidates(token, jaMap);
    if (pc.length === 1) {
      const r2 = matchupLib.resolveClub(pc[0].nameEn, ctx);
      if (r2.ok) { if (addClub(r2, pc[0].nameJa) && method === "none") method = "prefix"; return true; }
    } else if (pc.length >= 2 && pc.length <= 4) {
      noteClarify(token, pc.map((c) => c.nameJa || c.nameEn));
    }
    return false;
  };
  for (const token of tokens) tryToken(token);
  if (!clubs.length) for (const w of parts) tryToken(w);
  if (clubs.length) clarify = null; // 1つでも確定したクラブがあれば聞き返さない(確定分で答える)
  const subject = clubs.length ? { type: "club", labelJa: clubs[0].labelJa, labelEn: clubs[0].labelEn, teamId: clubs[0].teamId } : null;
  return { subject, clubs, clarify, method: clubs.length ? method : (clarify ? "ambiguous" : "none") };
}

/** 聞き返しの文(日本語原文。画面側の辞書が他言語へ訳す) */
function clarifyMessageJa(clarify) {
  if (!clarify) return null;
  return `「${clarify.token}」はどのクラブのことでしょうか?(候補: ${clarify.candidates.join(" / ")})`;
}

module.exports = { extractCandidateTokens, dictionaryHits, prefixCandidates, kanjiPrefixCandidates, resolveSubjectFromQuestion, clarifyMessageJa, NON_CLUB_WORDS };
