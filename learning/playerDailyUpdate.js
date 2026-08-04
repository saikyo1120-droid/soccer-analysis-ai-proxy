/**
 * server/learning/playerDailyUpdate.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑦「選手情報を毎日更新」。
 *
 * ご要望原文: 「選手データを"聞かれた時だけ取得"ではなく毎日更新してください。
 * 最低でも 年齢/所属/ポジション/利き足/身長/国籍/出場/ゴール/アシスト/怪我/
 * 市場価値/契約/移籍/最近5試合/最近10試合/評価推移 などを更新してください。
 * 更新できなかった項目は理由を残してください」。
 *
 * ■ 「更新できなかった項目は理由を残す」ことについて
 *   これが今回の実装の中心です。16項目それぞれについて、
 *     - 取得できた   → 値を記録
 *     - 取得できない → なぜ取得できないのかを日本語の文章で記録
 *   を必ず残します。理由は大きく3種類あります。
 *     (a) データソースに構造的に存在しない(利き足・市場価値・契約)
 *     (b) 今日はAPIリクエスト予算が足りず見送った(apiBudget.js)
 *     (c) 今日のAPI呼び出しが失敗した(HTTPエラー等)
 *   (a)は「明日以降も取得できない」ので、代替案まで含めて記録します。
 *   (b)(c)は「明日また試す」ので、その旨が分かる書き方にします。
 *
 * ■ なぜ全107名を毎日ではなく、ローテーションなのか
 *   1選手あたり2〜3リクエスト必要なため、107名を毎日更新すると
 *   200〜300リクエスト/日になり、API-Football無料プラン(100/日)では
 *   不可能です。そこで PLAYER_UPDATE_CAP 名/日のローテーションとし、
 *   予算が増えれば(有料プラン)環境変数を上げるだけで自動的に増やせる
 *   設計にしています。
 *
 * ■ 「評価推移」の作り方(追加のAPIコスト0で、毎日必ず賢くなる部分)
 *   API-Footballは「試合ごとの選手評価」を取るには試合数ぶんの追加
 *   リクエストが必要で、毎日全選手ぶんを取ることはできません。
 *   そこで、毎日取得しているシーズン平均評価・出場・得点・アシストを
 *   日付つきでUpstashへ積み上げ、その時系列そのものを「評価推移」として
 *   扱います。これは追加のAPIコストが一切かからないうえ、
 *   「昨日より今日の方が手持ちのデータが増えている」ことを
 *   データで証明できる形になります(このプロジェクトの最優先目標)。
 */
const { REGISTERED_PLAYERS } = require("./registeredPlayers");
const { computePlayerRealStats } = require("./playerFeatures");

const PLAYER_UPDATE_CAP_DEFAULT = 3;
const RATING_HISTORY_MAX = 60; // 直近60回ぶんの記録を保持

