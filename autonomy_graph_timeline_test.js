/**
 * scripts/autonomy_graph_timeline_test.js
 * ------------------------------------------------
 * 2026年8月・優先順位⑫⑲⑳の検証。
 *
 *   ⑫ 自律学習判断      … server/learning/importanceEngine.js
 *   ⑲ Knowledge Graph  … server/knowledge/knowledgeGraph.js
 *   ⑳ 考えの変化の時系列 … server/memory/thoughtTimeline.js
 *
 * 実行方法: node scripts/autonomy_graph_timeline_test.js
 */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { assessImportance, summarizeImportance } = require(path.join(ROOT, "server/learning/importanceEngine"));
const { createKnowledgeGraph } = require(path.join(ROOT, "server/knowledge/knowledgeGraph"));
const { createThoughtTimeline } = require(path.join(ROOT, "server/memory/thoughtTimeline"));

let failures = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function createMockRedis() {
  const store = new Map();
  const lists = new Map();
  async function upstashCmd(cmd) {
    const [op, key, ...rest] = cmd;
    if (op === "GET") return store.has(key) ? store.get(key) : null;
    if (op === "SET") { store.set(key, rest[0]); return "OK"; }
    if (op === "RPUSH") { const l = lists.get(key) || []; l.push(rest[0]); lists.set(key, l); return l.length; }
    if (op === "LRANGE") {
      const l = lists.get(key) || [];
      const a = Number(rest[0]); const b = Number(rest[1]);
      return l.slice(a < 0 ? l.length + a : a, b === -1 ? undefined : (b < 0 ? l.length + b + 1 : b + 1));
    }
    if (op === "LTRIM") { const l = lists.get(key) || []; const a = Number(rest[0]); lists.set(key, a < 0 ? l.slice(a) : l.slice(a)); return "OK"; }
    return null;
  }
  return {
    upstashCmd,
    upstashGetJSON: async (k) => { const v = store.get(k); return v === undefined ? null : JSON.parse(v); },
    upstashSetJSON: async (k, v) => { store.set(k, JSON.stringify(v)); return true; },
    _store: store, _lists: lists,
  };
}

// =====================================================================
// ⑫ 自律学習判断
// =====================================================================

test("⑫ 監督交代を「最重要」と判断し、その理由を日本語で残す", () => {
  const r = assessImportance({ category: "coachChange", coachChanged: true });
  assert.strictEqual(r.level, "critical");
  assert.ok(r.reasonJa.includes("監督が交代"), r.reasonJa);
  assert.ok(r.reasonJa.includes("判断しました"), "なぜ学ぶべきと判断したかを述べていない: " + r.reasonJa);
});

test("⑫ 大型移籍(複数件)を最重要、1件を重要と区別する", () => {
  assert.strictEqual(assessImportance({ category: "transferImpact", transferCount: 3 }).level, "critical");
  assert.strictEqual(assessImportance({ category: "transferImpact", transferCount: 1 }).level, "high");
});

test("⑫ 怪我人が急に増えた場合を重く見る(人数そのものより増加を見る)", () => {
  const spike = assessImportance({ category: "injuries", injuryCount: 5, previousInjuryCount: 1 });
  assert.strictEqual(spike.level, "critical", spike.reasonJa);
  assert.ok(spike.reasonJa.includes("4人増え"), spike.reasonJa);
  const stable = assessImportance({ category: "injuries", injuryCount: 2, previousInjuryCount: 2 });
  assert.notStrictEqual(stable.level, "critical");
});

test("⑫ 急激なフォーム変化は段階的に評価する", () => {
  assert.strictEqual(assessImportance({ category: "recentFormTrend", formDelta: 2.0 }).level, "critical");
  assert.strictEqual(assessImportance({ category: "recentFormTrend", formDelta: 1.0 }).level, "high");
  assert.strictEqual(assessImportance({ category: "recentFormTrend", formDelta: 0.4 }).level, "medium");
  // 変化が小さいものを「重要」と言わない(でっち上げない)
  const tiny = assessImportance({ category: "leagueStandings", formDelta: 0.05 });
  assert.ok(["low", "routine"].includes(tiny.level), tiny.level);
});

test("⑫ 連勝・連敗を検出する", () => {
  const long = assessImportance({ category: "recentFormTrend", streak: { result: "負け", count: 6 } });
  assert.strictEqual(long.level, "high");
  assert.ok(long.reasonJa.includes("6連敗"), long.reasonJa);
  const short = assessImportance({ category: "leagueStandings", streak: { result: "勝ち", count: 2 } });
  assert.ok(["low", "routine"].includes(short.level), "2連勝で騒がない: " + short.level);
});

