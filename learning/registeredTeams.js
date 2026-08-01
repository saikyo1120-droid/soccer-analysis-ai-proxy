/**
 * server/learning/registeredTeams.js
 * ------------------------------------------------
 * 「毎日学習エンジン(Learning Engine)」が実際にAPI-Footballへ問い合わせに行く
 * クラブの一覧。新しく発明したリストではなく、index.html の CLUB_JA_TO_EN
 * (議論モードのRAGが選手・クラブ名を英語名に変換するために元々使っている表)を
 * そのままサーバー側に写したものです(フロントエンドとサーバーで二重管理になる点は
 * 認識していますが、選手データ全体(PLAYERS)をサーバー側に持ち込むほどの規模では
 * ないため、まずはクラブ名一覧だけをここに複製する形にしています)。
 *
 * 意図的に絞っている理由: API-Football無料プランは1日100リクエストが上限のため、
 * 毎日のバッチ処理(学習エンジン)が使うクラブ数を絞ることで、通常のユーザーの
 * 利用分の余力を残しています(1クラブあたり数リクエストなので、11クラブなら
 * 数十リクエスト程度に収まる設計です)。
 */
const REGISTERED_TEAMS = [
  { nameJa: "バイエルン・ミュンヘン", nameEn: "Bayern Munich" },
  { nameJa: "アーセナルFC", nameEn: "Arsenal" },
  { nameJa: "レアル・マドリード", nameEn: "Real Madrid" },
  { nameJa: "マンチェスター・シティ", nameEn: "Manchester City" },
  { nameJa: "ナポリ", nameEn: "Napoli" },
  { nameJa: "FCバルセロナ", nameEn: "Barcelona" },
  { nameJa: "レアル・ソシエダ", nameEn: "Real Sociedad" },
  { nameJa: "インテル・マイアミ", nameEn: "Inter Miami" },
  { nameJa: "アル・ナスル", nameEn: "Al-Nassr" },
  { nameJa: "パリ・サンジェルマン", nameEn: "Paris Saint Germain" },
  { nameJa: "インテル・ミラン", nameEn: "Inter" },
];

module.exports = { REGISTERED_TEAMS };
