/**
 * server/learning/historicalBackfill.js
 * ------------------------------------------------
 * 2026年8月・共同開発者レビューを受けて新設。
 *
 * ■ なぜ必要か(この設計変更が最も効果が大きい)
 *   これまで予測モデルの学習データは `learn:ownpred:recent`
 *   =「自分が予測した試合」だけだった。そのため本番でも36件しか貯まらず、
 *   11個の特徴量のうち10個の重みが初期値0のまま=実質1変数モデルだった。
 *   「20件/日なので300件まで2週間」と見積もっていたが、これは
 *   **問題の立て方そのものが間違っていた**。
 *
 *   モデルの学習に必要なのは「自分が予測したか」ではなく
 *   **「特徴量と結果のペア」**である。API-Football は
 *     GET /fixtures?league=39&season=2025
 *   で1リーグ1シーズン(約380試合)を **1リクエスト** で返す。
 *   5リーグ × 3シーズン = 15リクエストで約5,700試合。
 *   本番のAPI予算は7,500件/日で、日次学習の実測消費は約1,000件。
 *   つまり**余っている予算だけで、その日のうちに現状の158倍の学習データを作れる。**
 *
 *   機械学習では Backfill / Historical Training と呼ばれる標準的な手法で、
 *   本来なら最初にやるべきことだった。
 *
 * ■ でっち上げ防止の方針
 *   ・取得できた実試合の結果のみを使う。欠損は0で埋めず、その特徴量を
 *     「取得できなかった」として除外する(既存のdiffOrZeroと同じ考え方)。
 *   ・過去試合の特徴量は「その試合より前の情報だけ」から作る(リーク防止)。
 *     未来の情報を使うと、バックテストの数字が実際より良く出てしまう。
 *   ・時間減衰(Dixon-Coles)により、古い試合ほど学習への影響を小さくする。
 */

// 動作確認済みのリーグID(clubUniverse.jsと同じ基準。未確認IDは決め打ちしない)
// 2026年8月18日・v47「予測モデルの根本強化」: 5リーグ→9リーグへ拡張。
// 追加した4リーグ(88/94/203/144)はいずれも clubUniverse.js で実際に
// 予測対象クラブが所属している確認済みリーグ(PSV・ベンフィカ・ガラタサライ・
// クラブ・ブルッヘ等)。**予測を出しているのに学習データが無かったリーグ**を
// 埋めるのが目的で、学習データはおよそ5,700件→9,000件超になる。
const DEFAULT_BACKFILL_LEAGUES = [
  { id: 39, nameJa: "プレミアリーグ" },
  { id: 140, nameJa: "ラ・リーガ" },
  { id: 78, nameJa: "ブンデスリーガ" },
  { id: 135, nameJa: "セリエA" },
  { id: 61, nameJa: "リーグ・アン" },
  { id: 88, nameJa: "エールディヴィジ" },
  { id: 94, nameJa: "プリメイラ・リーガ" },
  { id: 203, nameJa: "シュペル・リグ" },
  { id: 144, nameJa: "ベルギー・プロ・リーグ" },
  // ---- v58「リーグ間の橋」(利用者のご指摘への根治) ----
  // 国内リーグだけの学習では、リーグ間の対戦データが1件も無いため
  // 「国内で無双するクラブ(ベンフィカ・ブルッヘ等)」が強豪リーグの
  // 上位クラブより高く出てしまう(地力ランキングの違和感の根本原因)。
  // 欧州カップ戦を学習対象に加えることで、リーグをまたぐ実対戦が
  // レーティングを相互に較正する(でっち上げのリーグ係数は使わない)。
  { id: 2, nameJa: "チャンピオンズリーグ", cup: true },
  { id: 3, nameJa: "ヨーロッパリーグ", cup: true },
  { id: 848, nameJa: "カンファレンスリーグ", cup: true },
  // ---- v87③(2026年9月9日・利用者の選択): 学習リーグの拡張 12大会→15大会 ----
  // 利用者が推奨3候補すべてを選択: J1リーグ・イングランド2部・ブラジル全国選手権。
  //   ・J1: 日本語ファーストのサイトの中核需要なのに、学習データが0件だった
  //   ・チャンピオンシップ: 24チーム×46節=シーズン552試合の大量データ。PLとの
  //     昇降格でクラブが行き来するため、既存レーティングと自然に繋がる(橋の役割)
  //   ・ブラジル全国選手権: 南米最大リーグ。欧州主要リーグへの選手供給元
  // IDはAPI-Footballの標準ID。万一IDが違っても per-league のエラー記録
  // (backfill_failed:league=…)が正直に残り、他リーグの学習は影響を受けない。
  // このリストを増やすと、learnedCompetitions.js の「学習した大会」判定と、
  // 日次の「学習済み大会の全試合を予測対象に足す」処理も自動で追従する。
  { id: 98, nameJa: "J1リーグ" },
  { id: 40, nameJa: "チャンピオンシップ(イングランド2部)" },
  { id: 71, nameJa: "ブラジル全国選手権" },
  // ---- v102 ★2(2026年11月17日・利用者の決定 11/12): 学習リーグの拡張 15大会 → 最大31大会 ----
  //   予想は出しているのに学習データが1件も無かった国内リーグ16件を足す(カップ戦は見送り)。
  //   **IDの決め打ちで別の大会を学習しない**ように、verify つきのリーグは、取り込みの前に
  //   API-Football の /leagues?id= で「国・種別(League)・名前」を照合し、一致したものだけを使う
  //   (ensureLeagueChecks。結果は learn:backfill:leaguecheck に保存し、日次レポートに開示する)。
  //   照合に通って、実際にデータセットに入ったリーグだけが「学習した大会」に数えられる(下の setActivatedLeagues)。
  //   name は API が返す英語名に対する照合(同じ国の2部・3部を取り違えないための確認)。
  { id: 286, nameJa: "セルビア・スーペルリーガ", verify: { country: ["serbia"], name: /^super\s*liga$/i } },
  { id: 119, nameJa: "デンマーク・スーペルリーガ", verify: { country: ["denmark"], name: /^superlig(a|aen)$/i } },
  { id: 383, nameJa: "イスラエル・プレミアリーグ", verify: { country: ["israel"], name: /^(ligat\s*ha.?al|premier league)$/i } },
  { id: 207, nameJa: "スイス・スーパーリーグ", verify: { country: ["switzerland"], name: /^super\s*league$/i } },
  { id: 179, nameJa: "スコティッシュ・プレミアシップ", verify: { country: ["scotland"], name: /^premiership$/i } },
  { id: 106, nameJa: "ポーランド・エクストラクラサ", verify: { country: ["poland"], name: /^ekstraklasa$/i } },
  { id: 253, nameJa: "MLS(メジャーリーグサッカー)", verify: { country: ["usa", "unitedstates"], name: /^major league soccer$/i } },
  { id: 197, nameJa: "ギリシャ・スーパーリーグ", verify: { country: ["greece"], name: /^super\s*league(\s*1)?$/i } },
  { id: 345, nameJa: "チェコ・1部リーグ", verify: { country: ["czechrepublic", "czechia"], name: /^((czech|chance|fortuna)\s*liga|first league|1\.\s*liga)$/i } },
  { id: 141, nameJa: "スペイン2部(ラ・リーガ2)", verify: { country: ["spain"], name: /^(segunda divisi[oó]n|la\s?liga\s?2|laliga hypermotion)$/i } },
  { id: 419, nameJa: "アゼルバイジャン・プレミアリーグ", verify: { country: ["azerbaijan", "azerbaidjan"], name: /^(prem[iy]er\s*li[gq]a|premier league)$/i } },
  { id: 113, nameJa: "スウェーデン・アルスヴェンスカン", verify: { country: ["sweden"], name: /^allsvenskan$/i } },
  { id: 103, nameJa: "ノルウェー・エリテセリエン", verify: { country: ["norway"], name: /^eliteserien$/i } },
  { id: 79, nameJa: "ブンデスリーガ2部", verify: { country: ["germany"], name: /^2\.?\s*bundesliga$/i } },
  { id: 210, nameJa: "クロアチア・HNL", verify: { country: ["croatia"], name: /^((1\.|prva|supersport)\s*)?hnl$/i } },
  { id: 271, nameJa: "ハンガリー・NB I", verify: { country: ["hungary"], name: /^(nb\s*i|otp bank liga|fizz liga)$/i } },
];