// ご要望の16項目。source は「どこから取るか」、permanentlyUnavailable は
// 「API-Footballには構造的に存在しないので、明日以降も取得できない」ことを示す。
const FIELD_SPECS = [
  { key: "age", labelJa: "年齢", source: "/players player.age" },
  { key: "club", labelJa: "所属", source: "/players statistics[].team.name" },
  { key: "position", labelJa: "ポジション", source: "/players statistics[].games.position" },
  {
    key: "foot", labelJa: "利き足", permanentlyUnavailable: true,
    unavailableReason:
      "API-Footballのplayerオブジェクトに利き足のフィールドが存在しないため、APIからは毎日更新できません(player は id/name/age/birth/nationality/height/weight/injured/photo のみ)。代替案: Transfermarkt系の別データソースの併用が必要です(優先順位⑪のAPI比較で検討対象にしています)。現時点ではアプリ内の手動登録データを参考値として併記しています。",
  },
  { key: "height", labelJa: "身長", source: "/players player.height" },
  { key: "nationality", labelJa: "国籍", source: "/players player.nationality" },
  { key: "appearances", labelJa: "出場", source: "/players statistics[].games.appearences" },
  { key: "goals", labelJa: "ゴール", source: "/players statistics[].goals.total" },
  { key: "assists", labelJa: "アシスト", source: "/players statistics[].goals.assists" },
  { key: "injury", labelJa: "怪我", source: "/players player.injured + /injuries" },
  {
    key: "marketValue", labelJa: "市場価値", permanentlyUnavailable: true,
    unavailableReason:
      "API-Footballは市場価値(推定移籍金)を提供していないため、APIからは毎日更新できません。代替案: Transfermarktのデータを扱う別APIが必要です(優先順位⑪のAPI比較で検討対象にしています)。推測値をAIに作らせることはしません(実データでないものを事実として保存しないという既存の方針のため)。",
  },
  {
    key: "contract", labelJa: "契約", permanentlyUnavailable: true,
    unavailableReason:
      "API-Footballは契約期間・年俸を提供していないため、APIからは毎日更新できません。代替案: 優先順位⑪で比較する有料APIの中に契約情報を持つものがあれば採用を検討します。現時点ではアプリ内の手動登録データを参考値として併記しています。",
  },
  { key: "transfers", labelJa: "移籍", source: "/transfers?player=" },
  { key: "recent5", labelJa: "最近5試合", source: "/fixtures?team=&last=10(所属クラブの直近成績)" },
  { key: "recent10", labelJa: "最近10試合", source: "/fixtures?team=&last=10(所属クラブの直近成績)" },
  { key: "ratingTrend", labelJa: "評価推移", source: "シーズン平均評価の日次スナップショット(Upstash上に蓄積)" },
];

function seasonForDate(runAt) {
  const m = runAt.getUTCMonth() + 1;
  return m >= 7 ? runAt.getUTCFullYear() : runAt.getUTCFullYear() - 1;
}

// 日付ベースのローテーション(既存のCOACH_TRANSFER_CHECK_CAPと同じ考え方)。
// 同じ日なら必ず同じ選手が選ばれる(冪等)。
function pickTodaysPlayers(dateKey, cap, list) {
  const players = list || REGISTERED_PLAYERS;
  if (!players.length || cap <= 0) return [];
  const n = Math.min(cap, players.length);
  const startOffset = Math.abs(Number(dateKey.split("-").join("")) % players.length) || 0;
  const rotated = players.slice(startOffset).concat(players.slice(0, startOffset));
  return rotated.slice(0, n);
}

// API-Footballの選手IDを解決してUpstashへ永続キャッシュする
// (既存のresolveTeamId / resolveLeagueId と同じ設計)。
async function resolvePlayerIdCached(player, deps) {
  const { callApiFootball, upstashEnabled, upstashGetJSON, upstashSetJSON, searchLeagues, season } = deps;
  const cacheKey = `learn:playerid:${player.key}`;
  if (upstashEnabled) {
    const cached = await upstashGetJSON(cacheKey).catch(() => null);
    if (cached && cached.id) return { id: cached.id, spentRequests: 0 };
  }
  // /players?search= は league または team の指定が必須(既存server.jsのコメント参照)。
  // 主要リーグを順に試す。
  const leagues = (searchLeagues && searchLeagues.length) ? searchLeagues : [39, 140, 78, 135, 61];
  let spent = 0;
  for (const leagueId of leagues) {
    try {
      spent++;
      const data = await callApiFootball("/players", { search: player.nameEn, league: leagueId, season });
      const list = (data && data.response) || [];
      const found = list.find((row) => row && row.player && row.player.id);
      if (found) {
        const id = found.player.id;
        if (upstashEnabled) await upstashSetJSON(cacheKey, { id, resolvedAt: new Date().toISOString() }).catch(() => {});
        return { id, spentRequests: spent };
      }
    } catch (e) {
      // このリーグでは見つからなかっただけの可能性があるので次のリーグを試す
    }
  }
  return { id: null, spentRequests: spent };
}