test("⑫ 自信を持っていた予測ほど、外したときの学びを重く見る", () => {
  const big = assessImportance({ category: "matchReflection", predictionMissMargin: 0.72 });
  assert.strictEqual(big.level, "critical");
  assert.ok(big.reasonJa.includes("72%"), big.reasonJa);
  const small = assessImportance({ category: "matchReflection", predictionMissMargin: 0.35 });
  assert.notStrictEqual(small.level, "critical");
});

test("⑫ 何も当てはまらなければ「定期記録」と正直に言う(無理に格付けしない)", () => {
  const r = assessImportance({});
  assert.strictEqual(r.level, "routine");
  assert.ok(r.reasonJa.includes("当てはまりませんでした"), r.reasonJa);
});

test("⑫ その日の学びを重要度別に集計し、最重要のものを示せる", () => {
  const items = [
    { statement: "監督交代", teamJa: "A", importance: assessImportance({ category: "coachChange", coachChanged: true }) },
    { statement: "移籍1件", teamJa: "A", importance: assessImportance({ category: "transferImpact", transferCount: 1 }) },
    { statement: "順位更新", teamJa: "B", importance: assessImportance({ category: "leagueStandings" }) },
  ];
  const sum = summarizeImportance(items);
  assert.strictEqual(sum.counts.critical, 1);
  assert.strictEqual(sum.counts.high, 1);
  assert.strictEqual(sum.notableCount, 2);
  assert.strictEqual(sum.highlights[0].statement, "監督交代", "最重要が先頭に来るべき");
  assert.ok(sum.summaryJa.includes("最重要"), sum.summaryJa);
  assert.ok(sum.summaryJa.includes("重要度を判定した"), "件数の対象範囲を明示すべき: " + sum.summaryJa);
});

test("⑫ 特筆すべきことが無い日は、正直に「日常的な更新の範囲」と言う", () => {
  const items = [{ statement: "順位更新", importance: assessImportance({ category: "leagueStandings" }) }];
  const sum = summarizeImportance(items);
  assert.strictEqual(sum.notableCount, 0);
  assert.ok(sum.summaryJa.includes("日常的な更新"), sum.summaryJa);
});

test("⑫ 1件も学べなかった日を「特筆すべきことが無かった」と言い換えない", () => {
  // 取得が全部失敗した日にも「本日学んだ0件は、いずれも日常的な更新の範囲でした」と
  // 表示していた。失敗を平常運転のように見せるのは最も避けたい種類の嘘。
  const sum = summarizeImportance([]);
  assert.ok(!sum.summaryJa.includes("日常的な更新の範囲"), sum.summaryJa);
  assert.ok(sum.summaryJa.includes("データ取得に失敗している可能性"), sum.summaryJa);
});

// =====================================================================
// ⑲ Knowledge Graph
// =====================================================================

test("⑲ クラブ→監督→布陣 の連鎖を辿り、日本語で説明できる", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  await g.addEdge({ fromType: "team", fromId: "Real Madrid", fromLabelJa: "レアル・マドリード", relation: "manager", toType: "coach", toId: "C. Ancelotti", toLabelJa: "アンチェロッティ" });
  await g.addEdge({ fromType: "coach", fromId: "C. Ancelotti", relation: "preferredFormation", toType: "formation", toId: "4-3-3" });

  const exp = await g.explainConnection("team", "Real Madrid", "formation", "4-3-3");
  assert.strictEqual(exp.found, true, exp.explanationJa);
  assert.ok(exp.explanationJa.includes("レアル・マドリード"), exp.explanationJa);
  assert.ok(exp.explanationJa.includes("アンチェロッティ"), exp.explanationJa);
  assert.ok(exp.explanationJa.includes("4-3-3"), exp.explanationJa);
});

test("⑲ 逆方向の探索ができる(既存 relationshipIndex では不可能だったこと)", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  await g.addEdge({ fromType: "team", fromId: "Real Madrid", relation: "manager", toType: "coach", toId: "C. Ancelotti" });
  await g.addEdge({ fromType: "team", fromId: "Everton", relation: "manager", toType: "coach", toId: "C. Ancelotti" });
  // 「この監督が率いた(率いている)クラブは?」= 入ってくる辺
  const ins = await g.getInEdges("coach", "C. Ancelotti");
  const clubs = ins.map((e) => e.from.id).sort();
  assert.deepStrictEqual(clubs, ["Everton", "Real Madrid"], JSON.stringify(clubs));
});

test("⑲ 1対多を表現できる(クラブに複数の選手)", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  for (const p of ["K. Mbappe", "J. Bellingham", "Vinicius Jr"]) {
    await g.addEdge({ fromType: "team", fromId: "Real Madrid", relation: "hasPlayer", toType: "player", toId: p });
  }
  const outs = await g.getOutEdges("team", "Real Madrid");
  assert.strictEqual(outs.filter((e) => e.relation === "hasPlayer").length, 3);
});