// ---- v102 ★2: 「実際に学習に使っているリーグ」の管理 ----
//   従来の15大会(verify なし)は常に有効。verify つきの新リーグは、照合に通って保存済みのデータセットに
//   入ったものだけを有効にする(保存済みデータセットの目次 meta.leagues が、実際に学習に使った大会の一覧)。
//   起動直後・照合前は新リーグを「学習した」と数えない(学習していないものを学習済みと言わない)。
const CORE_LEAGUE_IDS = new Set(DEFAULT_BACKFILL_LEAGUES.filter((l) => !l.verify).map((l) => l.id));
const VERIFY_LEAGUE_IDS = new Set(DEFAULT_BACKFILL_LEAGUES.filter((l) => l.verify).map((l) => l.id));
const activatedLeagueIds = new Set();
const activationListeners = [];
/** 保存済みデータセットに入っている新リーグのIDを反映する(起動時・学習の開始時・データセットを作り直したあとに呼ぶ) */
function setActivatedLeagues(ids) {
  activatedLeagueIds.clear();
  for (const id of ids || []) { const n = Number(id); if (VERIFY_LEAGUE_IDS.has(n)) activatedLeagueIds.add(n); }
  // 通知先(学習済み大会の集合の更新)の失敗で学習の本体は止めないが、黙って捨てない(v92 の方針)
  for (const fn of activationListeners) {
    try { fn(); }
    catch (e) { console.warn("[backfill] league_activation_listener_failed:", (e && e.message) || e); }
  }
  return activeLeagueIds();
}
/** データセットの目次(meta)から反映する。目次が無い・読めなかったときは何もしない(いまの状態を保つ) */
function activateFromMeta(meta) {
  if (!meta || !Array.isArray(meta.leagues)) return activeLeagueIds();
  return setActivatedLeagues(meta.leagues.filter((id) => VERIFY_LEAGUE_IDS.has(Number(id))));
}
function onLeagueActivationChange(fn) { if (typeof fn === "function") activationListeners.push(fn); }
function isLeagueActive(id) { const n = Number(id); return CORE_LEAGUE_IDS.has(n) || activatedLeagueIds.has(n); }
/** いま実際に学習に使っているリーグ(従来の15大会+有効になった新リーグ)のID */
function activeLeagueIds() { return DEFAULT_BACKFILL_LEAGUES.filter((l) => isLeagueActive(l.id)).map((l) => l.id); }
function activeBackfillLeagues() { return DEFAULT_BACKFILL_LEAGUES.filter((l) => isLeagueActive(l.id)); }

// 1月〜12月で1シーズンのリーグ(MLS・北欧・ブラジル・J1)。シーズンの年の数え方が、秋に始まるリーグと違う。
const CALENDAR_YEAR_LEAGUE_IDS = new Set([98, 71, 253, 113, 103]);
/**
 * そのリーグで取得するシーズン(年)の一覧。新しい順。
 *   ・秋に始まるリーグ … 7月以降はその年、6月までは前の年が「今のシーズン」(従来どおり)
 *   ・暦年のリーグ     … その年が「今のシーズン」。1〜6月は始まったばかりで試合が少ないので、1つ多く(6シーズン)さかのぼる
 *     (従来は暦年のリーグも秋始まりと同じ数え方で、1〜6月は新しいシーズンを取りに行っていなかった)
 */