// statistics[] は大会ごとに分かれている。最も出場数の多いブロックを
// 「主戦場」とみなす(リーグ戦を選びたいが、大会名は言語や年度で揺れるため
// 出場数で選ぶ方が頑健)。
function pickPrimaryStats(statistics) {
  const list = Array.isArray(statistics) ? statistics.filter(Boolean) : [];
  if (!list.length) return null;
  let best = list[0];
  let bestApps = -1;
  for (const s of list) {
    const apps = Number((s.games || {}).appearences) || 0;
    if (apps > bestApps) { bestApps = apps; best = s; }
  }
  return best;
}

// 所属クラブの直近試合から W/D/L を数える
function summarizeRecentFixtures(fixtures, teamId, count) {
  const list = (fixtures || [])
    .filter((f) => f && f.fixture && f.teams && f.goals)
    .filter((f) => (f.goals.home !== null && f.goals.home !== undefined) && (f.goals.away !== null && f.goals.away !== undefined))
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, count);
  if (!list.length) return null;
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const f of list) {
    const isHome = f.teams.home && f.teams.home.id === teamId;
    const own = isHome ? f.goals.home : f.goals.away;
    const opp = isHome ? f.goals.away : f.goals.home;
    gf += own; ga += opp;
    if (own > opp) w++; else if (own === opp) d++; else l++;
  }
  return { played: list.length, w, d, l, gf, ga };
}

function formatRecent(summary) {
  if (!summary) return null;
  return `${summary.played}試合 ${summary.w}勝${summary.d}分${summary.l}敗(得点${summary.gf}・失点${summary.ga})`;
}

// 蓄積してきた評価スナップショットから「推移」の説明文を作る
function describeRatingTrend(history) {
  const withRating = (history || []).filter((h) => h && Number.isFinite(h.rating));
  if (!withRating.length) return null;
  const latest = withRating[withRating.length - 1];
  if (withRating.length === 1) {
    return `平均評価${latest.rating.toFixed(2)}(記録1回目。明日以降ここに推移が積み上がります)`;
  }
  const first = withRating[0];
  const diff = latest.rating - first.rating;
  const dir = diff > 0.005 ? "上昇" : diff < -0.005 ? "下降" : "横ばい";
  return `平均評価${latest.rating.toFixed(2)}(記録${withRating.length}回・初回${first.rating.toFixed(2)}から${dir}${diff === 0 ? "" : diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)})`;
}

/**
 * 16項目それぞれについて {ok, value, reason} を組み立てる。
 * これがご要望「更新できなかった項目は理由を残してください」の本体。
 */
