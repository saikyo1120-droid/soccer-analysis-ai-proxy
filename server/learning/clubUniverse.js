/**
 * server/learning/clubUniverse.js
 * ------------------------------------------------
 * 2026年8月・「知識量を大幅に増やす」フェーズ(ご指示①)の土台。
 * UEFAクラブランキング上位100クラブを「知識の対象宇宙(universe)」として定義する。
 *
 * ■ UEFAランキングについての正直な注記(重要)
 *   UEFAのクラブ係数ランキングは、契約中のAPI-Footballからは取得できません
 *   (該当エンドポイントが存在しない)。そのためこの一覧は、2025年時点の
 *   UEFA係数に基づく**静的なスナップショット**です。
 *     ・順位(uefaRankSnapshot)は目安であり、最新の公式順位ではありません。
 *       表示するときは必ず「スナップショット」であることを添えます。
 *     ・クラブの顔ぶれ(欧州上位100)は年単位でしか大きく変わらないため、
 *       「どのクラブを毎日学ぶか」を決める用途には十分正確です。
 *     ・最新の正確な順位が必要になった場合は、UEFA公式サイトを情報源に
 *       追加する必要があります(README参照)。
 *
 * ■ リーグIDについての正直な注記
 *   leagueId は、このコードベースで実際に動作確認済みのID
 *   (39/140/78/135/61/88/94/144/203/253)だけを静的に持ちます。
 *   それ以外のリーグは null とし、実行時に各クラブの直近試合から
 *   inferLeagueIdFromFixtures() で逆算します(誤ったIDの決め打ちをしないため)。
 *
 * ■ 更新頻度の階層(ご指示の「追加のおすすめ」に対応)
 *   tier A(1〜40位)  : 毎日更新(フォーム・怪我・監督/布陣)
 *   tier B(41〜100位): 2日に1回の輪番で更新
 *   選手名簿(squad)   : 全クラブを7日周期の輪番で更新
 *   選手の詳細成績     : 予算の許す範囲で毎日数百人ずつ輪番
 *   xG               : tier Aのみ7日周期の輪番(1クラブ5リクエストと高価なため)
 *   ほぼ変わらない情報(創設年・スタジアム等): 月1回の輪番
 */