function seasonsForLeague(league, runAt, count) {
  const n = count || 5;
  const y = runAt.getUTCFullYear(), m = runAt.getUTCMonth() + 1;
  const out = [];
  if (league && CALENDAR_YEAR_LEAGUE_IDS.has(league.id)) {
    const total = n + (m <= 6 ? 1 : 0);
    for (let i = 0; i < total; i++) out.push(y - i);
    return out;
  }
  const current = m >= 7 ? y : y - 1;
  for (let i = 0; i < n; i++) out.push(current - i);
  return out;
}

// ---- v102 ★2: リーグIDの照合(/leagues?id=) ----
const LEAGUE_CHECK_KEY = "learn:backfill:leaguecheck";
const LEAGUE_CHECK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日ごとに照合し直す(リーグ名の変更・IDの付け替えに気づくため)
const LEAGUE_CHECK_NOTFOUND_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 照合先が何も返さなかったIDは3日で照合し直す(一時的な空応答かもしれないため)
const LEAGUE_CHECK_SPEC_VERSION = 1;                   // 照合の条件(国・名前)を変えたら上げる = 保存済みの結果を使わず照合し直す
/** /leagues?id= の応答が、想定している大会か(純関数) */
function verifyLeagueIdentity(response, spec) {
  const row = Array.isArray(response) ? response.find((r) => r && r.league && Number(r.league.id) === Number(spec.id)) : null;
  if (!row) {
    return { ok: false, notFound: true, name: null, country: null, type: null, latestSeason: null,
      reasonJa: `ID ${spec.id}(${spec.nameJa})は、照合先の応答に見つかりませんでした。学習には使いません(3日後にもう一度照合します)。` };
  }
  const name = String(row.league.name || "").trim();
  const type = String(row.league.type || "").trim();
  const country = String((row.country && row.country.name) || "").trim();
  const normCountry = country.toLowerCase().replace(/[^a-z]/g, "");
  const countryOk = (spec.verify.country || []).includes(normCountry);
  const typeOk = /^league$/i.test(type);
  const nameOk = spec.verify.name.test(name);
  const years = (Array.isArray(row.seasons) ? row.seasons : []).map((s) => Number(s && s.year)).filter((v) => Number.isFinite(v));
  const ok = countryOk && typeOk && nameOk;
  return {
    ok, name, country, type, latestSeason: years.length ? Math.max(...years) : null,
    reasonJa: ok ? null
      : `ID ${spec.id} は「${country || "国不明"} / ${name || "名前不明"}(${type || "種別不明"})」でした。想定している「${spec.nameJa}」と${!countryOk ? "国" : !typeOk ? "種別" : "名前"}が一致しないため、学習には使いません。`,
  };
}
/**
 * verify つきのリーグを照合する。保存済みの結果が新しければ通信しない。
 * 通信に失敗したリーグは結果を保存しない(次回また試す。以前に通っていた結果があれば、それを使い続ける)。
 * @returns {{ byId, okIds:Set<number>, requests:number, errors:string[] }}
 */
async function ensureLeagueChecks(deps, runAt) {
  const { upstashEnabled, upstashGetJSON, upstashSetJSON, callApiFootball, apiBudget } = deps;
  const nowMs = runAt.getTime();
  const errors = [];
  let saved = null;
  if (upstashEnabled && typeof upstashGetJSON === "function") {
    // 読めなかったときは「保存なし」として照合し直す(理由は errors に残す。黙って捨てない)
    try { saved = await upstashGetJSON(LEAGUE_CHECK_KEY); }
    catch (e) { errors.push(`league_check_read_failed:${(e && (e.code || e.message)) || "unknown"}`); }
  }
  const byId = { ...((saved && saved.byId) || {}) };
  let requests = 0, changed = false;
  for (const l of DEFAULT_BACKFILL_LEAGUES) {
    if (!l.verify) continue;
    const prev = byId[l.id];
    const ttlMs = prev && prev.notFound ? LEAGUE_CHECK_NOTFOUND_TTL_MS : LEAGUE_CHECK_TTL_MS;
    const fresh = prev && prev.checkedAt && prev.specVersion === LEAGUE_CHECK_SPEC_VERSION
      && Number.isFinite(Date.parse(prev.checkedAt)) && (nowMs - Date.parse(prev.checkedAt)) < ttlMs;
    if (fresh) continue;
    if (prev && prev.specVersion !== LEAGUE_CHECK_SPEC_VERSION) { delete byId[l.id]; changed = true; } // 条件が変わった結果は使わない
    if (typeof callApiFootball !== "function") { errors.push(`league_check_unavailable:league=${l.id}`); continue; }
    if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(1)) { errors.push(`league_check_skipped_budget:league=${l.id}`); continue; }
    try {
      const data = await callApiFootball("/leagues", { id: l.id });
      requests++;
      byId[l.id] = { ...verifyLeagueIdentity(data && data.response, l), nameJa: l.nameJa, checkedAt: runAt.toISOString(), specVersion: LEAGUE_CHECK_SPEC_VERSION };
      changed = true;
    } catch (e) {
      errors.push(`league_check_failed:league=${l.id}:${(e && (e.code || e.message)) || "unknown"}`);
    }
  }
  if (changed && upstashEnabled && typeof upstashSetJSON === "function") {
    await upstashSetJSON(LEAGUE_CHECK_KEY, { byId, updatedAt: runAt.toISOString() });
  }
  const okIds = new Set(Object.keys(byId).map(Number).filter((id) => VERIFY_LEAGUE_IDS.has(id) && byId[id] && byId[id].ok === true));
  return { byId, okIds, requests, errors };
}
/** 日次レポートに出す用: 照合の結果を、リーグごとに短くまとめる */
function summarizeLeagueChecks(byId) {
  const rows = DEFAULT_BACKFILL_LEAGUES.filter((l) => l.verify).map((l) => {
    const c = (byId || {})[l.id];
    return {
      id: l.id, nameJa: l.nameJa,
      status: !c ? "pending" : c.ok ? "ok" : "rejected",
      ...(c && c.notFound ? { notFound: true } : {}),
      apiName: c ? c.name : null, apiCountry: c ? c.country : null, checkedAt: c ? c.checkedAt : null,
      reasonJa: !c ? "まだ照合できていません(次の学習でもう一度試します)。" : (c.reasonJa || null),
    };
  });
  return {
    total: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    rejected: rows.filter((r) => r.status === "rejected").length,
    pending: rows.filter((r) => r.status === "pending").length,
    rows,
  };
}