function buildFieldStatus(ctx) {
  const {
    player, apiPlayer, primaryStats, realStats, transfers, injuries,
    recent5, recent10, ratingHistory, notes,
  } = ctx;
  const note = notes || {};
  const status = {};

  const set = (key, ok, value, reason) => { status[key] = { ok: !!ok, value: ok ? value : null, reason: ok ? null : reason }; };

  for (const spec of FIELD_SPECS) {
    if (spec.permanentlyUnavailable) {
      // アプリ内の手動データがあれば参考値として併記する(あくまで参考)
      let hint = null;
      if (spec.key === "foot" && player.staticFoot) hint = `アプリ内の手動登録データでは「${player.staticFoot}」`;
      if (spec.key === "contract" && player.staticContractNote) hint = `アプリ内の手動登録データでは「${player.staticContractNote}」`;
      status[spec.key] = {
        ok: false, value: null, permanent: true,
        reason: spec.unavailableReason + (hint ? ` ${hint}(手動データのため最新性は保証されません)。` : ""),
      };
      continue;
    }

    // API呼び出し自体ができていない場合は、その理由をそのまま各項目へ伝播させる
    const blocking = note[spec.key] || note.all;
    if (blocking) { set(spec.key, false, null, blocking); continue; }

    switch (spec.key) {
      case "age":
        if (apiPlayer && apiPlayer.age != null) set("age", true, `${apiPlayer.age}歳`);
        else set("age", false, null, "APIレスポンスに年齢が含まれていませんでした(選手IDは解決できましたが、該当シーズンの登録情報が無い可能性があります)。");
        break;
      case "club": {
        const team = primaryStats && primaryStats.team ? primaryStats.team.name : null;
        if (team) set("club", true, team);
        else set("club", false, null, "APIレスポンスに所属クラブの統計ブロックが含まれていませんでした(今シーズンの出場記録がまだ無い可能性があります)。");
        break;
      }
      case "position": {
        const pos = realStats && realStats.position ? realStats.position : null;
        if (pos) set("position", true, pos);
        else set("position", false, null, "APIレスポンスにポジションが含まれていませんでした(今シーズンの出場記録がまだ無い可能性があります)。");
        break;
      }
      case "height":
        if (apiPlayer && apiPlayer.height) set("height", true, apiPlayer.height);
        else set("height", false, null, "APIレスポンスに身長が含まれていませんでした(API-Football側でこの選手の身長が未登録です)。");
        break;
      case "nationality":
        if (apiPlayer && apiPlayer.nationality) set("nationality", true, apiPlayer.nationality);
        else set("nationality", false, null, "APIレスポンスに国籍が含まれていませんでした。");
        break;
      case "appearances":
        if (realStats && realStats.appearances != null) set("appearances", true, `${realStats.appearances}試合`);
        else set("appearances", false, null, "APIレスポンスに出場数が含まれていませんでした(今シーズンまだ出場していない可能性があります)。");
        break;
      case "goals":
        if (realStats && realStats.goals != null) set("goals", true, `${realStats.goals}ゴール`);
        else set("goals", false, null, "APIレスポンスに得点数が含まれていませんでした。");
        break;
      case "assists":
        if (realStats && realStats.assists != null) set("assists", true, `${realStats.assists}アシスト`);
        else set("assists", false, null, "APIレスポンスにアシスト数が含まれていませんでした。");
        break;
      case "injury": {
        if (apiPlayer && typeof apiPlayer.injured === "boolean") {
          if (!apiPlayer.injured) { set("injury", true, "負傷なし(API-Football上のinjuredフラグはfalse)"); break; }
          const list = (injuries || []).map((row) => {
            const t = row && row.player ? row.player.type : null;
            const r = row && row.player ? row.player.reason : null;
            return [t, r].filter(Boolean).join(":");
          }).filter(Boolean);
          set("injury", true, list.length ? `負傷中(${list.slice(0, 3).join("、")})` : "負傷中(詳細はAPIから取得できませんでした)");
        } else {
          set("injury", false, null, "APIレスポンスに負傷状態(injuredフラグ)が含まれていませんでした。");
        }
        break;
      }
      case "transfers": {
        if (!Array.isArray(transfers)) {
          set("transfers", false, null, "移籍履歴の取得に失敗しました(明日の実行で再試行します)。");
          break;
        }
        if (!transfers.length) { set("transfers", true, "API-Footballに登録された移籍履歴なし"); break; }
        const latest = transfers[0];
        const inName = latest && latest.teams && latest.teams.in ? latest.teams.in.name : "?";
        const outName = latest && latest.teams && latest.teams.out ? latest.teams.out.name : "?";
        set("transfers", true, `直近の移籍: ${outName}→${inName}${latest && latest.date ? `(${latest.date})` : ""}${latest && latest.type ? `・${latest.type}` : ""}`);
        break;
      }
      case "recent5": {
        const t = formatRecent(recent5);
        if (t) set("recent5", true, `所属クラブの直近5試合: ${t}`);
        else set("recent5", false, null, "所属クラブの直近試合を取得できませんでした(クラブIDが未解決、または終了済みの試合がまだありません)。");
        break;
      }
      case "recent10": {
        const t = formatRecent(recent10);
        if (t) set("recent10", true, `所属クラブの直近10試合: ${t}`);
        else set("recent10", false, null, "所属クラブの直近試合を取得できませんでした(クラブIDが未解決、または終了済みの試合がまだありません)。");
        break;
      }
      case "ratingTrend": {
        const t = describeRatingTrend(ratingHistory);
        if (t) set("ratingTrend", true, t);
        else set("ratingTrend", false, null, "API-Footballがこの選手のシーズン平均評価を返していないため、推移を記録できませんでした(出場時間が短い選手では評価が付かないことがあります)。");
        break;
      }
      default:
        break;
    }
  }
  return status;
}