// nameEn は API-Football の /teams?search で解決できる英語名。
// nameJa は画面表示用。leagueId は動作確認済みのもののみ(それ以外は null)。
const CLUB_UNIVERSE = [
  { rank: 1, nameEn: "Real Madrid", nameJa: "レアル・マドリード", country: "スペイン", leagueId: 140 },
  { rank: 2, nameEn: "Manchester City", nameJa: "マンチェスター・シティ", country: "イングランド", leagueId: 39 },
  { rank: 3, nameEn: "Bayern Munich", nameJa: "バイエルン・ミュンヘン", country: "ドイツ", leagueId: 78 },
  { rank: 4, nameEn: "Paris Saint Germain", nameJa: "パリ・サンジェルマン", country: "フランス", leagueId: 61 },
  { rank: 5, nameEn: "Liverpool", nameJa: "リヴァプール", country: "イングランド", leagueId: 39 },
  { rank: 6, nameEn: "Inter", nameJa: "インテル", country: "イタリア", leagueId: 135 },
  { rank: 7, nameEn: "Borussia Dortmund", nameJa: "ボルシア・ドルトムント", country: "ドイツ", leagueId: 78 },
  { rank: 8, nameEn: "RB Leipzig", nameJa: "RBライプツィヒ", country: "ドイツ", leagueId: 78 },
  { rank: 9, nameEn: "Barcelona", nameJa: "FCバルセロナ", country: "スペイン", leagueId: 140 },
  { rank: 10, nameEn: "Bayer Leverkusen", nameJa: "バイヤー・レバークーゼン", country: "ドイツ", leagueId: 78 },
  { rank: 11, nameEn: "Atletico Madrid", nameJa: "アトレティコ・マドリード", country: "スペイン", leagueId: 140 },
  { rank: 12, nameEn: "Arsenal", nameJa: "アーセナル", country: "イングランド", leagueId: 39 },
  { rank: 13, nameEn: "Juventus", nameJa: "ユヴェントス", country: "イタリア", leagueId: 135 },
  { rank: 14, nameEn: "Benfica", nameJa: "ベンフィカ", country: "ポルトガル", leagueId: 94 },
  { rank: 15, nameEn: "Atalanta", nameJa: "アタランタ", country: "イタリア", leagueId: 135 },
  { rank: 16, nameEn: "AC Milan", nameJa: "ACミラン", country: "イタリア", leagueId: 135 },
  { rank: 17, nameEn: "AS Roma", nameJa: "ASローマ", country: "イタリア", leagueId: 135 },
  { rank: 18, nameEn: "Porto", nameJa: "FCポルト", country: "ポルトガル", leagueId: 94 },
  { rank: 19, nameEn: "Sporting CP", nameJa: "スポルティングCP", country: "ポルトガル", leagueId: 94 },
  { rank: 20, nameEn: "Napoli", nameJa: "ナポリ", country: "イタリア", leagueId: 135 },
  { rank: 21, nameEn: "Chelsea", nameJa: "チェルシー", country: "イングランド", leagueId: 39 },
  { rank: 22, nameEn: "Manchester United", nameJa: "マンチェスター・ユナイテッド", country: "イングランド", leagueId: 39 },
  { rank: 23, nameEn: "PSV Eindhoven", nameJa: "PSVアイントホーフェン", country: "オランダ", leagueId: 88 },
  { rank: 24, nameEn: "Ajax", nameJa: "アヤックス", country: "オランダ", leagueId: 88 },
  { rank: 25, nameEn: "Feyenoord", nameJa: "フェイエノールト", country: "オランダ", leagueId: 88 },
  { rank: 26, nameEn: "Club Brugge", nameJa: "クラブ・ブルッヘ", country: "ベルギー", leagueId: 144 },
  { rank: 27, nameEn: "Tottenham", nameJa: "トッテナム", country: "イングランド", leagueId: 39 },
  { rank: 28, nameEn: "Lazio", nameJa: "ラツィオ", country: "イタリア", leagueId: 135 },
  { rank: 29, nameEn: "Sevilla", nameJa: "セビージャ", country: "スペイン", leagueId: 140 },
  { rank: 30, nameEn: "Villarreal", nameJa: "ビジャレアル", country: "スペイン", leagueId: 140 },
  { rank: 31, nameEn: "Eintracht Frankfurt", nameJa: "アイントラハト・フランクフルト", country: "ドイツ", leagueId: 78 },
  { rank: 32, nameEn: "Shakhtar Donetsk", nameJa: "シャフタール・ドネツク", country: "ウクライナ", leagueId: null },
  { rank: 33, nameEn: "Sporting Braga", nameJa: "スポルティング・ブラガ", country: "ポルトガル", leagueId: 94 },
  { rank: 34, nameEn: "Fiorentina", nameJa: "フィオレンティーナ", country: "イタリア", leagueId: 135 },
  { rank: 35, nameEn: "Rangers", nameJa: "レンジャーズ", country: "スコットランド", leagueId: null },
  { rank: 36, nameEn: "Celtic", nameJa: "セルティック", country: "スコットランド", leagueId: null },
  { rank: 37, nameEn: "Red Bull Salzburg", nameJa: "レッドブル・ザルツブルク", country: "オーストリア", leagueId: null },
  { rank: 38, nameEn: "Olympiakos Piraeus", nameJa: "オリンピアコス", country: "ギリシャ", leagueId: null },
  { rank: 39, nameEn: "Lille", nameJa: "リール", country: "フランス", leagueId: 61 },
  { rank: 40, nameEn: "Marseille", nameJa: "マルセイユ", country: "フランス", leagueId: 61 },
  { rank: 41, nameEn: "West Ham", nameJa: "ウェストハム", country: "イングランド", leagueId: 39 },
  { rank: 42, nameEn: "Lyon", nameJa: "リヨン", country: "フランス", leagueId: 61 },
  { rank: 43, nameEn: "Monaco", nameJa: "モナコ", country: "フランス", leagueId: 61 },
  { rank: 44, nameEn: "Galatasaray", nameJa: "ガラタサライ", country: "トルコ", leagueId: 203 },
  { rank: 45, nameEn: "Fenerbahce", nameJa: "フェネルバフチェ", country: "トルコ", leagueId: 203 },
  { rank: 46, nameEn: "Real Sociedad", nameJa: "レアル・ソシエダ", country: "スペイン", leagueId: 140 },
  { rank: 47, nameEn: "Real Betis", nameJa: "レアル・ベティス", country: "スペイン", leagueId: 140 },
  { rank: 48, nameEn: "Aston Villa", nameJa: "アストン・ヴィラ", country: "イングランド", leagueId: 39 },
  { rank: 49, nameEn: "Newcastle", nameJa: "ニューカッスル", country: "イングランド", leagueId: 39 },
  { rank: 50, nameEn: "Brighton", nameJa: "ブライトン", country: "イングランド", leagueId: 39 },
  { rank: 51, nameEn: "Slavia Praha", nameJa: "スラヴィア・プラハ", country: "チェコ", leagueId: null },
  { rank: 52, nameEn: "Sparta Praha", nameJa: "スパルタ・プラハ", country: "チェコ", leagueId: null },
  { rank: 53, nameEn: "Dinamo Zagreb", nameJa: "ディナモ・ザグレブ", country: "クロアチア", leagueId: null },
  { rank: 54, nameEn: "Young Boys", nameJa: "ヤングボーイズ", country: "スイス", leagueId: null },
  { rank: 55, nameEn: "FC Copenhagen", nameJa: "FCコペンハーゲン", country: "デンマーク", leagueId: null },
  { rank: 56, nameEn: "Red Star Belgrade", nameJa: "レッドスター・ベオグラード", country: "セルビア", leagueId: null },
  { rank: 57, nameEn: "Basel", nameJa: "バーゼル", country: "スイス", leagueId: null },
  { rank: 58, nameEn: "Union St. Gilloise", nameJa: "ユニオン・サン=ジロワーズ", country: "ベルギー", leagueId: 144 },
  { rank: 59, nameEn: "Gent", nameJa: "ヘント", country: "ベルギー", leagueId: 144 },
  { rank: 60, nameEn: "Anderlecht", nameJa: "アンデルレヒト", country: "ベルギー", leagueId: 144 },
  { rank: 61, nameEn: "PAOK", nameJa: "PAOK", country: "ギリシャ", leagueId: null },
  { rank: 62, nameEn: "Ferencvarosi TC", nameJa: "フェレンツヴァーロシュ", country: "ハンガリー", leagueId: null },
  { rank: 63, nameEn: "Molde", nameJa: "モルデ", country: "ノルウェー", leagueId: null },
  { rank: 64, nameEn: "Bodo/Glimt", nameJa: "ボデ/グリムト", country: "ノルウェー", leagueId: null },
  { rank: 65, nameEn: "Nice", nameJa: "ニース", country: "フランス", leagueId: 61 },
  { rank: 66, nameEn: "Rennes", nameJa: "レンヌ", country: "フランス", leagueId: 61 },
  { rank: 67, nameEn: "Toulouse", nameJa: "トゥールーズ", country: "フランス", leagueId: 61 },
  { rank: 68, nameEn: "SC Freiburg", nameJa: "SCフライブルク", country: "ドイツ", leagueId: 78 },
  { rank: 69, nameEn: "1899 Hoffenheim", nameJa: "ホッフェンハイム", country: "ドイツ", leagueId: 78 },
  { rank: 70, nameEn: "Union Berlin", nameJa: "ウニオン・ベルリン", country: "ドイツ", leagueId: 78 },
  { rank: 71, nameEn: "VfL Wolfsburg", nameJa: "VfLヴォルフスブルク", country: "ドイツ", leagueId: 78 },
  { rank: 72, nameEn: "Bologna", nameJa: "ボローニャ", country: "イタリア", leagueId: 135 },
  { rank: 73, nameEn: "Torino", nameJa: "トリノ", country: "イタリア", leagueId: 135 },
  { rank: 74, nameEn: "Athletic Club", nameJa: "アスレティック・ビルバオ", country: "スペイン", leagueId: 140 },
  { rank: 75, nameEn: "Valencia", nameJa: "バレンシア", country: "スペイン", leagueId: 140 },
  { rank: 76, nameEn: "Girona", nameJa: "ジローナ", country: "スペイン", leagueId: 140 },
  { rank: 77, nameEn: "Besiktas", nameJa: "ベシクタシュ", country: "トルコ", leagueId: 203 },
  { rank: 78, nameEn: "Trabzonspor", nameJa: "トラブゾンスポル", country: "トルコ", leagueId: 203 },
  { rank: 79, nameEn: "AZ Alkmaar", nameJa: "AZアルクマール", country: "オランダ", leagueId: 88 },
  { rank: 80, nameEn: "Twente", nameJa: "トゥエンテ", country: "オランダ", leagueId: 88 },
  { rank: 81, nameEn: "Vitoria Guimaraes", nameJa: "ヴィトーリア・ギマランイス", country: "ポルトガル", leagueId: 94 },
  { rank: 82, nameEn: "Slovan Bratislava", nameJa: "スロヴァン・ブラチスラヴァ", country: "スロバキア", leagueId: null },
  { rank: 83, nameEn: "Legia Warszawa", nameJa: "レギア・ワルシャワ", country: "ポーランド", leagueId: null },
  { rank: 84, nameEn: "Viktoria Plzen", nameJa: "ヴィクトリア・プルゼニ", country: "チェコ", leagueId: null },
  { rank: 85, nameEn: "Qarabag", nameJa: "カラバフ", country: "アゼルバイジャン", leagueId: null },
  { rank: 86, nameEn: "Sturm Graz", nameJa: "シュトゥルム・グラーツ", country: "オーストリア", leagueId: null },
  { rank: 87, nameEn: "LASK", nameJa: "LASK", country: "オーストリア", leagueId: null },
  { rank: 88, nameEn: "Rapid Vienna", nameJa: "ラピド・ウィーン", country: "オーストリア", leagueId: null },
  { rank: 89, nameEn: "FC Midtjylland", nameJa: "ミッティラン", country: "デンマーク", leagueId: null },
  { rank: 90, nameEn: "Malmo FF", nameJa: "マルメFF", country: "スウェーデン", leagueId: null },
  { rank: 91, nameEn: "Ludogorets", nameJa: "ルドゴレツ", country: "ブルガリア", leagueId: null },
  { rank: 92, nameEn: "FK Partizan", nameJa: "パルチザン・ベオグラード", country: "セルビア", leagueId: null },
  { rank: 93, nameEn: "APOEL", nameJa: "APOEL", country: "キプロス", leagueId: null },
  { rank: 94, nameEn: "Sheriff", nameJa: "シェリフ・ティラスポリ", country: "モルドバ", leagueId: null },
  { rank: 95, nameEn: "Maccabi Tel Aviv", nameJa: "マッカビ・テルアビブ", country: "イスラエル", leagueId: null },
  { rank: 96, nameEn: "Maccabi Haifa", nameJa: "マッカビ・ハイファ", country: "イスラエル", leagueId: null },
  { rank: 97, nameEn: "Genk", nameJa: "ヘンク", country: "ベルギー", leagueId: 144 },
  { rank: 98, nameEn: "Royal Antwerp", nameJa: "ロイヤル・アントワープ", country: "ベルギー", leagueId: 144 },
  { rank: 99, nameEn: "Standard Liege", nameJa: "スタンダール・リエージュ", country: "ベルギー", leagueId: 144 },
  { rank: 100, nameEn: "Servette", nameJa: "セルヴェット", country: "スイス", leagueId: null },
];