const BACKFILL_KEY = "learn:backfill:dataset";
const BACKFILL_META_KEY = "learn:backfill:meta";
// v58: 12大会×5シーズン ≒ 18,000〜20,000件(国内306〜380試合/シーズン+カップ戦)。
// v87③: 15大会×5シーズン ≒ 24,000〜26,000件(チャンピオンシップ552試合/シーズンが大きい)。
//   旧上限22,000のままだと切り詰めが発動して古いシーズンが黙って欠けるため、
//   28,000へ引き上げた(保存は下のブロック分割。増分は約5ブロック=数MBで、
//   保存先(Upstash無料枠256MB)には全く影響しない)。
// v102 ★2: 31大会×5シーズン。1シーズンの試合数の見積りは下の SEASON_MATCH_ESTIMATE(リーグごと。予選・プレーオフ込みの概数)。
//   従来の15大会が1シーズン約5,200試合、新16リーグが約4,400試合 → 5シーズンで約48,000試合。
//   さらに1〜6月は暦年のリーグ(J1・ブラジル・MLS・スウェーデン・ノルウェー)を1シーズン多く持つので、最大で約49,000試合。
//   28,000 のままだと古い2シーズン以上が黙って切り捨てられるため、余裕を1割みて 54,000 へ
//   (切り捨てが起きたときは meta.droppedOldest に件数が残り、日次レポートに出る)。
//   1行の保存サイズは下の v4 形式で半分以下になったので、保存先の使用量は v101 までとほぼ同じ(約9MB)。
const MAX_STORED_MATCHES = 54000;
// リーグごとの1シーズンの試合数の概数(保存容量の見積りと、そのテスト用。学習には使わない)
const SEASON_MATCH_ESTIMATE = Object.freeze({
  39: 380, 140: 380, 78: 306, 135: 380, 61: 306, 88: 306, 94: 306, 203: 342, 144: 312,
  2: 280, 3: 270, 848: 350, 98: 380, 40: 557, 71: 380,
  286: 296, 119: 192, 383: 240, 207: 228, 179: 228, 106: 306, 253: 540, 197: 240, 345: 280, 141: 468,
  419: 198, 113: 242, 103: 242, 79: 306, 210: 180, 271: 198,
});

const FINISHED = new Set(["FT", "AET", "PEN"]);

/**
 * 指定リーグ・シーズンの全試合を取得して、学習に使える形へ整形する。
 * @returns {{ matches: Array, requests: number, errors: string[] }}
 */
async function fetchSeason(callApiFootball, leagueId, season) {
  const errors = [];
  let requests = 0;
  try {
    const data = await callApiFootball("/fixtures", { league: leagueId, season });
    requests++;
    const rows = (data && data.response) || [];
    const matches = [];
    for (const r of rows) {
      if (!r || !r.fixture || !r.teams || !r.goals) continue;
      const st = r.fixture.status ? r.fixture.status.short : null;
      if (!FINISHED.has(st)) continue;                    // 未実施・中止は学習に使わない
      if (r.goals.home === null || r.goals.away === null) continue;
      // ---- v97(全体監査): 延長・PK決着(AET/PEN)は90分時点のスコアで学習する ----
      //   モデルが予測するのは90分の勝敗・得点(日次の答え合わせも score.fulltime で採点)。
      //   旧実装は goals(延長込み)をそのまま使っていたため、カップ戦の延長戦が
      //   「90分で2点差がついた試合」として学習データに混ざり、ラベルが濁っていた。
      //   fulltime が無い応答形式では従来どおり goals を使う(値をでっち上げない)。
      const ft = (st !== "FT" && r.score && r.score.fulltime
        && Number.isFinite(r.score.fulltime.home) && Number.isFinite(r.score.fulltime.away))
        ? r.score.fulltime : null;
      matches.push({
        id: r.fixture.id,
        date: r.fixture.date,
        leagueId,
        season,
        homeId: r.teams.home.id,
        awayId: r.teams.away.id,
        homeName: r.teams.home.name,
        awayName: r.teams.away.name,
        hg: ft ? ft.home : r.goals.home,
        ag: ft ? ft.away : r.goals.away,
        ...(ft ? { finishedStatus: st } : {}), // 延長/PK決着だったことを正直に残す
      });
    }
    return { matches, requests, errors };
  } catch (e) {
    errors.push(`backfill_failed:league=${leagueId}:season=${season}:${e.code || e.message}`);
    return { matches: [], requests, errors };
  }
}

/**
 * 複数リーグ・複数シーズンをまとめて取得する。
 * apiBudget を渡すと、予算が足りない場合は取得を打ち切り、理由を残す。
 */
