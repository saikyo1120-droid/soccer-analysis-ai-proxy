/**
 * 2026年8月・本番監査(プロジェクト全体総点検)対応:
 * GET /api/match-analysis(「AIマッチ分析(クラブ対戦シミュレーション)」)を
 * 実際にエンドポイントとして呼び出すテスト。これまでこの重要な機能には
 * 専用のテストが1つも無かった(監査で判明)。
 *
 * 確認する内容:
 *   - ユーザーが要求した項目(勝敗予想・勝率・予想スコア・試合展開・重視した
 *     要素・逆転シナリオ・怪我人の影響・フォーメーション・注目選手・結論)が
 *     実際にレスポンスに含まれるか
 *   - 「1-1でホームの勝利」のような自己矛盾した結論文にならないか(監査で
 *     発見した実際のバグの再発防止)
 *   - ホーム・アウェイが異なるリーグ所属の場合でも、それぞれ正しいリーグの
 *     順位/得点ランキングを見に行くか(監査で発見した実際のバグの再発防止)
 *   - 見つからないクラブ名(表記ゆれ)は正直にteam_not_foundを返すか
 */
const path = require("path");
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.ANTHROPIC_API_KEY; // LLM未設定 -> 決定論的フォールバック文を検証する

const TEAM_IDS = { "Home FC": 1001, "Away FC": 1002, "Serie Home": 2001, "Liga Away": 2002 };
const LEAGUE_OF = { 1001: 501, 1002: 502, 2001: 135, 2002: 140 }; // Home FC/Away FCは同一リーグ、Serie Home/Liga Awayは別リーグ

function makeFixtures(teamId, n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const opp = teamId + 900 + i;
    list.push({
      fixture: { id: teamId * 100 + i, date: new Date(Date.UTC(2026, 6, 30 - i)).toISOString(), status: { short: "FT" } },
      league: { id: LEAGUE_OF[teamId] || 999 },
      teams: { home: { id: teamId, name: "T" + teamId }, away: { id: opp, name: "OPP" + opp } },
      goals: { home: 2, away: 1 },
    });
  }
  return list;
}

