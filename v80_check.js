/**
 * scripts/v80_check.js — v80(成長加速)の自己完結テスト。
 *   案8: 学習済み大会の「全試合」を予測対象へ(公開前フルスロットル)
 *   案10: 粗→細の2段階グリッド探索(xGブレンド率α・引き分け帯)
 *   指示: PRELAUNCH_LEARNING スイッチ(公開時に環境変数1つで通常モードへ)
 * 実行: node scripts/v80_check.js(ネットワーク不要)
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, fs.existsSync(path.join(__dirname, "..", "server", "server.js")) ? ".." : "../..");
const results = [];
const ck = (label, ok, detail) => { results.push([label, ok]); console.log(`  [${ok ? "OK" : "FAIL"}] ${label}${ok ? "" : detail ? " — " + String(detail).slice(0, 300) : ""}`); };

const dj = require(path.join(ROOT, "server", "learning", "dailyJob.js"));
const { LEARNED_LEAGUE_IDS } = require(path.join(ROOT, "server", "learning", "learnedCompetitions.js"));

// ============ 案8: 全試合拡張(単体) ============
const mkFx = (id, leagueId, status, kickoffIso, homeId, awayId) => ({
  fixture: { id, status: { short: status }, date: kickoffIso },
  league: { id: leagueId, name: `L${leagueId}` },
  teams: { home: { id: homeId ?? id * 10, name: `Home${id}` }, away: { id: awayId ?? id * 10 + 1, name: `Away${id}` } },
});
{
  const learnedId = Array.from(LEARNED_LEAGUE_IDS)[0];
  const calls = [];
  const capi = async (pathname, params) => {
    calls.push({ pathname, params });
    if (params.date === "2026-09-02") {
      return { response: [
        mkFx(101, learnedId, "NS", "2026-09-02T18:00:00+00:00"),
        mkFx(102, 99999, "NS", "2026-09-02T12:00:00+00:00"),      // 学習外リーグ → 除外
        mkFx(103, learnedId, "FT", "2026-09-02T10:00:00+00:00"),  // 終了済み → 除外
        mkFx(104, learnedId, "NS", "2026-09-02T12:00:00+00:00"),  // 101より早いキックオフ
        { fixture: { id: 105, status: { short: "NS" }, date: "2026-09-02T13:00:00+00:00" }, league: { id: learnedId }, teams: { home: { id: null, name: "X" }, away: { id: 9, name: "Y" } } }, // ID欠落 → 除外
      ] };
    }
    return { response: [
      mkFx(101, learnedId, "NS", "2026-09-02T18:00:00+00:00"),    // 日またぎ重複 → 除外
      mkFx(201, learnedId, "TBD", "2026-09-03T14:00:00+00:00"),   // TBDは対象
      mkFx(202, learnedId, "NS", "2026-09-03T20:00:00+00:00"),
    ] };
  };
  dj.buildExtraFixtureTeams({ callApiFootball: capi }, {
    cap: 3, dates: ["2026-09-02", "2026-09-03"], learnedIds: LEARNED_LEAGUE_IDS,
  }).then((r) => {
    ck("案8: 学習外リーグ・終了済み・ID欠落・重複を除外して対象だけ拾う",
      r.totalEligible === 4 && r.teams.length === 3, JSON.stringify({ eligible: r.totalEligible, queued: r.teams.length }));
    ck("案8: キックオフの近い順に採用(答え合わせが早い試合を優先)",
      r.teams[0].presetFixture.fixture.id === 104 && r.teams[1].presetFixture.fixture.id === 101 && r.teams[2].presetFixture.fixture.id === 201,
      r.teams.map((t) => t.presetFixture.fixture.id).join(","));
    ck("案8: 主体チームはホーム側+API実IDと試合を携行(synthetic印つき)",
      r.teams[0].apiTeamId === 1040 && r.teams[0].synthetic === true && r.teams[0].nameEn === "Home104", JSON.stringify(r.teams[0]));
    ck("案8: 一覧取得は日付あたり1リクエストだけ", calls.length === 2, String(calls.length));
  });
  // cap=0(通常モード)ではAPIを1回も呼ばない
  const calls2 = [];
  dj.buildExtraFixtureTeams({ callApiFootball: async (p) => { calls2.push(p); return { response: [] }; } }, { cap: 0, dates: ["2026-09-02"] })
    .then((r0) => {
      ck("案8: 通常モード(cap=0)は走査ゼロ・API呼び出しゼロ", r0.teams.length === 0 && calls2.length === 0, JSON.stringify(r0));
    });
}
{
  // 公開前フルスロットルの既定値(このプロセスは PRELAUNCH_LEARNING 未設定=ON)
  ck("指示: 公開前モードが既定ON(PRELAUNCH_LEARNING)", dj.PRELAUNCH_LEARNING === true, String(dj.PRELAUNCH_LEARNING));
  ck("指示: 公開前は予測上限90件/日・全試合拡張70件/日", dj.OWN_PREDICT_LOG_CAP === 90 && dj.EXTRA_FIXTURES_CAP === 70,
    JSON.stringify({ log: dj.OWN_PREDICT_LOG_CAP, extra: dj.EXTRA_FIXTURES_CAP }));
  // 環境変数1つで通常モードへ戻る(別プロセスで検証)
  const out = execFileSync(process.execPath, ["-e",
    `const dj=require(${JSON.stringify(path.join(ROOT, "server", "learning", "dailyJob.js"))});` +
    `console.log(JSON.stringify({p:dj.PRELAUNCH_LEARNING,log:dj.OWN_PREDICT_LOG_CAP,extra:dj.EXTRA_FIXTURES_CAP}));`],
    { env: { ...process.env, PRELAUNCH_LEARNING: "0" }, encoding: "utf8" });
  const off = JSON.parse(out.trim().split("\n").pop());
  ck("指示: PRELAUNCH_LEARNING=0 で従来の控えめな値(20件・拡張なし)へ戻る",
    off.p === false && off.log === 20 && off.extra === 0, out.trim());
}
{
  // ループ本体への結線(静的確認)
  const src = fs.readFileSync(path.join(ROOT, "server", "learning", "dailyJob.js"), "utf8");
  ck("案8: 携行IDを最優先(同名別クラブのキャッシュ取り違え防止)",
    src.includes("const teamId = team.apiTeamId || (cached ? cached.teamId : await resolveTeamId(team.nameEn));"), "");
  ck("案8: 携行した試合を直接使い「次の試合」を再検索しない",
    src.includes("team.presetFixture") && src.includes("? { response: [team.presetFixture] }"), "");
  ck("案8: キャッシュはIDまで一致した時だけ使う(subjectForm)",
    src.includes("(cached && cached.teamId === teamId) ? cached"), "");
  ck("案8: 拡張クラブはTOP100カバー率台帳を汚さない",
    src.includes('if (!team.synthetic) await upstashCmd(["HSET", "learn:ownpred:clubcoverage"'), "");
  ck("案8: 予測プールに拡張分を連結し、実測を成長ログへ載せる",
    src.includes("...extraFixtureTeams]") && src.includes("extraFixtures: extraFixturesMeta"), "");
}

// ============ 案10: 粗→細の2段階探索(静的確認) ============
{
  const mt = fs.readFileSync(path.join(ROOT, "server", "learning", "modelTuning.js"), "utf8");
  ck("案10: xGブレンド率αに細かい刻みの再探索がある(fineCandidates)",
    mt.includes("fineCandidates: fineScores") && mt.includes("center - 0.05"), "");
  ck("案10: α=0(混ぜない)が最良なら従来どおり0のままの規則を維持",
    mt.includes("all[0].alpha !== 0) xgAlphaChosen = all[0].alpha"), "");
  ck("案10: 引き分け帯にも細かい刻みの再探索がある(±0.015刻み・範囲0.03〜0.30)",
    mt.includes("fineCandidates: fineScoredBands") && mt.includes("[-0.03, -0.015, 0.015, 0.03]") && mt.includes("b < 0.03 || b > 0.30"), "");
  ck("案10: 細かい候補にも同じ門番(+0.4pt・引き分け0件ガード)が効く",
    mt.includes("const allBands = scoredBands.concat(fineScoredBands);"), "");
}

setTimeout(() => {
  const okCount = results.filter(([, v]) => v).length;
  const ngCount = results.length - okCount;
  console.log(`\n=== 結果: ${okCount}件成功 / ${ngCount}件失敗 ===`);
  process.exit(ngCount ? 1 : 0);
}, 500);