test("⑲ 同じ辺を何度張っても重複しない(毎日実行しても増え続けない)", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  for (let i = 0; i < 5; i++) {
    await g.addEdge({ fromType: "team", fromId: "Napoli", relation: "manager", toType: "coach", toId: "A. Conte" });
  }
  const outs = await g.getOutEdges("team", "Napoli");
  assert.strictEqual(outs.length, 1, "同じ関係が複数回登録されている: " + outs.length);
});

test("⑲ ご指示の連鎖(クラブ→監督→戦術→選手→怪我→布陣→試合→学習結果)を1回でまとめて集められる", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  const E = [
    ["team", "Real Madrid", "manager", "coach", "C. Ancelotti"],
    ["coach", "C. Ancelotti", "preferredFormation", "formation", "4-3-3"],
    ["team", "Real Madrid", "tacticalStyle", "tactic", "ポゼッション"],
    ["team", "Real Madrid", "hasPlayer", "player", "K. Mbappe"],
    ["player", "K. Mbappe", "injured", "injury", "Knee Injury"],
    ["team", "Real Madrid", "playedMatch", "match", "RM vs BAR#1"],
    ["match", "RM vs BAR#1", "learnedFrom", "lesson", "怪我人を軽視しない"],
  ];
  for (const [ft, fi, r, tt, ti] of E) await g.addEdge({ fromType: ft, fromId: fi, relation: r, toType: tt, toId: ti });

  const nb = await g.getNeighborhood("team", "Real Madrid", { maxDepth: 3 });
  const types = new Set(nb.nodes.map((n) => n.type));
  for (const t of ["team", "coach", "formation", "tactic", "player", "injury", "match", "lesson"]) {
    assert.ok(types.has(t), `${t} が探索結果に含まれていない: ${Array.from(types).join(",")}`);
  }
  // 推論の材料として使える日本語の箇条書きになること
  const sum = await g.summarizeNeighborhoodJa("team", "Real Madrid", { maxDepth: 3 });
  assert.ok(sum.linesJa.length >= 5, JSON.stringify(sum.linesJa));
  assert.ok(sum.linesJa.some((l) => l.includes("の監督は")), JSON.stringify(sum.linesJa));
});

test("⑲ つながりが無いものを、無理につなげない(でっち上げ防止)", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  await g.addEdge({ fromType: "team", fromId: "Napoli", relation: "manager", toType: "coach", toId: "A. Conte" });
  const exp = await g.explainConnection("team", "Napoli", "player", "K. Mbappe");
  assert.strictEqual(exp.found, false);
  assert.ok(exp.explanationJa.includes("推測でつなぐことはしません"), exp.explanationJa);
});

test("⑲ 探索を打ち切った場合は、その旨を正直に伝える(黙って切らない)", async () => {
  const mock = createMockRedis();
  const g = createKnowledgeGraph({ upstashEnabled: true, ...mock });
  for (let i = 0; i < 30; i++) {
    await g.addEdge({ fromType: "team", fromId: "Big Club", relation: "hasPlayer", toType: "player", toId: "P" + i });
  }
  const nb = await g.getNeighborhood("team", "Big Club", { maxDepth: 2, maxVisited: 10 });
  assert.strictEqual(nb.truncated, true);
  assert.ok(nb.reasonJa && nb.reasonJa.includes("打ち切りました"), nb.reasonJa);
});

// =====================================================================
// ⑳ 考えの変化の時系列
// =====================================================================

test("⑳ 見立て→きっかけ→新しい見立て→予測→結果→学び を1本の線として保存できる", async () => {
  const mock = createMockRedis();
  const tl = createThoughtTimeline({ upstashEnabled: true, ...mock });
  const key = "team:Real Madrid:beliefs";
  await tl.append(key, { kind: "belief", statementJa: "レアルが優勢だと考えます。", at: "2026-08-01T00:00:00Z" });
  await tl.append(key, { kind: "trigger", statementJa: "主力3人が離脱しました", evidence: ["負傷・出場停止: A, B, C"], at: "2026-08-02T00:00:00Z" });
  await tl.append(key, { kind: "belief", statementJa: "互角に近い展開になると考えます。", at: "2026-08-03T00:00:00Z" });
  await tl.recordOutcome(key, {
    predictionJa: "引き分けと予測しました。", resultJa: "実際は引き分けでした。",
    correct: true, lessonJa: "主力の離脱を早めに織り込む判断は有効でした。", at: "2026-08-04T00:00:00Z",
  });

  const disp = await tl.getTimelineForDisplay(key);
  assert.strictEqual(disp.available, true);
  const kinds = disp.steps.map((s) => s.kind);
  assert.deepStrictEqual(kinds, ["belief", "trigger", "belief", "prediction", "result", "lesson"], JSON.stringify(kinds));
});

