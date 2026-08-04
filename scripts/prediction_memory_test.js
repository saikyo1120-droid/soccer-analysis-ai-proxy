/**
 * 2026年8月・優先順位⑤「Memory Engineを試合予測にも使ってください」のテスト。
 *
 * ご指示の設計方針をそのまま検証項目にしている:
 *   ・「すべて保存」ではなく、予測や評価が変わった時だけ記録する
 *   ・前回との違い・変わった理由・何を学んだかを保存する
 *   ・同じ内容は重複保存しない
 *   ・回答では必要な時だけ過去との比較を表示する
 *   ・レスポンス速度を落とさない(LLMを呼ばない・書き込みを最小化する)
 */
const assert = require("assert");
const {
  describeEvaluationChange, recordPredictionEvaluation, buildComparisonForResponse,
  matchupKey, buildEvaluationStatement, CHANGE_THRESHOLD_PCT,
} = require("../server/memory/predictionMemory");
const { createMemoryStore } = require("../server/memory/memoryStore");

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

function createMockRedis() {
  const store = new Map();
  let writes = 0;
  let reads = 0;
  async function upstashCmd(cmd) {
    const [op, ...args] = cmd;
    if (op === "GET") { reads++; return store.has(args[0]) ? store.get(args[0]) : null; }
    if (op === "SET") { writes++; store.set(args[0], args[1]); return "OK"; }
    if (op === "INCR") { const c = parseInt(store.get(args[0]), 10) || 0; store.set(args[0], String(c + 1)); return c + 1; }
    if (op === "RPUSH") { const [k, v] = args; const l = store.get(k) || []; l.push(v); store.set(k, l); return l.length; }
    if (op === "LRANGE") { const [k, s, e] = args; const l = store.get(k) || []; let st = parseInt(s, 10), en = parseInt(e, 10); if (st < 0) st = Math.max(0, l.length + st); if (en < 0) en = l.length + en; return l.slice(st, en + 1); }
    if (op === "LTRIM") return "OK";
    return null;
  }
  return {
    store,
    counters: { get writes() { return writes; }, get reads() { return reads; } },
    upstashCmd,
    upstashGetJSON: async (k) => { reads++; const r = store.has(k) ? store.get(k) : null; return r === null ? null : JSON.parse(r); },
    upstashSetJSON: async (k, v) => { writes++; store.set(k, JSON.stringify(v)); return true; },
  };
}

const F = (over) => ({ formDiff: 1, goalRateDiff: 0.5, injuryDiff: 0, standingsDiff: 0, headToHeadDiff: 0, fatigueDiff: 0, venueDiff: 0, suspensionDiff: 0, xgDiff: 0, topScorerDiff: 0, ...over });
const EV = (over) => ({ predictedWinner: "home", homeWinPct: 60, features: F(), computedAt: "2026-08-10T00:00:00Z", ...over });