const UEFA_SNAPSHOT_NOTE_JA =
  "UEFAランキングは契約中のAPI-Footballでは取得できないため、2025年時点の係数に基づく静的なスナップショットです(最新の公式順位ではありません)。";

// ---- 更新頻度の階層 ----
const TIER_A_MAX_RANK = 40; // 1〜40位: 毎日更新
// tier B(41〜100位)は2日に1回の輪番

function tierOf(club) {
  return club.rank <= TIER_A_MAX_RANK ? "A" : "B";
}

// 日付から安定した数値を作る(乱数は使わない=再実行しても同じ結果になるように)
function dayNumberOf(dateKey) {
  const d = new Date(String(dateKey) + "T00:00:00Z").getTime();
  return Number.isFinite(d) ? Math.floor(d / 86400000) : 0;
}

/**
 * 「今日どのクラブのコア情報(フォーム・怪我・監督/布陣)を更新するか」。
 * tier Aは毎日、tier Bは2日に1回の輪番。
 */
function clubsForCoreUpdate(dateKey) {
  const day = dayNumberOf(dateKey);
  return CLUB_UNIVERSE.filter((c) => tierOf(c) === "A" || (c.rank % 2) === (day % 2));
}

/**
 * 「今日どのクラブの選手名簿(squad)を更新するか」。全クラブを7日周期で一巡。
 */
