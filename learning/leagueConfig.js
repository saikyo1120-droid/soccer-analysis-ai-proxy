/**
 * server/learning/leagueConfig.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑥「主要リーグのKnowledge Engine日次蓄積」で使う、
 * 対象リーグの一覧と、リーグIDの解決ヘルパー。
 *
 * ご要望の原文: 「最低でも欧州5大リーグ(プレミアリーグ・ラ・リーガ・
 * ブンデスリーガ・セリエA・リーグ・アン)の情報は毎日取得してください」。
 * これを「必須(MANDATORY_LEAGUES、毎日必ず取得)」とし、ご要望にあったそれ以外の
 * 5リーグ(ブラジル・チャンピオンシップ・ポルトガル・MLS・トルコ)は
 * 「拡張(EXTENDED_LEAGUES、ローテーションで取得)」として区別する。
 *
 * なぜ分けるか(API予算): API-Football無料プラン(1日100リクエスト)を
 * 前提にすると、リーグ1つあたり3リクエスト(順位表/得点ランキング/
 * アシストランキング)なので、10リーグを毎日フル取得すると30リクエストに
 * なる。既存の学習ループ(登録11クラブの日次分析等)だけで最大50〜70
 * リクエスト/日を使っているため、10リーグ×毎日では無料枠を超えるリスクが
 * 高い。必須5リーグ(15リクエスト/日)は毎日確実に取得しつつ、残り5リーグは
 * ROTATION_CAP件/日のローテーションで数日かけて一巡させることで、
 * 「毎日」の要件は必須5リーグで満たしつつ、それ以外もカバーする設計にした。
 *
 * リーグIDについて: 欧州5大リーグのID(39/140/78/135/61)は、このコードベース
 * (server/server.js の DEFAULT_LEAGUES/SEARCH_LEAGUES)で既に使われ、実際の
 * API-Footballへの問い合わせで動作確認済みの値をそのまま再利用している
 * (新たに数字を決め打ちしていない)。一方、拡張5リーグのIDはこのコードベースで
 * 未確認("メジャーリーグ・サッカー"=253はSEARCH_LEAGUESで確認済みのためそのまま
 * 使うが、それ以外は確証が無い)。誤ったIDを決め打ちすると「存在しないリーグの
 * データを取得しようとして常に空振りする」というでっち上げに近い不具合になり
 * かねないため、IDが未確認のリーグは resolveLeagueId() で
 * API-Football自身の /leagues?name=&country= 検索によって解決し(resolveTeamIdと
 * 同じ設計思想)、解決できたIDはUpstashに永続キャッシュする(リーグIDは通常
 * 変わらないため、一度解決すれば以後は追加のAPI呼び出し無し)。
 */

// ---- 必須: 欧州5大リーグ(毎日必ず取得) ----
const MANDATORY_LEAGUES = [
  { id: 39, nameJa: "プレミアリーグ", nameEn: "Premier League", countryJa: "イングランド" },
  { id: 140, nameJa: "ラ・リーガ", nameEn: "La Liga", countryJa: "スペイン" },
  { id: 78, nameJa: "ブンデスリーガ", nameEn: "Bundesliga", countryJa: "ドイツ" },
  { id: 135, nameJa: "セリエA", nameEn: "Serie A", countryJa: "イタリア" },
  { id: 61, nameJa: "リーグ・アン", nameEn: "Ligue 1", countryJa: "フランス" },
];

// ---- 拡張: それ以外にご要望にあった5リーグ(ローテーションで取得) ----
const EXTENDED_LEAGUES = [
  { id: 253, nameJa: "メジャーリーグ・サッカー", nameEn: "MLS", countryJa: "アメリカ", searchCountry: "USA" },
  { id: null, nameJa: "カンピオナート・ブラジレイロ・セリエA", nameEn: "Serie A", countryJa: "ブラジル", searchCountry: "Brazil" },
  { id: null, nameJa: "チャンピオンシップ", nameEn: "Championship", countryJa: "イングランド", searchCountry: "England" },
  { id: null, nameJa: "プリメイラ・リーガ", nameEn: "Primeira Liga", countryJa: "ポルトガル", searchCountry: "Portugal" },
  { id: null, nameJa: "スュペル・リグ", nameEn: "Super Lig", countryJa: "トルコ", searchCountry: "Turkey" },
];

// リーグ名がEXTENDED_LEAGUESの中で複数(例: "Serie A"はイタリアとブラジルの
// 両方に存在する)重複しうるため、Knowledge Engineのentity key・キャッシュ
// キーには必ず「国名も含めた」識別子を使う(nameEnだけで一意とみなさない)。
function leagueEntityKey(league) {
  return `${league.nameEn} (${league.countryJa})`;
}

// API-Football自身の/leagues検索でIDを解決する(resolveTeamIdと同じ設計)。
// 解決できたIDはUpstashに永続キャッシュし、以後は再解決しない。
async function resolveLeagueId(league, { callApiFootball, upstashGetJSON, upstashSetJSON, upstashEnabled }) {
  if (league.id) return league.id;
  const cacheKey = `learn:leagueid:${league.nameEn}:${league.searchCountry || league.countryJa}`;
  if (upstashEnabled) {
    const cached = await upstashGetJSON(cacheKey).catch(() => null);
    if (cached && cached.id) return cached.id;
  }
  try {
    const data = await callApiFootball("/leagues", { name: league.nameEn, country: league.searchCountry || undefined });
    const list = (data && data.response) || [];
    const found = list.find((row) => row && row.league) || null;
    const id = found ? found.league.id : null;
    if (id && upstashEnabled) {
      await upstashSetJSON(cacheKey, { id, resolvedAt: new Date().toISOString() }).catch(() => {});
    }
    return id;
  } catch (e) {
    return null;
  }
}

module.exports = { MANDATORY_LEAGUES, EXTENDED_LEAGUES, leagueEntityKey, resolveLeagueId };