(async () => {
  await test("matchupKey: 同じ対戦は常に同じキーに集約される", () => {
    assert.strictEqual(matchupKey("Man City", "Arsenal"), "matchup:Man City-vs-Arsenal:prediction");
    assert.strictEqual(matchupKey(null, "Arsenal"), null);
  });

  await test("buildEvaluationStatement: 勝者予想と勝率を含む要約になる", () => {
    assert.ok(buildEvaluationStatement(EV()).includes("ホーム有利"));
    assert.ok(buildEvaluationStatement(EV()).includes("60%"));
  });

  // ---- 「変わった時だけ」の判定 ----
  await test("初回評価は「変化」ではないと判定される(比較対象が無いため)", () => {
    const c = describeEvaluationChange(null, EV());
    assert.strictEqual(c.isMeaningful, false);
    assert.ok(c.headlineJa.includes("初めて"), c.headlineJa);
  });

  await test("★同じ評価なら「変化なし」と判定し、保存しない材料にする", () => {
    const c = describeEvaluationChange(EV(), EV());
    assert.strictEqual(c.isMeaningful, false);
    assert.deepStrictEqual(c.reasonsJa, []);
  });

  await test("★勝率のわずかな揺れ(閾値未満)は「変化」として扱わない", () => {
    const c = describeEvaluationChange(EV({ homeWinPct: 60 }), EV({ homeWinPct: 60 + (CHANGE_THRESHOLD_PCT - 1) }));
    assert.strictEqual(c.isMeaningful, false, "小さな揺れで毎回保存すると『変わった時だけ』の意図が失われる");
  });

  await test("勝率が閾値以上動けば「変化あり」と判定する", () => {
    const c = describeEvaluationChange(EV({ homeWinPct: 60 }), EV({ homeWinPct: 60 + CHANGE_THRESHOLD_PCT }));
    assert.strictEqual(c.isMeaningful, true);
    assert.ok(c.headlineJa.includes("60%") && c.headlineJa.includes("65%"), c.headlineJa);
  });

  await test("勝者予想が変われば、勝率の動きが小さくても「変化あり」と判定する", () => {
    const c = describeEvaluationChange(EV({ predictedWinner: "home", homeWinPct: 50 }), EV({ predictedWinner: "away", homeWinPct: 49 }));
    assert.strictEqual(c.isMeaningful, true);
    assert.ok(c.headlineJa.includes("ホーム有利") && c.headlineJa.includes("アウェイ有利"), c.headlineJa);
  });

  // ---- 「変わった理由」「何を学んだか」 ----
  await test("★変わった理由が、特徴量の差分から具体的に示される(LLM不使用)", () => {
    const prev = EV({ features: F({ injuryDiff: 0 }) });
    const cur = EV({ predictedWinner: "away", features: F({ injuryDiff: -4 }) });
    const c = describeEvaluationChange(prev, cur);
    assert.ok(c.reasonsJa.length > 0);
    const joined = c.reasonsJa.join(" ");
    assert.ok(joined.includes("怪我人"), "最も動いた要因が示されるはず: " + joined);
    assert.ok(joined.includes("アウェイ側に有利"), "どちら向きに動いたかも示すはず: " + joined);
  });

  await test("変わった理由は、動きの大きい順に最大3件までに絞る", () => {
    const prev = EV({ features: F({ formDiff: 0, goalRateDiff: 0, injuryDiff: 0, xgDiff: 0, venueDiff: 0 }) });
    const cur = EV({ predictedWinner: "away", features: F({ formDiff: 3, goalRateDiff: 2, injuryDiff: 5, xgDiff: 1, venueDiff: 4 }) });
    const c = describeEvaluationChange(prev, cur);
    assert.ok(c.reasonsJa.length <= 3, "3件以内のはず, got " + c.reasonsJa.length);
    assert.ok(c.reasonsJa[0].includes("怪我人"), "最も大きく動いた要因が先頭のはず: " + c.reasonsJa[0]);
  });

  await test("データが同じで、重みのバージョンが実際に上がっていれば「学習したから」と説明する", () => {
    // 2026年8月・第6次監査での修正に追随。
    //   以前は、重みが本当に更新されたかを一切確認せずに
    //   「AIが他の試合から学習して重みを更新したため」と断言していた。
    //   実際にバージョンが上がっている場合にだけそう述べる。
    const c = describeEvaluationChange(
      EV({ predictedWinner: "home", weightsVersion: 3 }),
      EV({ predictedWinner: "away", weightsVersion: 4 })
    );
    assert.ok(c.reasonsJa.join(" ").includes("学習して重み"), c.reasonsJa.join(" "));
    assert.ok(c.reasonsJa.join(" ").includes("3→4"), "実際のバージョンの変化を示すはず: " + c.reasonsJa.join(" "));
  });

  await test("重みが更新されていないのに「学習したから」と断定しない(でっち上げ防止)", () => {
    const c = describeEvaluationChange(
      EV({ predictedWinner: "home", weightsVersion: 3 }),
      EV({ predictedWinner: "away", weightsVersion: 3 })
    );
    assert.ok(!c.reasonsJa.join(" ").includes("学習して重み"),
      "確認していないことを原因として述べてはいけない: " + c.reasonsJa.join(" "));
  });

  await test("前回は取れていたデータが今回取れなかった場合、それをサッカー的な理由として説明しない", () => {
    // 【この欠陥が実際にしていたこと】
    //   xGが取れなくなっただけで特徴量が0になり、
    //   「xG(期待得点)がアウェイ側に有利な方向へ0.80動きました」という、
    //   データ障害をサッカーの理由として述べる文が出ていた。
    const prev = EV({ predictedWinner: "home" });
    prev.features = { ...prev.features, xgDiff: 0.8 };
    prev.supplied = { xgDiff: true };
    const cur = EV({ predictedWinner: "away" });
    cur.features = { ...cur.features, xgDiff: 0 };
    cur.supplied = { xgDiff: false };
    const c = describeEvaluationChange(prev, cur);
    const joined = c.reasonsJa.join(" ");
    assert.ok(!/xG.*動きました/.test(joined), "データ障害を理由として述べてはいけない: " + joined);
    assert.ok(joined.includes("取得できませんでした"), "取得できなかったことを正直に伝えるはず: " + joined);
  });

  await test("「何を学んだか」が保存される", () => {
    const c = describeEvaluationChange(EV({ predictedWinner: "home" }), EV({ predictedWinner: "away", homeWinPct: 40 }));
    assert.ok(c.learnedJa && c.learnedJa.length > 10, c.learnedJa);
    assert.ok(c.learnedJa.includes("次回"), "次回の比較材料になることを示すはず");
  });

  // ---- 保存動作(重複保存しない) ----
  const makeStore = () => {
    const mock = createMockRedis();
    return { mock, memoryStore: createMemoryStore({ upstashEnabled: true, ...mock }) };
  };

  await test("★初回は記録される(比較の起点として必要)", async () => {
    const { memoryStore } = makeStore();
    const r = await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    assert.strictEqual(r.recorded, true);
    assert.strictEqual(r.reason, "INITIAL");
  });

  await test("★同じ評価を繰り返しても、2回目以降は保存されない(重複保存しない)", async () => {
    const { mock, memoryStore } = makeStore();
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    const writesAfterFirst = mock.counters.writes;
    const r2 = await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    const r3 = await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    assert.strictEqual(r2.recorded, false);
    assert.strictEqual(r2.reason, "NO_MEANINGFUL_CHANGE");
    assert.strictEqual(r3.recorded, false);
    assert.strictEqual(mock.counters.writes, writesAfterFirst,
      "変化が無いのにUpstashへ書き込んではいけない(レスポンス速度とコストのため)");
  });

  await test("★評価が変わった時だけ、新しい記録として保存される", async () => {
    const { memoryStore } = makeStore();
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    const changed = await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal",
      EV({ predictedWinner: "away", homeWinPct: 35, features: F({ injuryDiff: -5 }) }));
    assert.strictEqual(changed.recorded, true);
    assert.ok(changed.change.isMeaningful);
    assert.ok(changed.change.headlineJa.includes("評価を変更"), changed.change.headlineJa);
  });

  await test("履歴に「前回はこう考えていた」が残る(考えの変化を後から追える)", async () => {
    const { memoryStore } = makeStore();
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV({ predictedWinner: "away", homeWinPct: 35 }));
    const history = await memoryStore.getConclusionHistory(matchupKey("Man City", "Arsenal"), 10);
    assert.ok(history.length >= 1, "前回の結論が履歴に退避されるはず");
    assert.ok(history[0].statement.includes("ホーム有利"), JSON.stringify(history[0]));
  });

  await test("Memory Engineが落ちていても、例外を投げない(予測そのものは必ず返す)", async () => {
    const brokenStore = { getLastConclusion: async () => { throw new Error("down"); }, saveConclusion: async () => { throw new Error("down"); } };
    const r = await recordPredictionEvaluation({ memoryStore: brokenStore }, "A", "B", EV());
    assert.strictEqual(r.recorded, false);
    assert.ok(r.reason.startsWith("ERROR:"), r.reason);
  });

  await test("memoryStoreが渡されていない場合も安全に何もしない", async () => {
    const r = await recordPredictionEvaluation({}, "A", "B", EV());
    assert.strictEqual(r.recorded, false);
  });

  // ---- 回答への表示(必要な時だけ) ----
  await test("★初回の予測では、過去との比較を表示しない(比較するものが無い)", async () => {
    const { memoryStore } = makeStore();
    const c = await buildComparisonForResponse({ memoryStore }, "Man City", "Arsenal", EV());
    assert.strictEqual(c, null);
  });

  await test("★評価が変わっていなければ、過去との比較を表示しない(ノイズを増やさない)", async () => {
    const { memoryStore } = makeStore();
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    const c = await buildComparisonForResponse({ memoryStore }, "Man City", "Arsenal", EV());
    assert.strictEqual(c, null, "変化が無い時に毎回『前回と同じです』と出すのは不要");
  });

  await test("★評価が変わった時だけ、過去との比較を表示する", async () => {
    const { memoryStore } = makeStore();
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    const c = await buildComparisonForResponse({ memoryStore }, "Man City", "Arsenal",
      EV({ predictedWinner: "away", homeWinPct: 35, features: F({ injuryDiff: -5 }) }));
    assert.ok(c, "変化があれば比較が返るはず");
    assert.ok(c.headlineJa.includes("前回は"), c.headlineJa);
    assert.ok(Array.isArray(c.reasonsJa) && c.reasonsJa.length > 0, "変わった理由も添えるはず");
    assert.ok(c.learnedJa, "何を学んだかも添えるはず");
  });

  await test("★レスポンス速度: 比較の生成でUpstashへの書き込みが1回も発生しない(読み出しのみ)", async () => {
    const { mock, memoryStore } = makeStore();
    await recordPredictionEvaluation({ memoryStore }, "Man City", "Arsenal", EV());
    const writesBefore = mock.counters.writes;
    await buildComparisonForResponse({ memoryStore }, "Man City", "Arsenal", EV({ predictedWinner: "away", homeWinPct: 35 }));
    assert.strictEqual(mock.counters.writes, writesBefore, "表示用の比較で書き込みを発生させてはいけない");
  });

  await test("Memory Engineが落ちていても、比較はnullを返すだけで回答は止めない", async () => {
    const brokenStore = { getLastConclusion: async () => { throw new Error("down"); } };
    const c = await buildComparisonForResponse({ memoryStore: brokenStore }, "A", "B", EV());
    assert.strictEqual(c, null);
  });

  console.log(failures === 0 ? "\nAll prediction-memory (優先順位⑤) tests PASSED." : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