async function backfillSeasons(deps, opts) {
  const { callApiFootball, apiBudget } = deps;
  const o = opts || {};
  // v102 ★2: 既定は「いま実際に学習に使っているリーグ」(照合に通っていない新リーグを黙って取りに行かない)
  const leagues = o.leagues || activeBackfillLeagues();
  const seasons = o.seasons || [];
  // v102 ★2: リーグごとにシーズンの数え方が違う(暦年のリーグ)ので、リーグ別に決められるようにする
  const seasonsOf = typeof o.seasonsOf === "function" ? o.seasonsOf : () => seasons;
  const all = [];
  const errors = [];
  const skipped = [];
  let requests = 0;
  let seasonPairs = 0;

  for (const league of leagues) {
    for (const season of seasonsOf(league) || []) {
      seasonPairs++;
      // 1リクエストぶんの予算も無ければ、黙って止めずに理由を残す
      if (apiBudget && typeof apiBudget.canAfford === "function" && !apiBudget.canAfford(1)) {
        skipped.push({
          leagueId: league.id, season,
          reasonJa: `APIの残り予算が不足したため、${league.nameJa}(${season})以降の過去試合の取得を見送りました。`,
        });
        continue;
      }
      const r = await fetchSeason(callApiFootball, league.id, season);
      requests += r.requests;
      errors.push(...r.errors);
      all.push(...r.matches);
      // v102: 取得が長くなった(31大会で約160リクエスト)ので、途中でも進捗の時刻を更新する(渡されたときだけ。1分に1回まで)
      if (typeof deps.heartbeat === "function") await deps.heartbeat(`過去試合の取得 ${seasonPairs}件め`);
    }
  }

  // 同じ試合を二重に持たない(リーグ再編などでIDが重複しうる)
  const seen = new Set();
  const unique = [];
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }
  unique.sort((a, b) => new Date(a.date) - new Date(b.date));

  // v102: 上限を超えて古い試合を切り捨てたときは、黙って捨てずに件数を返す
  const dropped = Math.max(0, unique.length - MAX_STORED_MATCHES);
  return {
    matches: unique.slice(-MAX_STORED_MATCHES),
    requests,
    errors,
    skipped,
    droppedOldest: dropped,
    noteJa: (typeof o.seasonsOf === "function"
      ? `${leagues.length}リーグ・のべ${seasonPairs}シーズンから${unique.length}試合を取得しました(APIリクエスト${requests}件)。`
      : `${leagues.length}リーグ×${seasons.length}シーズンから${unique.length}試合を取得しました(APIリクエスト${requests}件)。`)
      + (dropped ? `保存の上限(${MAX_STORED_MATCHES}試合)を超えた古い${dropped}試合は使っていません。` : ""),
  };
}

/**
 * ---- 特徴量の構築(リーク防止つき) ----
 * 各試合について「その試合より前の試合だけ」からチームの状態を作る。
 * 直近N試合の得点・失点・勝率・ホーム/アウェイ別成績を、時系列を進めながら
 * 逐次更新する(1パス)。未来の情報は一切使わない。
 *
 * @param {Array} matches 日付昇順の試合配列
 * @param {number} window 直近何試合を使うか(既定10。既存のフォーム計算と揃える)
 */