function countFieldStatus(fieldStatus) {
  const keys = Object.keys(fieldStatus || {});
  const updated = keys.filter((k) => fieldStatus[k].ok);
  const permanent = keys.filter((k) => !fieldStatus[k].ok && fieldStatus[k].permanent);
  const retryable = keys.filter((k) => !fieldStatus[k].ok && !fieldStatus[k].permanent);
  return { total: keys.length, updated: updated.length, permanentlyUnavailable: permanent.length, retryable: retryable.length };
}

const LABEL_BY_KEY = FIELD_SPECS.reduce((acc, s) => { acc[s.key] = s.labelJa; return acc; }, {});

// Knowledge Engineへ保存する「事実」の文章。
// 重要: 文中に日付を埋め込まない(優先順位⑥で確認した重複排除の設計。
// 内容が本当に変わった時だけ新しい事実として増えるようにするため)。
function formatPlayerStatement(player, fieldStatus) {
  const parts = FIELD_SPECS
    .filter((s) => fieldStatus[s.key] && fieldStatus[s.key].ok)
    .map((s) => `${s.labelJa}:${fieldStatus[s.key].value}`);
  if (!parts.length) return null;
  return `${player.nameJa}(${player.nameEn})の最新データ — ${parts.join(" / ")}。`;
}

/**
 * 日次の選手情報更新。
 * deps: { callApiFootball, knowledgeStore, upstashEnabled, upstashGetJSON,
 *         upstashSetJSON, apiBudget, playerUpdateCap, searchLeagues }
 */