test("⑳ 「以前と比べて考え方が変わった理由」を、記録どおりに説明できる", async () => {
  const mock = createMockRedis();
  const tl = createThoughtTimeline({ upstashEnabled: true, ...mock });
  const key = "team:Real Madrid:beliefs";
  await tl.append(key, { kind: "belief", statementJa: "レアルが優勢だと考えます。", at: "2026-08-01T00:00:00Z" });
  await tl.append(key, { kind: "trigger", statementJa: "怪我人が2人から5人に増えました", evidence: ["負傷・出場停止: A, B, C"], at: "2026-08-02T00:00:00Z" });
  await tl.append(key, { kind: "belief", statementJa: "互角に近い展開になると考えます。", at: "2026-08-03T00:00:00Z" });

  const ex = await tl.explainChange(key);
  assert.strictEqual(ex.available, true);
  assert.ok(ex.narrativeJa.includes("以前"), ex.narrativeJa);
  assert.ok(ex.narrativeJa.includes("レアルが優勢だと考えます。"), ex.narrativeJa);
  assert.ok(ex.narrativeJa.includes("怪我人が2人から5人に増えました"), ex.narrativeJa);
  assert.ok(ex.narrativeJa.includes("互角に近い展開になると考えます。"), ex.narrativeJa);
  // 根拠にした実データも示せる
  assert.ok(ex.narrativeJa.includes("負傷・出場停止: A, B, C"), ex.narrativeJa);
});

test("⑳ きっかけが記録されていないのに、それらしい理由をでっち上げない", async () => {
  const mock = createMockRedis();
  const tl = createThoughtTimeline({ upstashEnabled: true, ...mock });
  const key = "team:X:beliefs";
  await tl.append(key, { kind: "belief", statementJa: "Aだと考えます。", at: "2026-08-01T00:00:00Z" });
  await tl.append(key, { kind: "belief", statementJa: "Bだと考えます。", at: "2026-08-02T00:00:00Z" });
  const ex = await tl.explainChange(key);
  assert.strictEqual(ex.available, true);
  assert.ok(ex.narrativeJa.includes("きっかけとなる実データは記録されていません"), ex.narrativeJa);
});

test("⑳ 比べる前回が無いときは、正直に「まだ比べられない」と言う", async () => {
  const mock = createMockRedis();
  const tl = createThoughtTimeline({ upstashEnabled: true, ...mock });
  const key = "team:Y:beliefs";
  const empty = await tl.explainChange(key);
  assert.strictEqual(empty.available, false);
  await tl.append(key, { kind: "belief", statementJa: "Aだと考えます。" });
  const one = await tl.explainChange(key);
  assert.strictEqual(one.available, false);
  assert.ok(one.reasonJa.includes("1度しか"), one.reasonJa);
});

test("⑳ 同じ内容を繰り返し書いても、履歴が伸び続けない(成長の水増し防止)", async () => {
  const mock = createMockRedis();
  const tl = createThoughtTimeline({ upstashEnabled: true, ...mock });
  const key = "team:Z:beliefs";
  for (let i = 0; i < 10; i++) {
    await tl.append(key, { kind: "belief", statementJa: "同じ見立てです。" });
  }
  const events = await tl.read(key);
  assert.strictEqual(events.length, 1, "同じ内容が" + events.length + "件積まれている");
});

test("⑳ 答え合わせの結果に応じて、学びの意味づけを変える", async () => {
  const mock = createMockRedis();
  const tl = createThoughtTimeline({ upstashEnabled: true, ...mock });
  await tl.recordOutcome("k1", { predictionJa: "P", resultJa: "R", correct: true, lessonJa: "L" });
  const hit = (await tl.read("k1")).find((e) => e.kind === "lesson");
  assert.ok(hit.causeJa.includes("今後も使います"), hit.causeJa);

  await tl.recordOutcome("k2", { predictionJa: "P", resultJa: "R", correct: false, lessonJa: "L" });
  const miss = (await tl.read("k2")).find((e) => e.kind === "lesson");
  assert.ok(miss.causeJa.includes("見直します"), miss.causeJa);
});

// =====================================================================
(async () => {
  for (const t of queue) {
    try {
      await t.fn();
      console.log(`  [OK] ${t.name}`);
    } catch (e) {
      failures++;
      console.log(`  [FAIL] ${t.name}: ${e.message}`);
    }
  }
  console.log(failures === 0
    ? `\nAll autonomy / knowledge-graph / timeline tests PASSED (${queue.length} tests).`
    : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
