"use strict";
/** v87: 利用者の指示「①リーグ別ホームアドバンテージ・③学習リーグ拡張・④クラブElo復旧を実装して」のテスト。
 *  検証すること:
 *   ①-1 既定(フラグ無し)は従来と同一の出力形(homeAdvByLeague無し=挙動不変)
 *   ①-2 リーグ別学習が「ホーム有利の差」を正しい方向に学習する(合成データ)
 *   ①-3 expGoalsFromRatingsの第4引数: リーグ別値を使う/不明リーグ・リーグ無しは全体値/JSON往復後も動く
 *   ①-4 リーグIDの無い行だけでも壊れない(全体値で動く)
 *   ①-5 modelTuningの門番の構造(マージン・採用条件・本番保存への伝搬)がソースに存在する
 *   ③-1 15大会になっている(J1=98・チャンピオンシップ=40・ブラジル=71)
 *   ③-2 学習済み判定が新リーグに自動追従する(ID・名前の補助判定・15大会の文言)
 *   ③-3 保存容量が15大会×5シーズンに足りる(切り詰めで黙ってシーズンが欠けない)
 *   ④-1 中継の受け口: 鍵必須(未設定503)・不一致403・GET405・短いCSV400・日付検証400・正常200で正しい形の保存
 *   ④-2 学習側(getDailyElo)は同日の中継データがあればネットワークを一切呼ばずに使う
 *   ④-3 GitHub Actionsワークフローが存在し、学習前の時刻に取得→POSTする内容になっている */
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { fitTeamRatings, expGoalsFromRatings } = require("./learning/teamRatings");
const { DEFAULT_BACKFILL_LEAGUES, MAX_STORED_MATCHES, BACKFILL_SHARD_SIZE, BACKFILL_MAX_SHARDS } = require("./learning/historicalBackfill");
const { LEARNED_LEAGUE_IDS, classifyLearnedCompetition } = require("./learning/learnedCompetitions");
const { getDailyElo } = require("./learning/clubElo");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

// 合成データ: リーグ100はホーム大有利(λ2.0/0.8)・リーグ200はホーム利なし(λ1.2/1.2)
function synthTwoLeagues(seed) {
  let s = seed || 12345;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const pois = (lam) => { const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= rand(); } while (p > L); return k - 1; };
  const rows = []; let day = 0;
  const mk = (lg, teams, lamH, lamA) => {
    for (let rep = 0; rep < 4; rep++) for (let i = 0; i < teams.length; i++) for (let j = 0; j < teams.length; j++) {
      if (i === j) continue; day++;
      rows.push({ leagueId: lg, homeId: teams[i], awayId: teams[j], date: new Date(2026, 0, (day % 300) + 1).toISOString(), actualHomeGoals: pois(lamH), actualAwayGoals: pois(lamA) });
    }
  };
  mk(100, Array.from({ length: 12 }, (_, k) => k + 1), 2.0, 0.8);
  mk(200, Array.from({ length: 12 }, (_, k) => k + 101), 1.2, 1.2);
  return rows;
}