global.fetch = async (urlArg) => {
  const u = new URL(urlArg.toString());
  const p = u.pathname;
  const json = async (obj) => ({ ok: true, json: async () => obj });

  if (p === "/teams") {
    const search = u.searchParams.get("search") || "";
    const hit = Object.keys(TEAM_IDS).find((name) => name.toLowerCase() === search.toLowerCase());
    return json({ response: hit ? [{ team: { id: TEAM_IDS[hit], name: hit } }] : [], errors: [] });
  }
  if (p === "/fixtures" && u.searchParams.get("last")) {
    const teamId = parseInt(u.searchParams.get("team"), 10);
    return json({ response: makeFixtures(teamId, 10), errors: [] });
  }
  if (p === "/injuries") {
    const teamId = parseInt(u.searchParams.get("team"), 10);
    if (teamId === TEAM_IDS["Home FC"]) {
      return json({ response: [{ player: { name: "田中太郎", reason: "Knee Injury" } }, { player: { name: "佐藤次郎", reason: "Suspended" } }], errors: [] });
    }
    return json({ response: [], errors: [] });
  }
  if (p === "/standings") {
    const league = parseInt(u.searchParams.get("league"), 10);
    const teamId = Object.keys(LEAGUE_OF).find((id) => LEAGUE_OF[id] === league);
    if (!teamId) return json({ response: [], errors: [] });
    return json({
      response: [{ league: { standings: [[{ team: { id: parseInt(teamId, 10) }, rank: 3, points: 40, all: { played: 20, goals: { for: 30, against: 15 } } }]] } }],
      errors: [],
    });
  }
  if (p === "/fixtures/headtohead") {
    return json({ response: [{ teams: { home: { id: TEAM_IDS["Home FC"] }, away: { id: TEAM_IDS["Away FC"] } }, goals: { home: 2, away: 0 } }], errors: [] });
  }
  if (p === "/fixtures/lineups") {
    const fixtureId = parseInt(u.searchParams.get("fixture"), 10);
    const teamId = Math.floor(fixtureId / 100);
    return json({ response: [{ team: { id: teamId }, formation: teamId === TEAM_IDS["Home FC"] ? "4-3-3" : "4-4-2", coach: { name: "監督" + teamId } }], errors: [] });
  }
  if (p === "/players/topscorers") {
    const league = parseInt(u.searchParams.get("league"), 10);
    const teamId = Object.keys(LEAGUE_OF).find((id) => LEAGUE_OF[id] === league);
    if (!teamId) return json({ response: [], errors: [] });
    return json({
      response: [{ player: { name: "得点王" + teamId }, statistics: [{ team: { id: parseInt(teamId, 10) }, goals: { total: 12, assists: 4 } }] }],
      errors: [],
    });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const { server } = require(path.join(__dirname, "..", "server", "server.js"));

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null, raw: body }); } });
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  {
    const r = await get(port, `/api/match-analysis?home=${encodeURIComponent("Home FC")}&away=${encodeURIComponent("Away FC")}`);
    ok(r.status === 200 && r.json.ok === true, "同一リーグ2クラブの分析は成功する, got " + JSON.stringify(r.json && r.json.reason));
    const b = r.json;
    ok(typeof b.winProbability.homeWinPct === "number", "勝率(数値)が含まれる");
    ok(typeof b.predictedScoreline === "string" && /^\d+-\d+$/.test(b.predictedScoreline), "予想スコアが含まれる, got " + b.predictedScoreline);
    ok(Array.isArray(b.keyFactors) && b.keyFactors.length > 0, "重視した要素の一覧が含まれる");
    ok(typeof b.narrative.text === "string" && b.narrative.text.length > 0, "試合展開予想が含まれる");
    ok(typeof b.reverseScenario.text === "string" && b.reverseScenario.text.length > 0, "逆転シナリオが含まれる");
    ok(typeof b.conclusion === "string" && b.conclusion.length > 0, "AI結論が含まれる");
    ok(typeof b.tacticalCompatibility.text === "string" && b.tacticalCompatibility.text.includes("4-3-3") && b.tacticalCompatibility.text.includes("4-4-2"), "戦術相性(⑦)の見立てに両者のフォーメーションが含まれる, got " + b.tacticalCompatibility.text);
    ok(typeof b.biggestHighlight.text === "string" && b.biggestHighlight.text.length > 0, "この試合最大の見どころ(⑩)が含まれる, got " + b.biggestHighlight.text);
    ok(b.injuries && b.injuries.home.count === 2, "怪我人の影響(人数)が含まれる, got " + JSON.stringify(b.injuries));
    ok(b.injuries.home.injured.includes("田中太郎"), "怪我人の実名(負傷)が含まれる");
    ok(b.injuries.home.suspended.includes("佐藤次郎"), "怪我人の実名(出場停止)が別枠で含まれる");
    ok(b.formation.home === "4-3-3" && b.formation.away === "4-4-2", "直近フォーメーション(実データ)が含まれる, got " + JSON.stringify(b.formation));
    ok(b.keyPlayers.home && b.keyPlayers.home.goals === 12, "注目選手(得点ランキング上位・実データ)が含まれる, got " + JSON.stringify(b.keyPlayers));

    // 監査で発見した自己矛盾バグ(「1-1でホームの勝利」)の再発防止:
    // 予想スコアが引き分けスコア(x-x)の場合、結論文は「勝利」と言い切らない。
    if (/^(\d+)-\1$/.test(b.predictedScoreline)) {
      ok(!b.conclusion.includes("の勝利と予想"), `引き分けスコア(${b.predictedScoreline})なのに「勝利」と断定していないはず, got: ${b.conclusion}`);
    } else {
      ok(true, "予想スコアは引き分けスコアではなかった(このテストケースでは矛盾は起こり得ない)");
    }
  }

  {
    // 異なるリーグ所属の2クラブでも、それぞれ正しいリーグの順位/得点ランキングを見る
    // (以前は片方のリーグIDを両方に使い回していたバグの再発防止)。
    const r = await get(port, `/api/match-analysis?home=${encodeURIComponent("Serie Home")}&away=${encodeURIComponent("Liga Away")}`);
    ok(r.status === 200 && r.json.ok === true, "異なるリーグ所属の2クラブでも分析は成功する");
    const b = r.json;
    ok(b.keyPlayers.home && b.keyPlayers.home.name === "得点王" + TEAM_IDS["Serie Home"], `ホーム側は自分のリーグの得点ランキングを見ているはず, got: ${JSON.stringify(b.keyPlayers.home)}`);
    ok(b.keyPlayers.away && b.keyPlayers.away.name === "得点王" + TEAM_IDS["Liga Away"], `アウェイ側は自分のリーグの得点ランキングを見ているはず, got: ${JSON.stringify(b.keyPlayers.away)}`);
    ok(!b.dataNotes.some((n) => n.includes("リーグIDを特定できなかった")), "両クラブとも自分のリーグIDが正しく見つかっているはず");
  }

  {
    // 表記ゆれ等で見つからないクラブ名は、正直にteam_not_foundを返す(架空の分析をしない)。
    const r = await get(port, `/api/match-analysis?home=${encodeURIComponent("Unknown Club XYZ")}&away=${encodeURIComponent("Away FC")}`);
    ok(r.status === 200 && r.json.ok === false && r.json.reason === "team_not_found", "未登録クラブはteam_not_foundを正直に返す, got " + JSON.stringify(r.json));
  }

  console.log(failures === 0 ? "\nmatch-analysis endpoint tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
