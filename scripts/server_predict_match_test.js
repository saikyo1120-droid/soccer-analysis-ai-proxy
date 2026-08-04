/**
 * Stage B「予測ロジックAPI化」用のテスト。POST /api/predict-match を実際に
 * HTTPで叩き、(1) 正しい形のレスポンスが返ること、(2) 決定的な部分(確信度・
 * ボール支配率・勝因/弱点テキスト・フォーメーション・危険エリア集計)が旧フロント
 * エンドのロジックと同じ計算式で導出されていること、(3) 入力バリデーションが
 * 効いていること、(4) ランダム性のある部分(予想スコア・試合の流れ・ターニング
 * ポイントの分)が妥当な範囲に収まっていること、を確認する。
 */
const http = require("http");

process.env.API_FOOTBALL_KEY = "test-key-123";
process.env.PORT = "0";
const { server } = require("../server/server.js");

function httpPost(port, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch (e) { resolve({ status: res.statusCode, body }); }
        });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}
function httpGetRaw(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: urlPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

// 攻撃力99・守備力20のような極端な選手を作り、期待するAI判定(勝因/弱点の
// 属性選択、フォーメーション、危険エリア)を計算しやすくする。
function makePlayer(overrides) {
  return Object.assign({
    key: "p" + Math.random().toString(36).slice(2),
    name: "Test Player", nameJa: "テスト選手", emoji: "⚽", overall: 70,
    position: "CM",
    attrs: { attack: 70, shooting: 70, dribbling: 70, passing: 70, tactical: 70, speed: 70, physical: 70, defense: 70 },
    zones: [["中央", 3]],
  }, overrides);
}

(async () => {
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;
  let failures = 0;
  const fail = (msg) => { console.error("FAIL: " + msg); failures++; };
  const ok = (cond, msg) => { if (cond) console.log("  [OK] " + msg); else fail(msg); };

  // ---- 1) 基本的な正常系: レスポンスの形と値の妥当性 ----
  {
    const homePlayers = [
      makePlayer({ overall: 90, position: "ST", attrs: { attack: 95, shooting: 95, dribbling: 90, passing: 80, tactical: 85, speed: 88, physical: 80, defense: 30 }, zones: [["ペナルティエリア内", 5]] }),
      makePlayer({ overall: 85, position: "CB", attrs: { attack: 40, shooting: 30, dribbling: 50, passing: 70, tactical: 80, speed: 65, physical: 88, defense: 92 } }),
      makePlayer({ overall: 82, position: "GK" }),
    ];
    const awayPlayers = [
      makePlayer({ overall: 60, position: "ST" }),
      makePlayer({ overall: 58, position: "CB" }),
    ];
    const r = await httpPost(port, "/api/predict-match", { homeLabel: "ホームFC", awayLabel: "アウェイFC", homePlayers, awayPlayers });
    ok(r.status === 200, "basic request -> 200");
    ok(r.body.ok === true, "basic request -> ok:true");
    ok(Number.isInteger(r.body.homeGoals) && r.body.homeGoals >= 0 && r.body.homeGoals <= 8, "homeGoals is an integer in [0,8]");
    ok(Number.isInteger(r.body.awayGoals) && r.body.awayGoals >= 0 && r.body.awayGoals <= 8, "awayGoals is an integer in [0,8]");
    ok(typeof r.body.confidence === "number", "confidence present");
    ok(r.body.possessionHomePct >= 30 && r.body.possessionHomePct <= 70, "possessionHomePct clamped to [30,70]");
    ok(typeof r.body.styleText === "string" && r.body.styleText.includes("ホームFC") && r.body.styleText.includes("アウェイFC"), "styleText mentions both labels");
    ok(typeof r.body.winFactor === "string" && r.body.winFactor.length > 0, "winFactor present");
    ok(typeof r.body.loseFactor === "string" && r.body.loseFactor.length > 0, "loseFactor present");
    ok(Array.isArray(r.body.matchFlowSegments) && r.body.matchFlowSegments.length === 5, "matchFlowSegments has 5 entries");
    ok(r.body.matchFlowSegments.every((s) => s === "home" || s === "away"), "matchFlowSegments only contains 'home'/'away'");
    // 2026年8月・第7次監査での修正に追随:
    //   以前は `8 + Math.floor(Math.random() * 82)` で作った分数を
    //   「後半67分前後、○○が…」と分析結果のように提示していた。
    //   根拠がゼロの数字なので出さない。分数が含まれないことを検証する。
    ok(typeof r.body.turningPoint === "string" && r.body.turningPoint.length > 0, "turningPoint present");
    ok(!/\d+分/.test(r.body.turningPoint), "根拠の無い分数を提示してはいけない: " + r.body.turningPoint);
    const minuteMatch = r.body.turningPoint.match(/(\d+)分/);
    if (minuteMatch) ok(+minuteMatch[1] >= 8 && +minuteMatch[1] <= 89, "turningPoint minute is within [8,89]");
    ok(r.body.mvp && typeof r.body.mvp.nameJa === "string", "mvp present with nameJa");
    ok(r.body.attackDirection && typeof r.body.attackDirection.homeText === "string" && typeof r.body.attackDirection.awayText === "string", "attackDirection has homeText/awayText");
    ok(Array.isArray(r.body.homeXI) && r.body.homeXI.length > 0, "homeXI is a non-empty array");
    ok(Array.isArray(r.body.awayXI) && r.body.awayXI.length > 0, "awayXI is a non-empty array");
    ok(/^\d+-\d+-\d+$/.test(r.body.homeFormation), "homeFormation looks like 'D-M-F' (e.g. 4-4-2)");
    ok(r.body.dangerZones && Array.isArray(r.body.dangerZones.home) && Array.isArray(r.body.dangerZones.away), "dangerZones.home/away are arrays");
    // home is much stronger (90/85/82 avg=85.67) than away (60/58 avg=59) -> home should be favored
    ok(r.body.confidence > 50, "confidence > 50 when home is clearly stronger");
    ok(r.body.homeOverall > r.body.awayOverall, "homeOverall > awayOverall reflects the stronger roster");
  }

  // ---- 2) 決定的な計算式の検証: 旧フロントエンドの計算式と一致するか ----
  {
    // shooting=99を1名だけ極端に高くし、defenseは全員低くする -> 勝因はshooting、弱点はdefenseになるはず
    const strongShooter = makePlayer({ overall: 80, attrs: { attack: 80, shooting: 99, dribbling: 80, passing: 80, tactical: 80, speed: 80, physical: 80, defense: 20 } });
    const weakOpponent = makePlayer({ overall: 50, attrs: { attack: 55, shooting: 55, dribbling: 55, passing: 55, tactical: 55, speed: 55, physical: 55, defense: 15 } });
    const r = await httpPost(port, "/api/predict-match", { homeLabel: "強打線FC", awayLabel: "平凡FC", homePlayers: [strongShooter], awayPlayers: [weakOpponent] });
    ok(r.body.winFactor.includes("シュート"), "winFactor correctly picks the attribute with the largest advantage (shooting)");
    ok(r.body.loseFactor.includes("守備"), "loseFactor correctly picks the weakest attribute of the loser (defense)");

    // 期待される確信度を手計算して比較(旧ロジック: round(50 + min(38, abs(diff)*2.6)))
    const diff = 80 - 50;
    const expectedConfidence = Math.round(50 + Math.min(38, Math.abs(diff) * 2.6));
    ok(r.body.confidence === expectedConfidence, `confidence formula matches legacy formula (expected ${expectedConfidence}, got ${r.body.confidence})`);
  }

  // ---- 3) 危険エリア集計ロジックの検証 ----
  {
    const p1 = makePlayer({ attrs: { attack: 70, shooting: 90, dribbling: 90, passing: 50, tactical: 50, speed: 50, physical: 50, defense: 50 }, zones: [["右ハーフスペース", 5], ["中央", 2]] });
    const p2 = makePlayer({ attrs: { attack: 70, shooting: 20, dribbling: 20, passing: 50, tactical: 50, speed: 50, physical: 50, defense: 50 }, zones: [["左サイド", 5]] });
    const r = await httpPost(port, "/api/predict-match", { homeLabel: "H", awayLabel: "A", homePlayers: [p1, p2], awayPlayers: [makePlayer()] });
    const homeZoneLabels = r.body.dangerZones.home.map((z) => z.zoneLabel);
    // p1 has the higher shooting+dribbling so should dominate the top-3 attacker selection
    ok(homeZoneLabels.includes("右ハーフスペース") && homeZoneLabels.includes("中央"), "dangerZones prioritizes the strongest attacker's zones");
  }

  // ---- 4) バリデーション ----
  {
    const r1 = await httpPost(port, "/api/predict-match", { homeLabel: "H", homePlayers: [], awayPlayers: [] });
    ok(r1.status === 400, "missing awayLabel -> 400");

    const r2 = await httpPost(port, "/api/predict-match", { homeLabel: "H", awayLabel: "A", homePlayers: "not-an-array", awayPlayers: [] });
    ok(r2.status === 400, "homePlayers not an array -> 400");

    const r3 = await httpPost(port, "/api/predict-match", { homeLabel: "H", awayLabel: "A", homePlayers: [{ overall: 70 }], awayPlayers: [] });
    ok(r3.status === 400, "player missing attrs -> 400");

    const tooMany = Array.from({ length: 61 }, () => makePlayer());
    const r4 = await httpPost(port, "/api/predict-match", { homeLabel: "H", awayLabel: "A", homePlayers: tooMany, awayPlayers: [] });
    ok(r4.status === 400, "too many players per side -> 400");

    const r5raw = await httpGetRaw(port, "/api/predict-match");
    ok(r5raw.status === 405, "GET on /api/predict-match -> 405 (POST only)");
  }

  // ---- 5) 空ロースター(登録選手が0人)は、架空の平均値で比較せず正直に断る ----
  // 2026年8月・第6次監査での仕様変更に追随。
  //   以前は200を返していたが、その中身は teamAvgSrv の固定値62から作られた
  //   「◯◯は攻撃力で相手を上回っており(平均62.0 対 62.0)」という、
  //   実データに基づかない(しかも両者同値の)比較文だった。
  //   比較材料が無いときは、でっち上げるより断る方がこのプロジェクトの方針に合う。
  {
    const r = await httpPost(port, "/api/predict-match", { homeLabel: "H", awayLabel: "A", homePlayers: [], awayPlayers: [] });
    ok(r.status === 400 && r.body.ok === false, "empty rosters are rejected instead of fabricating averages, got " + r.status);
    ok(typeof r.body.messageJa === "string" && r.body.messageJa.includes("比較"), "rejection explains why in Japanese: " + r.body.messageJa);
  }

  // ---- 5b) 片側だけ空の場合も同じ(こちらは以前、片側だけ62で比較されていた) ----
  {
    const r = await httpPost(port, "/api/predict-match", {
      homeLabel: "H", awayLabel: "A",
      homePlayers: [{ nameJa: "選手A", overall: 80, attrs: { attack: 80, defense: 70, physical: 75, technique: 82, speed: 78, mental: 74 } }],
      awayPlayers: [],
    });
    ok(r.status === 400 && r.body.ok === false, "one empty side is also rejected, got " + r.status);
  }

  server.close();
  console.log(failures === 0 ? "\nPredict-match API PASSED." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