function clubsForSquadSync(dateKey) {
  const day = dayNumberOf(dateKey);
  return CLUB_UNIVERSE.filter((c) => (c.rank % 7) === (day % 7));
}

/**
 * 「今日どのクラブのxGを更新するか」。tier Aのみ7日周期
 * (1クラブあたり/fixtures/statisticsを5回呼ぶ高価な処理のため)。
 */
function clubsForXgUpdate(dateKey) {
  const day = dayNumberOf(dateKey);
  return CLUB_UNIVERSE.filter((c) => tierOf(c) === "A" && (c.rank % 7) === (day % 7));
}

/**
 * 「今日どのクラブの基本情報(スタジアム・創設年など、ほぼ変わらないもの)を
 *  更新するか」。全クラブを28日周期で一巡。
 */
function clubsForBasicInfo(dateKey) {
  const day = dayNumberOf(dateKey);
  return CLUB_UNIVERSE.filter((c) => (c.rank % 28) === (day % 28));
}

function findClub(nameEn) {
  if (!nameEn) return null;
  const lower = String(nameEn).toLowerCase();
  return CLUB_UNIVERSE.find((c) => c.nameEn.toLowerCase() === lower) || null;
}

module.exports = {
  CLUB_UNIVERSE,
  UEFA_SNAPSHOT_NOTE_JA,
  TIER_A_MAX_RANK,
  tierOf,
  clubsForCoreUpdate,
  clubsForSquadSync,
  clubsForXgUpdate,
  clubsForBasicInfo,
  findClub,
  dayNumberOf,
};