function httpReq(method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const rows = synthTwoLeagues();

  await t("①-1 既定(フラグ無し)は従来形のまま: homeAdvByLeague無し・mode=global(挙動不変)", async () => {
    const g = fitTeamRatings(rows, { minMatches: 10 });
    assert.strictEqual(g.homeAdvMode, "global");
    assert.strictEqual(g.homeAdvByLeague, null, "既定でリーグ別値が入ってしまっている");
    const g2 = fitTeamRatings(rows, { minMatches: 10, perLeagueHomeAdv: false });
    assert.deepStrictEqual(g2.byTeam, g.byTeam, "perLeagueHomeAdv:falseで結果が変わった(挙動不変が壊れている)");
    assert.strictEqual(g2.homeAdv, g.homeAdv);
  });

  await t("①-2 リーグ別学習が方向を正しく学ぶ(大有利リーグ>利なしリーグ、差0.3以上)", async () => {
    const p = fitTeamRatings(rows, { minMatches: 10, perLeagueHomeAdv: true });
    assert.strictEqual(p.available, true, "available=false: " + p.reasonJa);
    assert.strictEqual(p.homeAdvMode, "perLeague");
    assert.ok(p.homeAdvByLeague && Number.isFinite(p.homeAdvByLeague[100]) && Number.isFinite(p.homeAdvByLeague[200]), "リーグ別値が無い");
    assert.ok(p.homeAdvByLeague[100] > p.homeAdvByLeague[200] + 0.3,
      `方向が違う: lg100=${p.homeAdvByLeague[100]} lg200=${p.homeAdvByLeague[200]}`);
  });

  await t("①-3 expGoalsFromRatings第4引数: リーグ別値/全体値フォールバック/JSON往復", async () => {
    const p = fitTeamRatings(rows, { minMatches: 10, perLeagueHomeAdv: true });
    const rt = JSON.parse(JSON.stringify(p)); // 本番はUpstash保存→読み出し(キーは文字列化される)
    const egA = expGoalsFromRatings(rt, 1, 2, 100);
    const egB = expGoalsFromRatings(rt, 101, 102, 200);
    assert.ok(egA && egB, "期待得点が返らない");
    assert.ok(egA.home / egA.away > egB.home / egB.away, "リーグ別ホーム有利が期待得点へ反映されていない");
    const egNo = expGoalsFromRatings(rt, 1, 2);           // 3引数(従来呼び出し)
    const egNull = expGoalsFromRatings(rt, 1, 2, null);   // リーグ不明
    const egUnk = expGoalsFromRatings(rt, 1, 2, 99999);   // 学習に無いリーグ
    assert.strictEqual(egNull.home, egNo.home, "null指定が全体値になっていない");
    assert.strictEqual(egUnk.home, egNo.home, "未知リーグが全体値になっていない");
  });

  await t("①-4 リーグIDの無い行だけでも壊れない(リーグ別値は付かず、全体値で動く)", async () => {
    const noLg = rows.map((r) => { const c = { ...r }; delete c.leagueId; return c; });
    const p = fitTeamRatings(noLg, { minMatches: 10, perLeagueHomeAdv: true });
    assert.strictEqual(p.available, true);
    assert.strictEqual(p.homeAdvByLeague, null, "リーグIDが無いのにリーグ別値ができている(でっち上げ)");
    assert.ok(expGoalsFromRatings(p, 1, 2, 100), "全体値での計算ができない");
  });

  await t("①-5 modelTuningの門番の構造(マージン0.0005・採用条件・本番保存への伝搬・検証へのリーグID伝搬)", async () => {
    const src = fs.readFileSync(path.join(__dirname, "learning", "modelTuning.js"), "utf8");
    assert.ok(src.includes("HOMEADV_ADOPT_MARGIN = 0.0005"), "採用マージンが無い");
    assert.ok(src.includes("perLoss <= globalLoss - HOMEADV_ADOPT_MARGIN"), "「意味のある差で勝った時だけ採用」の条件が無い");
    assert.ok(src.includes('homeAdvModeChosen = "perLeague";') && src.includes("ratingsTrain = rtPerLeague;"),
      "採用時にratingsTrainを勝った方へ差し替えていない");
    assert.ok(src.includes('perLeagueHomeAdv: homeAdvModeChosen === "perLeague"'), "本番保存用の学習へモードが伝搬していない");
    assert.ok(src.includes("expGoalsFromRatings(ratings, r.homeId, r.awayId, r.leagueId)"), "検証時の期待得点計算にリーグIDが渡っていない");
    // 劣化禁止: 学習データ不足時は探索せず全体値
    assert.ok(src.includes("リーグ別ホームアドバンテージの検証に必要な500件"), "データ不足時のガードが無い");
    // v87.1(監査での指摘⑨の予防): リーグ別の本番学習だけが失敗した日は全体値で保存し直す
    assert.ok(src.includes("homeAdvFullFitFallback = true"), "本番学習失敗時の全体値フォールバックが無い");
  });

  await t("③-1 15大会になっている(J1=98・チャンピオンシップ=40・ブラジル=71・既存12はそのまま)", async () => {
    assert.strictEqual(DEFAULT_BACKFILL_LEAGUES.length, 15, "大会数=" + DEFAULT_BACKFILL_LEAGUES.length);
    const byId = new Map(DEFAULT_BACKFILL_LEAGUES.map((l) => [l.id, l]));
    assert.ok(byId.get(98) && byId.get(98).nameJa === "J1リーグ", "J1(98)が無い/名前違い");
    assert.ok(byId.get(40) && /チャンピオンシップ/.test(byId.get(40).nameJa), "チャンピオンシップ(40)が無い");
    assert.ok(byId.get(71) && /ブラジル/.test(byId.get(71).nameJa), "ブラジル(71)が無い");
    for (const id of [39, 140, 78, 135, 61, 88, 94, 203, 144, 2, 3, 848]) assert.ok(byId.has(id), `既存の大会${id}が消えている`);
  });

  await t("③-2 学習済み判定が自動追従(ID判定・名前の補助判定・未学習文言が15大会)", async () => {
    for (const id of [98, 40, 71]) {
      assert.strictEqual(LEARNED_LEAGUE_IDS.has(id), true, `LEARNED_LEAGUE_IDSに${id}が無い`);
      assert.strictEqual(classifyLearnedCompetition(id, null).learned, true, `ID${id}が学習済みにならない`);
    }
    // v87.1(監査を受けた修正): 名前の補助判定はID保存開始前の古い記録専用。その時代に
    // 新3リーグは学習されていなかったので、名前では学習済みに**しない**(遡っての化けを防ぐ)。
    // これは「Championship」(スコットランド2部と同名)の誤マッチも同時に防ぐ。
    assert.strictEqual(classifyLearnedCompetition(null, "J1 League").learned, false, "IDの無い古いJ1記録が学習済みに化けている");
    assert.strictEqual(classifyLearnedCompetition(null, "Championship").learned, false, "IDの無い古いChampionship記録が学習済みに化けている");
    assert.strictEqual(classifyLearnedCompetition(null, "Premier League").learned, true, "既存の名前補助(当時から学習済み)が壊れた");
    const un = classifyLearnedCompetition(999, "Major League Soccer");
    assert.strictEqual(un.learned, false);
    assert.ok(un.reasonJa.includes("15大会"), "未学習の説明が15大会になっていない: " + un.reasonJa);
    assert.ok(!un.reasonJa.includes("12大会"), "未学習の説明に古い12大会が残っている");
  });

  await t("①-6 v87.1: 試合数が下限未満のリーグはoffsetを学習しない(1試合9-0でもリーグ別値を作らない)", async () => {
    // 大量データのリーグ100+「1試合だけ9-0」のリーグ999を混ぜる
    const tiny = rows.concat([{ leagueId: 999, homeId: 1, awayId: 2, date: new Date(2026, 0, 5).toISOString(), actualHomeGoals: 9, actualAwayGoals: 0 }]);
    const p = fitTeamRatings(tiny, { minMatches: 10, perLeagueHomeAdv: true });
    assert.strictEqual(p.available, true);
    assert.ok(p.homeAdvByLeague && Number.isFinite(p.homeAdvByLeague[100]), "正常リーグの値が消えた");
    assert.strictEqual(p.homeAdvByLeague[999], undefined, "1試合のリーグにoffsetができている(でっち上げ)");
    // 下限未満リーグの試合も全体値の学習には正常に寄与する(NaN化しない)
    assert.ok(Number.isFinite(p.homeAdv) && Number.isFinite(p.mu), "下限未満リーグの混入で数値が壊れた");
  });

  await t("③-3 保存容量が15大会×5シーズンに足りる(上限28,000・ブロック容量がそれ以上)", async () => {
    assert.strictEqual(MAX_STORED_MATCHES, 28000, "MAX_STORED_MATCHES=" + MAX_STORED_MATCHES);
    assert.ok(BACKFILL_SHARD_SIZE * BACKFILL_MAX_SHARDS >= MAX_STORED_MATCHES,
      `ブロック容量${BACKFILL_SHARD_SIZE * BACKFILL_MAX_SHARDS} < 上限${MAX_STORED_MATCHES}(保存で黙って切れる)`);
    // 15大会×5シーズンの概算(J1≒306・英2部≒552・ブラジル≒380/シーズン込み)が上限内
    const rough = (380 + 380 + 306 + 380 + 342 + 306 + 306 + 342 + 240 + 140 + 140 + 140 + 306 + 552 + 380) * 5;
    assert.ok(rough <= MAX_STORED_MATCHES, `概算${rough}件が上限を超える`);
  });

  await t("③-4 学習のリーグ名表(LEAGUE_NAMES_JA)に3リーグがある(表でIDのまま出さない)", async () => {
    const src = fs.readFileSync(path.join(__dirname, "learning", "modelTuning.js"), "utf8");
    assert.ok(src.includes('98: "J1リーグ"') && src.includes("40: \"チャンピオンシップ(イングランド2部)\"") && src.includes('71: "ブラジル全国選手権"'),
      "LEAGUE_NAMES_JAに新リーグの名前が無い");
  });

  // ---- ④ 中継の受け口(モックUpstash+実サーバー起動) ----
  const CSV_HEADER = "Rank,Club,Country,Level,Elo,From,To";
  const bigCsv = [CSV_HEADER].concat(Array.from({ length: 594 }, (_, i) => `${i + 1},Club${i + 1},XX,1,${1500 + (i % 300)},2026-09-09,2026-09-09`)).join("\n");

  await t("④-1 受け口: 405/403/短いCSV400/日付検証/鮮度ガード/値域検証/正常200と正しい保存形", async () => {
    const setCalls = [];
    const kv = new Map(); // v87.1: 鮮度ガードのテストにはGETが実際に保存値を返る必要がある
    const mockUpstash = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let cmds = [];
        try { const j = JSON.parse(body); cmds = Array.isArray(j[0]) ? j : [j]; } catch (e) {}
        const results = cmds.map((c) => {
          if (c[0] === "SET") { setCalls.push(c); kv.set(c[1], c[2]); return { result: "OK" }; }
          if (c[0] === "GET") return { result: kv.has(c[1]) ? kv.get(c[1]) : null };
          return { result: null };
        });
        res.writeHead(200, { "content-type": "application/json" });
        // 単発コマンドは {result}、/pipelineは配列で返す(本物のUpstashと同じ形)
        res.end(req.url.includes("pipeline") ? JSON.stringify(results) : JSON.stringify(results[0] || { result: null }));
      });
    });
    await new Promise((r) => mockUpstash.listen(8891, "127.0.0.1", r));
    const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: {
        ...process.env, PORT: "8892",
        UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8891", UPSTASH_REDIS_REST_TOKEN: "t",
        AUTO_COLLECT_SECRET: "v87secret", API_FOOTBALL_KEY: "", ANTHROPIC_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server boot timeout")), 15000);
        const poll = async () => {
          try { const r = await httpReq("GET", "http://127.0.0.1:8892/api/health"); if (r.status) { clearTimeout(timer); resolve(); return; } } catch (e) {}
          setTimeout(poll, 300);
        };
        poll();
      });
      const base = "http://127.0.0.1:8892/api/clubelo/ingest";
      const today = new Date().toISOString().slice(0, 10);
      const r405 = await httpReq("GET", `${base}?key=v87secret`);
      assert.strictEqual(r405.status, 405, "GETが405でない: " + r405.status);
      const r403 = await httpReq("POST", `${base}?key=wrong`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(r403.status, 403, "鍵違いが403でない: " + r403.status);
      const rShort = await httpReq("POST", `${base}?key=v87secret`, CSV_HEADER + "\n1,OnlyClub,XX,1,1500,,", { "Content-Type": "text/csv" });
      assert.strictEqual(rShort.status, 400, "短いCSVが400でない: " + rShort.status);
      assert.ok(rShort.body.includes("半端なデータで上書きしない"), "短いCSV拒否の正直な説明が無い");
      const rDate = await httpReq("POST", `${base}?key=v87secret&date=2020-01-01`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rDate.status, 400, "古い日付が400でない: " + rDate.status);
      // ---- v87.1(監査での指摘①): 実在しない日付・繰り上がる日付を弾く ----
      for (const bad of ["2026-13-45", "2026-02-31", "2026-00-10"]) {
        const rBad = await httpReq("POST", `${base}?key=v87secret&date=${bad}`, bigCsv, { "Content-Type": "text/csv" });
        assert.strictEqual(rBad.status, 400, `実在しない日付${bad}が通ってしまう: ` + rBad.status);
      }
      // ---- v87.1(監査での指摘②): 未来の日付を弾く ----
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const rFuture = await httpReq("POST", `${base}?key=v87secret&date=${tomorrow}`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rFuture.status, 400, "未来の日付が通ってしまう: " + rFuture.status);
      // ---- v87.1(監査での指摘⑥): 値域外のEloだらけのCSVは保存しない ----
      const junkCsv = [CSV_HEADER].concat(Array.from({ length: 150 }, (_, i) => `${i + 1},Junk${i + 1},XX,1,99999999,,`)).join("\n");
      const rJunk = await httpReq("POST", `${base}?key=v87secret`, junkCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rJunk.status, 400, "値域外のEloが受理されてしまう: " + rJunk.status);
      const rOk = await httpReq("POST", `${base}?key=v87secret&date=${today}`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rOk.status, 200, `正常系が200でない: ${rOk.status} ${rOk.body.slice(0, 200)}`);
      const okBody = JSON.parse(rOk.body);
      assert.strictEqual(okBody.ok, true);
      assert.strictEqual(okBody.rows, 594, "受理行数=" + okBody.rows);
      const setDaily = setCalls.find((c) => c[1] === "learn:clubelo:daily");
      assert.ok(setDaily, "learn:clubelo:daily への SET が無い");
      const saved = JSON.parse(setDaily[2]);
      assert.strictEqual(saved.date, today);
      assert.strictEqual(saved.source, "gh-relay", "来歴sourceが無い");
      assert.strictEqual(saved.list.length, 594);
      assert.deepStrictEqual(saved.list[0], ["Club1", "XX", 1500], "listの形が[[club,country,elo]]でない: " + JSON.stringify(saved.list[0]));
      // ---- v87.1(監査での指摘②): 鮮度ガード=新しい保存を古い日付で潰せない(同日の再送は可) ----
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const rStale = await httpReq("POST", `${base}?key=v87secret&date=${yesterday}`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rStale.status, 409, "古い日付が新しい保存を潰せてしまう: " + rStale.status);
      const rResend = await httpReq("POST", `${base}?key=v87secret&date=${today}`, bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rResend.status, 200, "同日の再送が拒否された: " + rResend.status);
      // ---- v87.1: 値域外の行が混ざったCSVは、正常行だけを保存する ----
      const mixedCsv = bigCsv + "\n999,BrokenClub,XX,1,99999999,,";
      const rMixed = await httpReq("POST", `${base}?key=v87secret&date=${today}`, mixedCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(rMixed.status, 200);
      const lastSet = setCalls.filter((c) => c[1] === "learn:clubelo:daily").pop();
      const savedMixed = JSON.parse(lastSet[2]);
      assert.strictEqual(savedMixed.list.length, 594, "壊れた行が保存に混ざった: " + savedMixed.list.length);
      assert.ok(!savedMixed.list.some((row) => row[0] === "BrokenClub"), "値域外のクラブが保存されている");
    } finally {
      srv.kill("SIGKILL");
      await new Promise((r) => mockUpstash.close(r));
    }
  });

  await t("④-2 鍵未設定の環境では受け口が503(無認証で学習データを書かせない)", async () => {
    const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: "8893", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", AUTO_COLLECT_SECRET: "", API_FOOTBALL_KEY: "", ANTHROPIC_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server boot timeout")), 15000);
        const poll = async () => {
          try { const r = await httpReq("GET", "http://127.0.0.1:8893/api/health"); if (r.status) { clearTimeout(timer); resolve(); return; } } catch (e) {}
          setTimeout(poll, 300);
        };
        poll();
      });
      const r = await httpReq("POST", "http://127.0.0.1:8893/api/clubelo/ingest?key=anything", bigCsv, { "Content-Type": "text/csv" });
      assert.strictEqual(r.status, 503, "鍵未設定で503でない: " + r.status);
      assert.ok(r.body.includes("AUTO_COLLECT_SECRET"), "原因の説明が無い");
    } finally { srv.kill("SIGKILL"); }
  });

  await t("④-3 学習側は同日の中継データがあればネットワークを呼ばない(既存の同日再利用がそのまま効く)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    let networkCalled = false;
    const out = await getDailyElo({
      upstashGetJSON: async () => ({ date: today, list: [["Arsenal", "ENG", 1990.5], ["Bayern", "GER", 1985.2]], source: "gh-relay", ingestedAt: new Date().toISOString() }),
      upstashSetJSON: async () => true,
      fetchFn: async () => { networkCalled = true; throw new Error("network must not be called"); },
    }, Date.now());
    assert.strictEqual(networkCalled, false, "同日の保存があるのにネットワークを呼んだ");
    assert.strictEqual(out.rows.length, 2);
    assert.strictEqual(out.rows[0].club, "Arsenal");
    assert.strictEqual(out.staleDays, 0);
    assert.strictEqual(out.error, null);
  });

  await t("④-4 中継ワークフローが存在し、学習前の時刻・取得→検証→POSTの内容になっている", async () => {
    const cands = [path.join(__dirname, "..", ".github", "workflows", "clubelo-relay.yml"),
      path.join(__dirname, ".github", "workflows", "clubelo-relay.yml")];
    const p = cands.find((c) => fs.existsSync(c));
    assert.ok(p, "clubelo-relay.yml が見つからない");
    const y = fs.readFileSync(p, "utf8");
    assert.ok(y.includes('cron: "51 18 * * *"'), "学習(19:17)前のcronが無い");
    assert.ok(y.includes('cron: "21 23 * * *"'), "バックアップ学習(23:43)前のcronが無い");
    assert.ok(y.includes("api.clubelo.com/${DATE_UTC}"), "clubeloからの取得が無い");
    assert.ok(y.includes("/api/clubelo/ingest?key="), "本番へのPOSTが無い");
    assert.ok(y.includes("--data-binary @elo.csv"), "CSV本文の送信が無い");
    assert.ok(y.includes('-lt 100'), "行数の検証(半端なデータを送らない)が無い");
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