// ---- v102(B「過去試合を主な教材に」): 特徴量の定義を、本番の予想と同じにそろえる ----
//   これまで過去試合の行は、本番の予想とは別の定義で作られていた:
//     ・フォーム    … 過去試合: 直近10試合の得失点差の平均/本番: 直近5試合(dailyJob.computeFormScore)
//     ・勝点        … 過去試合: 直近10試合の1試合あたり勝点/本番: そのシーズンの順位表の 勝点÷試合数
//     ・会場別の勝率 … 過去試合: 2試合以上で計算/本番: 1試合以上で計算(features.computeHomeAwaySplit)
//     ・連戦(疲労) … 過去試合: 無し/本番: 直前7日間の試合数(features.computeFatigueFeature)
//     ・対戦成績    … 過去試合: 無し/本番: 直近10回の直接対戦の勝ち数(features.computeHeadToHeadFeature)
//   定義が違うと、過去試合で学んだ重みを本番の特徴量に掛けたときに意味がずれる。無い特徴量の重みは、
//   自社予想の記録(千数百件)からしか学べなかった。行の形式 v4 では、上の5つを本番と同じ定義で作る。
//   どれも「その試合より前の試合」だけから作る(未来を見ない。v102_corpus_test.js で固定)。
//   取れない値は null(片方でも null なら、その特徴量は 0 = 使わない。computeMatchFeatures と同じ約束)。
const FORM_WINDOW = 5;                 // 本番の computeFormScore と同じ
const FATIGUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 本番の computeFatigueFeature と同じ
const H2H_KEEP = 10;                   // 本番の /fixtures/headtohead?last=10 と同じ
const DOMESTIC_TABLE_FRESH_MS = 45 * 24 * 60 * 60 * 1000; // カップ戦で国内リーグの表を使えるのは、最後の国内リーグ戦から45日以内
function buildTrainingRows(matches, window) {
  const W = window || 10;
  const hist = new Map();      // teamId -> [{t, gf, ga, isHome, win}](直近40試合)
  const table = new Map();     // "リーグ:シーズン:チーム" -> {pts, played}(国内リーグの順位表。その時点まで)
  const domestic = new Map();  // teamId -> { key: "リーグ:シーズン:チーム", t }(そのチームが最後に出た国内リーグの表と、その試合の時刻)
  const meetings = new Map();  // "小さいID-大きいID" -> [{winnerId|null}](直近10回の直接対戦)
  const cupIds = new Set(DEFAULT_BACKFILL_LEAGUES.filter((l) => l.cup).map((l) => l.id));
  const rows = [];
  const r2 = (x) => Math.round(x * 100) / 100;       // 本番の特徴量と同じ丸め(小数2桁)
  const r4 = (x) => Math.round(x * 10000) / 10000;

  const statsOf = (teamId, isHomeSide, kickoffMs, m) => {
    const h = hist.get(teamId) || [];
    if (h.length < 3) return null; // 3試合未満は状態を推定しない(でっち上げ防止)
    const recent = h.slice(-W);
    const n = recent.length;
    const gf = recent.reduce((s, x) => s + x.gf, 0) / n;
    const ga = recent.reduce((s, x) => s + x.ga, 0) / n;
    // フォーム: 直近5試合の得失点差の平均(本番と同じ)
    const last = h.slice(-FORM_WINDOW);
    const formScore = last.reduce((s, x) => s + (x.gf - x.ga), 0) / last.length;
    // 会場別の勝率: 直近W試合のうち、その会場(ホーム/アウェイ)での試合。1試合以上あれば計算(本番と同じ)
    const sideGames = recent.filter((x) => x.isHome === isHomeSide);
    const sideWinRate = sideGames.length >= 1
      ? r2(sideGames.filter((x) => x.win).length / sideGames.length)
      : null;
    // 連戦: キックオフ前7日間の試合数(直近W試合の中で数える。本番と同じ)
    const matchesLast7Days = Number.isFinite(kickoffMs)
      ? recent.filter((x) => Number.isFinite(x.t) && x.t < kickoffMs && kickoffMs - x.t <= FATIGUE_WINDOW_MS).length
      : null;
    // 勝点: そのチームの国内リーグの、この試合より前の 勝点÷試合数。カップ戦では国内リーグの値を使う。
    //   国内リーグがデータに無いチーム(カップ戦だけに出てくるクラブ)・シーズンの初戦は null。
    //   カップ戦で使う国内リーグの表は「進行中のシーズン」のものだけ(最後の国内リーグ戦から45日以内)。
    //   シーズンの変わり目に、終わったシーズンの最終成績を「今の勝点」として使わない(本番の順位表は新シーズンに切り替わるため)。
    let tableKey = null;
    if (cupIds.has(m.leagueId)) {
      const d = domestic.get(teamId);
      if (d && Number.isFinite(kickoffMs) && Number.isFinite(d.t) && kickoffMs - d.t <= DOMESTIC_TABLE_FRESH_MS) tableKey = d.key;
    } else {
      tableKey = `${m.leagueId}:${m.season}:${teamId}`;
    }
    const tb = tableKey ? table.get(tableKey) : null;
    const pointsPerGame = tb && tb.played > 0 ? r4(tb.pts / tb.played) : null;
    return {
      formScore: r2(formScore),
      avgGoalsFor: r2(gf),
      avgGoalsAgainst: r2(ga),
      pointsPerGame,
      homeVenueWinRate: isHomeSide ? sideWinRate : null,
      awayVenueWinRate: isHomeSide ? null : sideWinRate,
      matchesLast7Days,
      sampleSize: n,
    };
  };

  for (const m of matches) {
    const kickoffMs = Date.parse(m.date);
    const hCtx = statsOf(m.homeId, true, kickoffMs, m);
    const aCtx = statsOf(m.awayId, false, kickoffMs, m);
    const pairKey = m.homeId < m.awayId ? `${m.homeId}-${m.awayId}` : `${m.awayId}-${m.homeId}`;
    // 両チームとも十分な履歴がある試合だけを学習に使う
    if (hCtx && aCtx) {
      // 対戦成績: この試合より前の直接対戦(最大10回)で、今回のホーム側・アウェイ側がそれぞれ何勝したか。
      //   対戦が無ければ 0勝0敗(本番で「対戦の記録が0件」のときと同じ = 差は0)。
      const past = meetings.get(pairKey) || [];
      rows.push({
        fixtureId: m.id,
        date: m.date,
        leagueId: m.leagueId,
        season: m.season ?? null,
        // v50: チーム別レーティング学習(teamRatings.js)のためにチームIDを保持する
        homeId: m.homeId,
        awayId: m.awayId,
        homeName: m.homeName,
        awayName: m.awayName,
        homeCtx: hCtx,
        awayCtx: aCtx,
        h2h: {
          homeSideWins: past.filter((x) => x.winnerId === m.homeId).length,
          awaySideWins: past.filter((x) => x.winnerId === m.awayId).length,
          sampleSize: past.length,
        },
        actualHomeGoals: m.hg,
        actualAwayGoals: m.ag,
        actualWinner: m.hg > m.ag ? "home" : m.hg < m.ag ? "away" : "draw",
      });
    }
    // この試合の結果を履歴へ反映(次の試合以降にだけ影響する = リークしない)
    const push = (teamId, gf, ga, isHome) => {
      const arr = hist.get(teamId) || [];
      arr.push({ t: kickoffMs, date: m.date, gf, ga, isHome, win: gf > ga });
      if (arr.length > 40) arr.shift();
      hist.set(teamId, arr);
    };
    push(m.homeId, m.hg, m.ag, true);
    push(m.awayId, m.ag, m.hg, false);
    // 国内リーグの順位表(カップ戦の結果は入れない)
    if (!cupIds.has(m.leagueId)) {
      const bump = (teamId, gf, ga) => {
        const key = `${m.leagueId}:${m.season}:${teamId}`;
        const tb = table.get(key) || { pts: 0, played: 0 };
        tb.pts += gf > ga ? 3 : gf === ga ? 1 : 0;
        tb.played += 1;
        table.set(key, tb);
        domestic.set(teamId, { key, t: kickoffMs });
      };
      bump(m.homeId, m.hg, m.ag);
      bump(m.awayId, m.ag, m.hg);
    }
    // 直接対戦の履歴
    const list = meetings.get(pairKey) || [];
    list.push({ winnerId: m.hg > m.ag ? m.homeId : m.hg < m.ag ? m.awayId : null });
    if (list.length > H2H_KEEP) list.shift();
    meetings.set(pairKey, list);
  }

  return rows;
}

/**
 * Dixon-Colesの時間減衰重み。古い試合ほど軽くする。
 * 文献の標準値 ξ=0.0065/日 は半減期およそ107日。
 * ξ=0 のときすべて1(=減衰なし)なので、既存の挙動と一致する。
 */
function timeDecayWeight(matchDateIso, referenceMs, xi) {
  if (!xi) return 1;
  const t = Date.parse(matchDateIso);
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (referenceMs - t) / 86400000);
  return Math.exp(-xi * days);
}

