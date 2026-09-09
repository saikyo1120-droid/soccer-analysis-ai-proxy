"use strict";
/** v89: 「まだ女性の選手が混ざっています」(利用者の指摘)への根治テスト。
 *
 *  本番で実測した混入経路(2026年9月9日):
 *   選手索引に「M. Tanikawa / Bayern Munich / リーグ78」として女子選手が実在した。
 *   提供元(API-Football)がクラブの**男子チームID**に女子部門の成績を紐づけているため、
 *   行にはクラブ設定の男子ラベルが刻印され、v74のチーム名フィルタ(W・Women等)では
 *   構造的に見えなかった。
 *
 *  検証すること:
 *   ① 判定ヘルパー: 女子大会・女子チーム表記を検出し、男子の大会名では誤爆しない
 *   ② 質問時のライブ検索(実サーバー+モックAPI): 女子成績しか無い選手は
 *      「男子サッカー専用のため対象外」と正直に返す(男子として表示しない)
 *   ③ 収集側の全入口(一括・詳細・名簿・バッチ・登録選手日次)に同じ判定が入っている
 *   ④ 既存混入の自動掃除: 索引の持ち越しで女子判定の選手を落とす(ソース検査)
 *   ⑤ 男子選手の挙動は不変(v88のSakaケースが引き続き成立することはv88テストが保証) */
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { isWomensStatEntry, filterMensStatEntries } = require("./learning/playerFeatures");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + e.message); } };

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  await t("①a 女子大会・女子チーム表記を検出する(リーグ名・チーム名の両方)", async () => {
    const womens = [
      { league: { name: "Frauen Bundesliga" }, team: { name: "FC Bayern München" } }, // 本番実測の型(チーム名は男子と同じ)
      { league: { name: "FA Women's Super League" }, team: { name: "Arsenal" } },
      { league: { name: "Liga F" }, team: { name: "Barcelona" } },
      { league: { name: "NWSL" }, team: { name: "Portland" } },
      { league: { name: "WEリーグ 女子" }, team: { name: "INAC神戸" } },
      { league: { name: "Serie A Femminile" }, team: { name: "Juventus" } },
      { league: { name: "Premier League" }, team: { name: "Chelsea W" } }, // 末尾W表記
      { league: { name: "Toppserien" }, team: { name: "Rosenborg" } },
    ];
    for (const st of womens) assert.strictEqual(isWomensStatEntry(st), true, "検出漏れ: " + JSON.stringify(st));
  });

  await t("①b 男子の大会・クラブ名では誤爆しない(W始まりの単語・大会名など)", async () => {
    const mens = [
      { league: { name: "Bundesliga" }, team: { name: "FC Bayern München" } },
      { league: { name: "Premier League" }, team: { name: "West Ham United" } },
      { league: { name: "Bundesliga" }, team: { name: "VfL Wolfsburg" } },
      { league: { name: "World Cup" }, team: { name: "Japan" } },
      { league: { name: "Club World Cup" }, team: { name: "Real Madrid" } },
      { league: { name: "J1 League" }, team: { name: "Kawasaki Frontale" } },
      { league: { name: "Ligue 1" }, team: { name: "Paris Saint Germain" } },
      { league: { name: "Liga Profesional Argentina" }, team: { name: "River Plate" } },
      { league: {}, team: {} }, // 情報が無いエントリーは男子扱い(消しすぎない)
    ];
    for (const st of mens) assert.strictEqual(isWomensStatEntry(st), false, "誤爆: " + JSON.stringify(st));
  });

  await t("①c filterMensStatEntries: 混在は男子だけ残す/女子のみはwomensOnly/空はwomensOnlyでない", async () => {
    const w = { league: { name: "Frauen Bundesliga" }, team: { name: "FC Bayern München" } };
    const m = { league: { name: "Bundesliga" }, team: { name: "FC Bayern München" } };
    const mixed = filterMensStatEntries([w, m]);
    assert.strictEqual(mixed.womensOnly, false);
    assert.deepStrictEqual(mixed.mens, [m], "男子エントリーだけが残っていない");
    const only = filterMensStatEntries([w, w]);
    assert.strictEqual(only.womensOnly, true);
    assert.strictEqual(only.mens.length, 0);
    const empty = filterMensStatEntries([]);
    assert.strictEqual(empty.womensOnly, false, "空リストがwomensOnly扱いになっている(未出場の男子選手を消してしまう)");
  });

  await t("② ライブ検索: 女子成績しか無い選手は『男子サッカー専用のため対象外』と正直に返す(実サーバー+モックAPI)", async () => {
    // 本番実測の型を忠実に再現: 男子チームID(157)の応答に、女子ブンデスリーガの
    // 成績しか持たない選手が含まれる。チーム名は男子と同じ(Wマーカー無し)。
    const tanikawaEntry = {
      player: { id: 501001, name: "M. Tanikawa", nationality: "Japan", birth: { date: "2005-04-01" } },
      statistics: [
        { team: { id: 157, name: "FC Bayern München" }, league: { id: 82, name: "Frauen Bundesliga" }, games: { appearences: 3, minutes: 180, rating: "7.95", position: "Midfielder" }, goals: { total: 2, assists: 0 }, cards: {} },
      ],
    };
    const mock = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const reply = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ errors: [], results: 1, paging: {}, ...obj })); };
      if (u.pathname === "/teams") return reply({ response: [{ team: { id: 157, name: "Bayern Munich" } }] });
      if (u.pathname === "/players") {
        if (u.searchParams.get("id") === "501001") return reply({ response: [tanikawaEntry] });
        if (/tanikawa/i.test(u.searchParams.get("search") || "")) return reply({ response: [tanikawaEntry] });
        return reply({ response: [] });
      }
      reply({ response: [] });
    });
    await new Promise((r) => mock.listen(8899, "127.0.0.1", r));
    const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: "8900", API_FOOTBALL_API_BASE: "http://127.0.0.1:8899", API_FOOTBALL_KEY: "test-key", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", ANTHROPIC_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server boot timeout")), 15000);
        const poll = async () => {
          try { const r = await httpGet("http://127.0.0.1:8900/api/health"); if (r.status) { clearTimeout(timer); resolve(); return; } } catch (e) {}
          setTimeout(poll, 300);
        };
        poll();
      });
      const r = await httpGet("http://127.0.0.1:8900/api/player-season-stats?name=Tanikawa&teamEn=" + encodeURIComponent("Bayern Munich"));
      assert.strictEqual(r.status, 200);
      const b = JSON.parse(r.body);
      assert.strictEqual(b.found, false, "女子成績の選手が男子として返っている: " + r.body.slice(0, 200));
      assert.strictEqual(b.reason, "womens_football_not_covered", "理由が正直でない: " + b.reason);
      assert.ok(b.noteJa && b.noteJa.includes("男子サッカー専用"), "説明が無い: " + b.noteJa);
    } finally {
      srv.kill("SIGKILL");
      await new Promise((r) => mock.close(r));
    }
  });

  await t("③ 収集側の全入口に同じ判定が入っている(ソース検査)", async () => {
    const uc = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
    assert.ok(uc.includes("filterMensStatEntries") && uc.includes("womensExcluded"), "収集側に判定が無い");
    assert.ok(uc.includes("if (womensSplit.womensOnly) { noteWomensExcluded(pl.id, pl.name, listAll[0]); continue; }"), "一括取得(③-b)に判定が無い");
    assert.ok(uc.includes("if (womensSplitD.womensOnly) {"), "詳細取得(④)に判定が無い");
    assert.ok(uc.includes("if (womensExcluded.has(Number(p.id))) continue;"), "名簿経由の保存に判定が無い");
    assert.ok(uc.includes("if (womensSplitB.womensOnly) continue;"), "バッチ収集(collect-players)に判定が無い");
    const pdu = fs.readFileSync(path.join(__dirname, "learning", "playerDailyUpdate.js"), "utf8");
    assert.ok(pdu.includes("filterMensStatEntries"), "登録選手の日次更新に判定が無い");
  });

  await t("④ 既存混入の自動掃除: 索引に載せない+持ち越しでも落とす+除外を隠さず記録(ソース検査)", async () => {
    const uc = fs.readFileSync(path.join(__dirname, "learning", "universeCollector.js"), "utf8");
    assert.ok(uc.includes("for (const id of womensExcluded.keys()) merged.delete(id);"), "当日分の除外が無い");
    assert.ok(uc.includes("if (womensExcluded.has(id)) { droppedWomens++; continue; }"), "持ち越し行の掃除が無い(過去の混入が60日残ってしまう)");
    assert.ok(uc.includes("stats.womensExcluded = {"), "除外の実測記録が無い");
    assert.ok(uc.includes("男子サッカー専用の方針により"), "除外理由の開示文が無い");
  });

  console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