async function collectPlayerKnowledge(deps, runAt, dateKey) {
  const {
    callApiFootball, knowledgeStore, upstashEnabled, upstashGetJSON, upstashSetJSON,
    apiBudget, playerUpdateCap, searchLeagues, playerList,
  } = deps;
  const season = seasonForDate(runAt);
  const cap = Number.isFinite(playerUpdateCap) ? playerUpdateCap : PLAYER_UPDATE_CAP_DEFAULT;
  const targets = pickTodaysPlayers(dateKey, cap, playerList);

  const errors = [];
  const playerFactsToday = [];
  let playersUpdatedToday = 0;
  let playerFactsSavedToday = 0;
  let playerFactsDuplicateToday = 0;
  let fieldsUpdatedToday = 0;
  let fieldsPermanentlyUnavailable = 0;
  let fieldsRetryableToday = 0;
  const unavailableReasonsToday = []; // 利用者向けに「なぜ取れなかったか」を見せる

  // 同じクラブの選手が複数いる場合に、クラブの直近試合を使い回すためのキャッシュ
  const teamFixturesCache = new Map();

  const reserve = (n, label) => (apiBudget ? apiBudget.tryReserve(n, label) : { allowed: true, remaining: Infinity, reason: null });

  for (const player of targets) {
    const notes = {};
    let apiPlayer = null;
    let primaryStats = null;
    let realStats = null;
    let transfers = null;
    let injuries = null;
    let recent5 = null;
    let recent10 = null;
    let ratingHistory = null;

    try {
      // ---- 選手IDの解決(キャッシュ済みなら追加リクエスト0) ----
      let playerId = null;
      const cachedIdKey = `learn:playerid:${player.key}`;
      const cachedId = upstashEnabled ? await upstashGetJSON(cachedIdKey).catch(() => null) : null;
      if (cachedId && cachedId.id) {
        playerId = cachedId.id;
      } else {
        const budget = reserve((searchLeagues && searchLeagues.length) || 5, `${player.nameJa}の選手ID解決`);
        if (!budget.allowed) {
          notes.all = budget.reason;
        } else {
          const resolved = await resolvePlayerIdCached(player, { callApiFootball, upstashEnabled, upstashGetJSON, upstashSetJSON, searchLeagues, season });
          playerId = resolved.id;
          if (!playerId) notes.all = `API-Footballの選手検索で「${player.nameEn}」に一致する選手が見つかりませんでした(主要リーグ外に所属している場合、SEARCH_LEAGUES環境変数に該当リーグIDを追加すると解決できることがあります)。`;
        }
      }

      // ---- 選手本体データ(年齢/所属/ポジション/身長/国籍/出場/得点/アシスト/怪我フラグ/評価) ----
      if (playerId && !notes.all) {
        const budget = reserve(1, `${player.nameJa}の基本データ取得`);
        if (!budget.allowed) {
          notes.all = budget.reason;
        } else {
          try {
            const data = await callApiFootball("/players", { id: playerId, season });
            const row = ((data && data.response) || [])[0] || null;
            apiPlayer = row ? row.player : null;
            primaryStats = row ? pickPrimaryStats(row.statistics) : null;
            realStats = primaryStats ? computePlayerRealStats(primaryStats) : null;
          } catch (e) {
            notes.all = `選手データの取得に失敗しました(${e.code || e.message})。明日の実行で再試行します。`;
            errors.push(`player_fetch_failed:${player.nameEn}:${e.code || e.message}`);
          }
        }
      }

      // ---- 移籍履歴 ----
      if (playerId && !notes.all) {
        const budget = reserve(1, `${player.nameJa}の移籍履歴取得`);
        if (!budget.allowed) {
          notes.transfers = budget.reason;
        } else {
          try {
            const data = await callApiFootball("/transfers", { player: playerId });
            const row = ((data && data.response) || [])[0] || null;
            transfers = (row && Array.isArray(row.transfers)) ? row.transfers : [];
          } catch (e) {
            notes.transfers = `移籍履歴の取得に失敗しました(${e.code || e.message})。明日の実行で再試行します。`;
            errors.push(`player_transfers_failed:${player.nameEn}:${e.code || e.message}`);
          }
        }
      }

      // ---- 怪我の詳細(負傷中フラグが立っている選手だけ。予算節約) ----
      if (playerId && !notes.all && apiPlayer && apiPlayer.injured === true) {
        const budget = reserve(1, `${player.nameJa}の負傷詳細取得`);
        if (budget.allowed) {
          try {
            const data = await callApiFootball("/injuries", { player: playerId, season });
            injuries = (data && data.response) || [];
          } catch (e) {
            // 詳細が取れなくても「負傷中」という事実は残せるので、致命的ではない
            errors.push(`player_injuries_failed:${player.nameEn}:${e.code || e.message}`);
          }
        }
      }

      // ---- 所属クラブの直近5/10試合 ----
      const teamId = primaryStats && primaryStats.team ? primaryStats.team.id : null;
      if (teamId && !notes.all) {
        if (teamFixturesCache.has(teamId)) {
          const cached = teamFixturesCache.get(teamId);
          recent5 = summarizeRecentFixtures(cached, teamId, 5);
          recent10 = summarizeRecentFixtures(cached, teamId, 10);
        } else {
          const budget = reserve(1, `${player.nameJa}の所属クラブ直近成績取得`);
          if (!budget.allowed) {
            notes.recent5 = budget.reason;
            notes.recent10 = budget.reason;
          } else {
            try {
              const data = await callApiFootball("/fixtures", { team: teamId, last: 10 });
              const list = (data && data.response) || [];
              teamFixturesCache.set(teamId, list);
              recent5 = summarizeRecentFixtures(list, teamId, 5);
              recent10 = summarizeRecentFixtures(list, teamId, 10);
            } catch (e) {
              notes.recent5 = `所属クラブの直近試合の取得に失敗しました(${e.code || e.message})。明日の実行で再試行します。`;
              notes.recent10 = notes.recent5;
              errors.push(`player_recent_fixtures_failed:${player.nameEn}:${e.code || e.message}`);
            }
          }
        }
      } else if (!notes.all) {
        notes.recent5 = "所属クラブのIDが解決できなかったため、直近成績を取得できませんでした(今シーズンの出場記録がまだ無い可能性があります)。";
        notes.recent10 = notes.recent5;
      }

      // ---- 評価推移(追加のAPIコスト0。日々のスナップショットを積み上げる) ----
      if (upstashEnabled) {
        const histKey = `learn:playerhistory:${player.key}`;
        const prev = (await upstashGetJSON(histKey).catch(() => null)) || [];
        const history = Array.isArray(prev) ? prev.slice() : [];
        if (realStats && realStats.avgRating != null) {
          const already = history.length && history[history.length - 1] && history[history.length - 1].date === dateKey;
          const snapshot = {
            date: dateKey, rating: realStats.avgRating,
            goals: realStats.goals, assists: realStats.assists, appearances: realStats.appearances,
          };
          if (already) history[history.length - 1] = snapshot; else history.push(snapshot);
          await upstashSetJSON(histKey, history.slice(-RATING_HISTORY_MAX)).catch(() => {});
        }
        ratingHistory = history;
      }

      // ---- 16項目それぞれの可否と理由を組み立てる ----
      const fieldStatus = buildFieldStatus({
        player, apiPlayer, primaryStats, realStats, transfers, injuries, recent5, recent10, ratingHistory, notes,
      });
      const counts = countFieldStatus(fieldStatus);
      fieldsUpdatedToday += counts.updated;
      fieldsPermanentlyUnavailable += counts.permanentlyUnavailable;
      fieldsRetryableToday += counts.retryable;

      // 「できなかった理由」を利用者に見せるためのリスト(項目名つき)
      for (const key of Object.keys(fieldStatus)) {
        const f = fieldStatus[key];
        if (!f.ok) {
          unavailableReasonsToday.push({
            playerJa: player.nameJa, fieldJa: LABEL_BY_KEY[key] || key,
            permanent: !!f.permanent, reason: f.reason,
          });
        }
      }

      const statement = formatPlayerStatement(player, fieldStatus);
      if (statement) {
        playersUpdatedToday++;
        const result = await knowledgeStore.saveKnowledgeItem({
          teamEn: `player:${player.key}`, teamJa: player.nameJa,
          category: "playerDaily", type: "fact", statement,
          detail: { fieldStatus, counts },
          computedAt: runAt.toISOString(),
          source: "API-Footballの実データ(/players・/transfers・/injuries・/fixtures)",
        });
        if (result.saved) {
          playerFactsSavedToday++;
          playerFactsToday.push({ playerJa: player.nameJa, statement, category: "playerDaily", counts });
        } else if (result.reason === "DUPLICATE") {
          playerFactsDuplicateToday++;
        }
      }
    } catch (e) {
      errors.push(`player_update_failed:${player.nameEn}:${e.message}`);
    }
  }

  return {
    playersCheckedToday: targets.length,
    playersUpdatedToday,
    playerFactsSavedToday,
    playerFactsDuplicateToday,
    playerFactsToday,
    fieldsUpdatedToday,
    fieldsPermanentlyUnavailable,
    fieldsRetryableToday,
    unavailableReasonsToday,
    errors,
  };
}

module.exports = {
  collectPlayerKnowledge, pickTodaysPlayers, buildFieldStatus, formatPlayerStatement,
  countFieldStatus, describeRatingTrend, summarizeRecentFixtures, formatRecent,
  pickPrimaryStats, seasonForDate, resolvePlayerIdCached,
  FIELD_SPECS, PLAYER_UPDATE_CAP_DEFAULT, RATING_HISTORY_MAX,
};