// ---- 2026年8月・検証で判明した「保存できていないのに成功と報告する」欠陥 ----
//   5リーグ×3シーズンの学習データは実測で約1.3MB(本物のシーズンなら約2MB)。
//   これを1キーに入れると Upstash の1値/1リクエストの上限を超えて保存に失敗する。
//   ところが保存関数の戻り値を捨てていたため、毎日
//     「3,809件の学習データを作りました」と成功を報告しながら1件も保存されず、
//     翌日また15リクエストを使って取り直す
//   という自己強化ループになりうる状態だった(週1回のはずが毎日15件)。
//   選手索引と同じくブロック分割で保存し、**保存できたかどうかを必ず返す**。
// v53: 保存フォーマットの版。3 = チームID(hi/ai)+meta.namesById(チームID→名前)。
// 版が上がると modelTuning 側が週1回の更新日を待たずに作り直す。
// v102: 4 = 特徴量を本番と同じ定義にした行(フォーム5試合・シーズンの勝点・連戦・対戦成績)+小さい保存形式(下の packCtx)。
const ROWS_VERSION = 4;
const BACKFILL_SHARD_SIZE = 1200;                       // 1ブロックあたりの試合数
const BACKFILL_MAX_SHARDS = 45;                          // v102 ★2: 24→45(上限54,000件。31大会×5シーズンが切り詰め無しで収まる)
// ---- v102: 行の保存形式 v4 ----
//   v3 は文脈(homeCtx / awayCtx)を項目名つきのオブジェクトのまま保存していた(1行 約350バイト)。
//   学習リーグを増やすと行数が約2倍になるので、項目名を持たない配列にして1行 約150バイトにする
//   (1ブロック 1,200行で約420KB → 約180KB。保存先の1リクエストの上限 1MB に対して余裕を持たせる)。
//   並び: [フォーム, 平均得点, 平均失点, 1試合あたり勝点, 会場別の勝率, 直前7日の試合数, 直近の試合数]
const packCtx = (c, isHome) => [
  c.formScore ?? null, c.avgGoalsFor ?? null, c.avgGoalsAgainst ?? null, c.pointsPerGame ?? null,
  (isHome ? c.homeVenueWinRate : c.awayVenueWinRate) ?? null, c.matchesLast7Days ?? null, c.sampleSize ?? null,
];
const unpackCtx = (a, isHome) => ({
  formScore: a[0] ?? null, avgGoalsFor: a[1] ?? null, avgGoalsAgainst: a[2] ?? null, pointsPerGame: a[3] ?? null,
  homeVenueWinRate: isHome ? (a[4] ?? null) : null, awayVenueWinRate: isHome ? null : (a[4] ?? null),
  matchesLast7Days: a[5] ?? null, sampleSize: a[6] ?? null,
});
const backfillShardKey = (i) => `${BACKFILL_KEY}:s${i}`;

async function saveDataset(deps, rows, meta) {
  const { upstashEnabled, upstashSetJSON, upstashCmd, upstashGetJSON } = deps;
  if (!upstashEnabled) return { saved: false, reasonJa: "保存先(Upstash)が未設定のため、学習データを保存できません。" };
  // 保存サイズを抑えるため、学習に必要な項目だけを残す
  // v102: v4 形式。勝敗(w)は得点から決まるので保存しない。対戦成績は [ホーム側の勝ち数, アウェイ側の勝ち数, 対戦数]
  const toSlim = (r) => ({
    d: r.date, l: r.leagueId, s: r.season ?? null,
    hi: r.homeId, ai: r.awayId, // v50: レーティング学習用のチームID(1件+約20バイト)
    h: packCtx(r.homeCtx || {}, true), a: packCtx(r.awayCtx || {}, false),
    q: r.h2h ? [r.h2h.homeSideWins ?? null, r.h2h.awaySideWins ?? null, r.h2h.sampleSize ?? null] : null,
    hg: r.actualHomeGoals, ag: r.actualAwayGoals,
  });
  const total = rows.length;
  const shardCount = Math.min(BACKFILL_MAX_SHARDS, Math.max(1, Math.ceil(total / BACKFILL_SHARD_SIZE)));
  // v102: 上限を超えたときに残すのは「新しいほう」(行は古い順に並んでいる)。
  //   これまでは先頭(古いほう)を残していて、下の文言「直近◯件を保存」と合っていなかった
  //   (取得の段階で上限までに切ってあるので、実際にここで切れたことは無い)。
  const storedCount = Math.min(total, shardCount * BACKFILL_SHARD_SIZE);
  const offset = total - storedCount;
  const truncated = offset;
  const failed = [];
  for (let i = 0; i < shardCount; i++) {
    // v102: 保存用の形(軽い形)は、ブロックごとに作ってすぐ手放す(全件ぶんを同時に持たない)
    const chunk = rows.slice(offset + i * BACKFILL_SHARD_SIZE, Math.min(total, offset + (i + 1) * BACKFILL_SHARD_SIZE)).map(toSlim);
    if ((await upstashSetJSON(backfillShardKey(i), chunk)) === false) failed.push(i);
  }
  if (failed.length) {
    return {
      saved: false, failedShards: failed,
      reasonJa: `学習データの保存に失敗しました(${failed.length}/${shardCount}ブロック)。次回の実行で作り直します。`,
    };
  }
  // 前世代の余りブロックを片付ける
  const prevMeta = upstashGetJSON ? await upstashGetJSON(BACKFILL_META_KEY).catch(() => null) : null;
  const prevShards = prevMeta && Number.isFinite(prevMeta.shardCount) ? prevMeta.shardCount : 0;
  if (upstashCmd) {
    for (let i = shardCount; i < Math.min(BACKFILL_MAX_SHARDS, prevShards); i++) {
      await upstashCmd(["DEL", backfillShardKey(i)]).catch(() => {});
    }
    // 旧形式(単一キー)が残っていると読み出しで混ざるので消す
    await upstashCmd(["DEL", BACKFILL_KEY]).catch(() => {});
  }
  // v50: 行フォーマットの版。チームID(hi/ai)を含む形式は2。
  // modelTuning側はこれを見て、古い形式の保存分を作り直す(週1回の更新日を待たない)。
  const fullMeta = { ...(meta || {}), rowsVersion: ROWS_VERSION, shardCount, shardSize: BACKFILL_SHARD_SIZE, storedRows: storedCount, truncatedRows: truncated };
  const okMeta = (await upstashSetJSON(BACKFILL_META_KEY, fullMeta)) !== false;
  return {
    saved: okMeta, shardCount, storedRows: storedCount, truncatedRows: truncated, meta: fullMeta,
    reasonJa: okMeta
      ? (truncated ? `上限を超えた${truncated}件は保存していません(直近${storedCount}件を保存)。` : null)
      : "学習データの目次の保存に失敗しました。",
  };
}

async function loadDataset(deps, opts) {
  const { upstashEnabled, upstashGetJSON } = deps;
  if (!upstashEnabled) return { rows: [], meta: null };
  // v102: opts.lastShards を渡すと、新しいほうのブロックだけを読む(ブロックは古い順に並んでいる)。
  //   ④-b を「軽い設定」で動かすとき用(メモリを使う量を、学習リーグを増やす前と同じくらいに抑える)。
  const lastShards = opts && Number.isFinite(opts.lastShards) && opts.lastShards > 0 ? Math.floor(opts.lastShards) : null;
  const meta = (await upstashGetJSON(BACKFILL_META_KEY).catch(() => null)) || null;
  // v102: v4(配列形式)と v3 以前(オブジェクト形式)の両方を読める。古い形式で保存されたデータは、
  //   modelTuning が行の形式の版(meta.rowsVersion)を見て作り直すまでの間、そのまま学習に使える。
  const winnerOf = (hg, ag) => (hg > ag ? "home" : hg < ag ? "away" : "draw");
  const toRow = (r) => {
    const v4 = Array.isArray(r.h) && Array.isArray(r.a);
    return {
      date: r.d, leagueId: r.l, season: r.s ?? null,
      homeId: r.hi, awayId: r.ai, // 旧形式(v49以前)の保存分には無い(undefined) → レーティング学習から自然に除外される
      homeCtx: v4 ? unpackCtx(r.h, true) : r.h, awayCtx: v4 ? unpackCtx(r.a, false) : r.a,
      ...(Array.isArray(r.q) ? { h2h: { homeSideWins: r.q[0] ?? null, awaySideWins: r.q[1] ?? null, sampleSize: r.q[2] ?? null } } : {}),
      actualHomeGoals: r.hg, actualAwayGoals: r.ag, actualWinner: r.w || winnerOf(r.hg, r.ag),
    };
  };
  // v102: 保存用の形(軽い形)は、ブロックごとに学習用の形へ直してすぐ手放す(全件ぶんを二重に持たない)
  const rows = [];
  // v102: ブロックが増えた(最大45)ので、1つ読めなかっただけで黙って穴の開いたデータで学習しないようにする。
  //   読めなかったブロックは1回だけ読み直し、それでも読めなければ番号を failedShards に入れて返す(呼び出し側が記録に残す)。
  const failedShards = [];
  let firstShard = 0;
  if (meta && Number.isFinite(meta.shardCount) && meta.shardCount > 0) {
    const totalShards = Math.min(BACKFILL_MAX_SHARDS, meta.shardCount);
    firstShard = lastShards ? Math.max(0, totalShards - lastShards) : 0;
    for (let i = firstShard; i < totalShards; i++) {
      let chunk = null, ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try { chunk = await upstashGetJSON(backfillShardKey(i)); ok = true; }
        catch (e) { ok = false; }
      }
      if (!ok || !Array.isArray(chunk)) { failedShards.push(i); continue; }
      for (const r of chunk) rows.push(toRow(r));
    }
  } else {
    // 旧形式(単一キー)からの読み出し。移行期のみ通る。
    const single = (await upstashGetJSON(BACKFILL_KEY).catch(() => null)) || [];
    for (const r of single) rows.push(toRow(r));
  }
  return { rows, meta, ...(failedShards.length ? { failedShards } : {}), ...(firstShard > 0 ? { skippedOldShards: firstShard } : {}) };
}

/** v53: 取得済み試合からチームID→チーム名の対応表を作る(地力ランキングの表示用)。 */
function buildTeamNamesById(matches) {
  const names = {};
  for (const m of (matches || [])) {
    if (Number.isFinite(m.homeId) && m.homeName) names[m.homeId] = m.homeName;
    if (Number.isFinite(m.awayId) && m.awayName) names[m.awayId] = m.awayName;
  }
  return names;
}

module.exports = {
  DEFAULT_BACKFILL_LEAGUES, BACKFILL_KEY, BACKFILL_META_KEY, MAX_STORED_MATCHES, ROWS_VERSION, buildTeamNamesById,
  BACKFILL_SHARD_SIZE, BACKFILL_MAX_SHARDS, backfillShardKey,
  fetchSeason, backfillSeasons, buildTrainingRows, timeDecayWeight,
  saveDataset, loadDataset,
  // v102 ★2: 学習リーグの拡張(照合・有効化・シーズンの数え方)
  CORE_LEAGUE_IDS, VERIFY_LEAGUE_IDS, CALENDAR_YEAR_LEAGUE_IDS, LEAGUE_CHECK_KEY, LEAGUE_CHECK_TTL_MS, LEAGUE_CHECK_NOTFOUND_TTL_MS, SEASON_MATCH_ESTIMATE,
  setActivatedLeagues, activateFromMeta, onLeagueActivationChange, isLeagueActive, activeLeagueIds, activeBackfillLeagues,
  seasonsForLeague, verifyLeagueIdentity, ensureLeagueChecks, summarizeLeagueChecks,
  packCtx, unpackCtx,
};
