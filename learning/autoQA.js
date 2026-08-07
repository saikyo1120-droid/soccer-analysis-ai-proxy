/**
 * server/learning/autoQA.js
 * ==========================================================================
 * 毎日の学習が終わった直後に、**サーバー自身が** 走らせる自動検証。
 *
 * ■ ご指示(2026年8月7日)
 *   「単に『学習が完走しました』ではなく、**本当に昨日よりAIが賢くなったか**
 *     まで自動で検証してください。異常があれば自分で修正 → 再実行 →
 *     正常になるまで繰り返してください。異常を見つけるだけではなく、
 *     正常になるところまで責任を持ってください。」
 *
 * ■ この仕組みの原則
 *   1. 「賢くなった」を **LLMの文章の変化では判定しない**。
 *      LLMは同じ入力でも毎回違う文章を返すので、文章の差分は成長の証拠に
 *      ならない(むしろ「毎日賢くなっている」ように見せる水増しになる)。
 *      判定するのは **AIが事実として言えるようになったことが増えたか** だけ。
 *   2. 出す数字はすべて実測値。取れなかったものは理由つきで「取れなかった」と書く。
 *   3. 異常を見つけたら、直せるものはその場で直し、**直したあとにもう一度測る**。
 *      直っていなければ、直っていないと書く。
 *
 * ■ 何を確認するか(ご指示の①〜⑨に対応)
 *   ① 学習が14段階すべてを通って完走したか(learn:progress と正解表の突き合わせ)
 *   ② 定点質問8問の答えが、昨日と比べてどう変わったか
 *   ③ 予測(的中率・自信度・説明可能性・較正・答え合わせ)が更新されているか
 *   ④ 成長指標(知識・記憶・予測・選手・クラブ)が実際に増えているか
 *   ⑤ 学習ダッシュボードに出す差分(このモジュールの出力がそのまま材料になる)
 *   ⑥ 取得した選手が、検索・選手詳細・クラブ詳細に反映されているか
 *   ⑦ 取得したクラブ情報(順位・フォーム・移籍・怪我)が反映されているか
 *   ⑧ 異常の検知(API取得失敗・学習停止・予測停止・記憶停止・保存失敗・索引失敗)
 *   ⑨ 自己修復(直す → もう一度測る → 正常になるまで繰り返す)
 *
 * ■ 保存先
 *   qa:report:<日付>  … その日の完全な報告
 *   qa:report:latest  … 最新(画面とエンドポイントが読む)
 *   qa:answers:<日付> … 定点質問の答え(翌日の比較材料)
 */

/** 定点質問(ご指示で挙げられた8つ)。毎日まったく同じ質問を投げる。 */
const FIXED_QUESTIONS = [
  { id: "player_kubo", kind: "player", questionJa: "久保建英はどんな選手ですか？", targetJa: "久保建英", match: ["kubo", "久保"] },
  { id: "club_arsenal", kind: "club", questionJa: "アーセナルの今の状態は？", nameEn: "Arsenal", nameJa: "アーセナル" },
  { id: "club_mancity", kind: "club", questionJa: "マンチェスター・シティの今の状態は？", nameEn: "Manchester City", nameJa: "マンチェスター・シティ" },
  { id: "today_fixtures", kind: "fixtures", questionJa: "今日の試合は？" },
  { id: "featured_players", kind: "picks", questionJa: "注目選手は？" },
  { id: "young_prospects", kind: "young", questionJa: "若手有望株は？" },
  { id: "injuries", kind: "injuries", questionJa: "怪我情報は？" },
  { id: "transfers", kind: "transfers", questionJa: "移籍情報は？" },
];

const CLUBS_FOR_AGGREGATE = 40; // 怪我・移籍を集計するときに見るクラブ数の上限
const YOUNG_AGE_MAX = 21;

/** 修復処理の、利用者に見せる名前(内部の英語名を画面に出さないため) */
const REPAIR_LABEL_JA = {
  rebuildPlayerIndex: "選手索引の作り直し",
  collectPlayers: "選手・クラブ情報の追加収集",
  resolvePredictions: "試合結果との答え合わせ",
  runDailyLearning: "毎日の学習の再実行",
};
const repairLabel = (k) => REPAIR_LABEL_JA[k] || k;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : null; }

/**
 * 自動QAを作る。
 * すべての依存は呼び出し側から渡す(このファイル単体でテストできるようにするため)。
 */
function createAutoQA(deps) {
  const {
    upstashEnabled, upstashCmd, upstashGetJSON, upstashSetJSON,
    appDateKey, memoryStore, clubDossier, playerSearch, loadPlayerIndex,
    learningStages, registeredTeams,
    // 自己修復のために呼ぶ処理(いずれも任意。渡されなければその修復は「できません」と記録する)
    repair,
    now,
  } = deps;

  const nowMs = () => (typeof now === "function" ? now() : Date.now());
  const dateKeyOf = (d) => (typeof appDateKey === "function" ? appDateKey(d) : new Date(d || nowMs()).toISOString().slice(0, 10));

  // ---- 1回の実行の中で、同じクラブの調査ファイルを何度も読まない ----
  //   監査で判明: 同じ40クラブを1回の測定で3回読んでいた(怪我・移籍・反映確認)。
  //   Upstashの無料枠は1日10,000コマンドなので、無駄な読み出しは
  //   そのまま「他の機能が使えなくなる」に直結する。
  let dossierMemo = new Map();
  const resetMemo = () => { dossierMemo = new Map(); };
  async function getDossierCached(nameEn) {
    if (!nameEn) return null;
    if (dossierMemo.has(nameEn)) return dossierMemo.get(nameEn);
    const d = clubDossier && typeof clubDossier.getDossier === "function"
      ? await clubDossier.getDossier(nameEn).catch(() => null) : null;
    dossierMemo.set(nameEn, d);
    return d;
  }

  // ---- 「読めなかった」と「空だった」を混同しない ----
  //   監査で判明: LRANGE の失敗を [] にしていたため、Redisが落ちている日に
  //   「0件でした」と実測したかのように報告していた。これはでっち上げに当たる。
  //   読めなかったときは null を返し、呼び出し側で「測れませんでした」と書く。
  async function lrangeOrNull(key, start, stop) {
    try {
      const raw = await upstashCmd(["LRANGE", key, String(start), String(stop)]);
      if (!Array.isArray(raw)) return null;
      return raw.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) { return null; }
  }
  // 利用者に見せる文に、JavaScriptの英語メッセージをそのまま出さない
  const errJa = (e) => `内部の処理でエラーが起きました(${String((e && e.message) || e).slice(0, 80)})`;

  /* ====================================================================
   * ① 学習が完走したか
   * ==================================================================== */
  async function checkLearningRun() {
    const expected = Array.isArray(learningStages) ? learningStages : [];
    const progress = await upstashGetJSON("learn:progress").catch(() => null);
    if (!progress) {
      return {
        ok: false, available: false, finished: false,
        expectedStageCount: expected.length, reachedStageCount: 0, missingStages: expected.slice(),
        reasonJa: "学習の進捗が1件も記録されていません(学習が一度も走っていないか、進捗を記録する前に落ちています)。",
      };
    }
    const reached = new Set((progress.stages || []).map((s) => s.name));
    const missing = expected.filter((name) => !reached.has(name));
    const finished = progress.finished === true;
    const isToday = progress.date === dateKeyOf();
    // 「どこで止まったか」は、正解表のうち到達していない最初の段階
    const stoppedAt = finished ? null : (missing[0] || progress.stage || null);
    const elapsed = num(progress.elapsedSec);
    return {
      ok: finished && missing.length === 0 && isToday,
      available: true,
      finished,
      isToday,
      date: progress.date || null,
      startedAt: progress.startedAt || null,
      lastStage: progress.stage || null,
      elapsedSec: elapsed,
      expectedStageCount: expected.length,
      reachedStageCount: expected.filter((name) => reached.has(name)).length,
      missingStages: missing,
      stoppedAtJa: stoppedAt,
      reasonJa: finished && missing.length === 0 && isToday
        ? `本日(${progress.date || dateKeyOf()})の学習は${expected.length}段階すべてを通って完走しました(所要 ${elapsed !== null ? Math.round(elapsed / 60) : "?"}分)。`
        : !isToday
          ? `最後に完了した学習は ${progress.date || "(日付の記録なし)"} 分です。本日(${dateKeyOf()})の学習はまだ完走していません。`
          : `学習は「${stoppedAt}」の段階で止まっています(${expected.length}段階中 ${expected.filter((n) => reached.has(n)).length}段階まで到達)。`,
    };
  }

  /* ====================================================================
   * ② 定点質問8問の答えを作る
   *    「答え」= AIがその質問に対して **事実として言えること** の一覧。
   *    LLMの文章ではないので、昨日との差分がそのまま「増えた知識」になる。
   * ==================================================================== */
  async function loadIndexRows() {
    if (typeof loadPlayerIndex !== "function") return { rows: [], available: false };
    const idx = await loadPlayerIndex(false).catch(() => null);
    return { rows: (idx && idx.rows) || [], available: !!(idx && idx.available !== false) };
  }

  function playerFactsFromRow(row, C) {
    const f = [];
    const put = (k, v) => { if (v !== null && v !== undefined && v !== "") f.push({ k, v: String(v) }); };
    put("所属クラブ", row[C.teamJa] || row[C.teamEn]);
    put("国籍", row[C.nationality]);
    put("年齢", row[C.age]);
    put("ポジション", row[C.position]);
    put("平均評価", row[C.rating]);
    put("出場数", row[C.appearances]);
    put("ゴール", row[C.goals]);
    put("アシスト", row[C.assists]);
    if (C.recent5Rating !== undefined) put("直近5試合の平均評価", row[C.recent5Rating]);
    if (C.recent5Minutes !== undefined) put("直近5試合の出場時間", row[C.recent5Minutes]);
    return f;
  }

  async function clubFacts(nameEn) {
    const d = await getDossierCached(nameEn);
    const f = [];
    if (!d) return { facts: f, dossier: null };
    const S = d.sections || {};
    const put = (k, v) => { if (v !== null && v !== undefined && v !== "") f.push({ k, v: String(v) }); };
    if (S.standings) {
      put("リーグ順位", S.standings.position);
      put("勝点", S.standings.points);
      put("消化試合", S.standings.played);
    }
    if (S.form) {
      put("直近フォームスコア", S.form.currentFormScore);
      put("直近の1試合平均得点", S.form.avgGoalsFor);
      put("直近の1試合平均失点", S.form.avgGoalsAgainst);
      put("直近7日間の試合数", S.form.matchesLast7Days);
      put("ホーム勝率", S.form.homeWinRate);
      put("アウェイ勝率", S.form.awayWinRate);
    }
    if (S.injuries) {
      put("負傷・出場停止の人数", S.injuries.injuryCount);
      const names = [...(S.injuries.injuredPlayers || []), ...(S.injuries.suspendedPlayers || [])]
        .map((p) => (typeof p === "string" ? p : p && p.name)).filter(Boolean);
      if (names.length) put("負傷・出場停止の選手", names.slice(0, 8).join("、"));
    }
    if (S.transfers) {
      put("直近30日の移籍件数", S.transfers.countLast30Days);
      // 壊れた要素(null)が1つ混ざっているだけで、このクラブの回答が丸ごと
      // 例外になり、英語のエラー文が利用者に見えていた。要素ごとに守る。
      const recent = (Array.isArray(S.transfers.recent) ? S.transfers.recent : [])
        .filter((t) => t && t.playerName).slice(0, 5)
        .map((t) => `${t.playerName}(${t.direction === "in" ? "加入" : "移籍"}${t.counterpart ? `・${t.counterpart}` : ""})`);
      if (recent.length) put("直近の移籍", recent.join("、"));
    }
    if (S.coach && S.coach.name) put("監督", S.coach.name);
    if (S.squad) put("登録選手数", S.squad.count);
    if (S.xg) { put("xG(期待得点)", S.xg.xgFor); put("xGA(期待失点)", S.xg.xgAgainst); }
    return { facts: f, dossier: d };
  }

  async function aiWordsFor(nameEn) {
    if (!memoryStore || typeof memoryStore.getLastConclusion !== "function") return null;
    const c = await memoryStore.getLastConclusion(`team:${nameEn}:dailyView`).catch(() => null);
    return c && c.statement ? { statementJa: c.statement, computedAt: c.computedAt || null } : null;
  }

  async function buildAnswers() {
    const C = (playerSearch && playerSearch.COL) || {};
    const { rows, available: idxAvailable } = await loadIndexRows();
    const answers = [];
    const push = (q, o) => answers.push({ id: q.id, questionJa: q.questionJa, ...o });

    for (const q of FIXED_QUESTIONS) {
      try {
        if (q.kind === "player") {
          const hit = rows.find((r) => {
            const n = String(r[C.name] || "").toLowerCase();
            return q.match.some((m) => n.includes(String(m).toLowerCase()));
          });
          if (!hit) {
            push(q, { canAnswer: false, facts: [], aiWordsJa: null,
              reasonJa: idxAvailable
                ? `「${q.targetJa}」は選手索引にまだ入っていないため、答えられません。`
                : "選手索引がまだ作られていないため、答えられません。" });
          } else {
            // 画面には日本語名を出す(索引の表記は "T. Kubo" のような英語なので、
            // そのまま出すと「久保建英はどんな選手ですか？(T. Kubo)」になっていた)
            push(q, { canAnswer: true, subjectJa: q.targetJa || String(hit[C.name]),
              subjectEn: String(hit[C.name]), facts: playerFactsFromRow(hit, C), aiWordsJa: null, reasonJa: null });
          }
          continue;
        }

        if (q.kind === "club") {
          const { facts, dossier } = await clubFacts(q.nameEn);
          const ai = await aiWordsFor(q.nameEn);
          push(q, {
            canAnswer: facts.length > 0, subjectJa: q.nameJa, facts,
            aiWordsJa: ai ? ai.statementJa : null,
            aiWordsAt: ai ? ai.computedAt : null,
            reasonJa: facts.length ? null
              : (dossier ? `${q.nameJa}の調査ファイルはありますが、中身がまだ空です。` : `${q.nameJa}の調査ファイルがまだ作られていません。`),
          });
          continue;
        }

        if (q.kind === "fixtures") {
          // ---- 監査で判明した重大な誤り ----
          //   ここは pred:recent を読んでいたが、そのリストは
          //   **答え合わせが終わった試合しか入らない**(server.js の
          //   resolvePrediction が RPUSH する)。つまり「今日の試合」を
          //   聞いているのに、終わった試合しか見ていなかった。
          //   さらに pred:* は API-Football が提供する予測であって、
          //   このアプリのAIの予測ではない。「AIの予想」と書くのは誤り。
          //   自社モデルの、これからの試合の予測は learn:ownpred:pending にある。
          const todayKey = dateKeyOf();
          const pendingRaw = await upstashCmd(["LRANGE", "learn:ownpred:pending", "0", "29"]).catch(() => null);
          if (!Array.isArray(pendingRaw)) {
            push(q, { canAnswer: false, facts: [], aiWordsJa: null, volatile: true,
              reasonJa: "予測の待ち行列を読み出せませんでした(保存先に接続できていません)。0件だったのではなく、測れていません。" });
            continue;
          }
          const facts = [];
          let checked = 0;
          for (const idRaw of pendingRaw) {
            if (facts.length >= 10) break;
            const id = String(idRaw);
            const rec = await upstashGetJSON(`learn:ownpred:${id}`).catch(() => null);
            checked++;
            if (!rec || !rec.kickoff) continue;
            if (dateKeyOf(new Date(rec.kickoff)) !== todayKey) continue;
            const home = rec.homeTeamEn || rec.home || "?";
            const away = rec.awayTeamEn || rec.away || "?";
            facts.push({
              k: `${home} vs ${away}`,
              v: `このAI自身の予想: ${rec.predictedWinner === "home" ? `${home}勝利` : rec.predictedWinner === "away" ? `${away}勝利` : "引き分け"}`
                + (rec.predictedScoreline ? `(予想スコア ${rec.predictedScoreline})` : ""),
            });
          }
          push(q, {
            canAnswer: facts.length > 0, facts, aiWordsJa: null,
            // ---- 成長の判定からは外す ----
            //   試合の顔ぶれは毎日必ず入れ替わる。これを「新しく言えるように
            //   なったこと」に数えると、何も学んでいない日でも必ず
            //   「賢くなりました」になる(このファイルの冒頭で禁じた水増し)。
            volatile: true,
            checkedCount: checked,
            reasonJa: facts.length ? null
              : `待ち行列の${checked}件を確認しましたが、今日キックオフの試合についてのAI自身の予測はまだ記録されていません。`,
          });
          continue;
        }

        if (q.kind === "picks" || q.kind === "young") {
          const withRating = rows.filter((r) => num(r[C.rating]) !== null);
          let list;
          if (q.kind === "young") {
            list = withRating.filter((r) => { const a = num(r[C.age]); return a !== null && a <= YOUNG_AGE_MAX; });
          } else {
            list = withRating;
          }
          list = list.sort((a, b) => num(b[C.rating]) - num(a[C.rating])).slice(0, 8);
          // 同姓同名がいると、比較のときに Map で片方が消えてしまう。
          // 所属クラブを付けて必ず一意にする(消えた選手が見えなくなるのを防ぐ)。
          const seenKey = new Map();
          const facts = list.map((r) => {
            const base = String(r[C.name]);
            const n = (seenKey.get(base) || 0) + 1;
            seenKey.set(base, n);
            const club = r[C.teamJa] || r[C.teamEn] || "所属不明";
            return {
              k: n === 1 ? base : `${base}(${club})`,
              v: `平均評価 ${r[C.rating]}・${club}${num(r[C.age]) !== null ? `・${r[C.age]}歳` : ""}`,
            };
          });
          push(q, { canAnswer: facts.length > 0, facts, aiWordsJa: null,
            reasonJa: facts.length ? null
              : (q.kind === "young"
                ? `${YOUNG_AGE_MAX}歳以下で平均評価まで取得できている選手がまだ1人もいません。`
                : "平均評価まで取得できている選手がまだ1人もいません。") });
          continue;
        }

        if (q.kind === "injuries" || q.kind === "transfers") {
          const teams = (registeredTeams || []).slice(0, CLUBS_FOR_AGGREGATE);
          const facts = [];
          let clubsWithData = 0;
          const clubErrors = [];
          for (const t of teams) {
            try {
            const d = await getDossierCached(t.nameEn);
            const sec = d && d.sections ? d.sections[q.kind] : null;
            if (!sec) continue;
            clubsWithData++;
            if (q.kind === "injuries") {
              const names = [...(sec.injuredPlayers || []), ...(sec.suspendedPlayers || [])]
                .map((p) => (typeof p === "string" ? p : p && p.name)).filter(Boolean);
              if (num(sec.injuryCount) ? num(sec.injuryCount) > 0 : names.length > 0) {
                facts.push({ k: t.nameJa || t.nameEn, v: `${sec.injuryCount ?? names.length}人${names.length ? `(${names.slice(0, 4).join("、")})` : ""}` });
              }
            } else {
              // 監査で判明: recent の要素が null のクラブが1つあると、例外で
              // 残り39クラブが丸ごと確認されず、しかも英語のエラー文が
              // 利用者向けの欄に出ていた。要素ごとに守る。
              const recent = (Array.isArray(sec.recent) ? sec.recent : [])
                .filter((x) => x && x.playerName).slice(0, 3)
                .map((x) => `${x.playerName}(${x.direction === "in" ? "加入" : "移籍"}${x.counterpart ? `・${x.counterpart}` : ""})`);
              if (recent.length) facts.push({ k: t.nameJa || t.nameEn, v: recent.join("、") });
            }
            } catch (e) { clubErrors.push(`${t.nameJa || t.nameEn}: ${errJa(e)}`); }
          }
          push(q, {
            clubErrorsJa: clubErrors.length ? clubErrors.slice(0, 3) : null,
            canAnswer: facts.length > 0, facts: facts.slice(0, 15), aiWordsJa: null,
            clubsChecked: teams.length, clubsWithData,
            reasonJa: facts.length ? null
              : clubsWithData === 0
                ? `${q.kind === "injuries" ? "負傷" : "移籍"}の情報がどのクラブにも保存されていません(まだ収集できていません)。`
                : `${clubsWithData}クラブぶんを確認しましたが、${q.kind === "injuries" ? "負傷・出場停止者" : "直近の移籍"}は1件もありませんでした。`,
          });
          continue;
        }
      } catch (e) {
        push(q, { canAnswer: false, facts: [], aiWordsJa: null, reasonJa: `この質問の確認中に問題が起きました。${errJa(e)}` });
      }
    }
    return { at: new Date(nowMs()).toISOString(), dateKey: dateKeyOf(), answers };
  }

  /**
   * 昨日の答えと今日の答えを突き合わせる。
   * 「賢くなった」= 事実として言えることが増えた / 値が新しくなった。
   */
  function diffAnswers(todaySet, yesterdaySet) {
    const yMap = new Map(((yesterdaySet && yesterdaySet.answers) || []).map((a) => [a.id, a]));
    const items = [];
    let newFactTotal = 0, changedFactTotal = 0, lostFactTotal = 0, newlyAnswerableCount = 0;

    for (const t of (todaySet.answers || [])) {
      const y = yMap.get(t.id) || null;
      // volatile = 中身が毎日必ず入れ替わる質問(今日の試合など)。
      // 画面には出すが、「昨日より賢くなったか」の数には入れない。
      const isVolatile = t.volatile === true;
      const yFacts = new Map(((y && y.facts) || []).map((f) => [f.k, f.v]));
      const tFacts = new Map((t.facts || []).map((f) => [f.k, f.v]));

      const newFacts = [], changedFacts = [], lostFacts = [];
      for (const [k, v] of tFacts) {
        if (!yFacts.has(k)) newFacts.push({ k, v });
        else if (yFacts.get(k) !== v) changedFacts.push({ k, from: yFacts.get(k), to: v });
      }
      for (const [k, v] of yFacts) if (!tFacts.has(k)) lostFacts.push({ k, v });

      const newlyAnswerable = !!(t.canAnswer && y && !y.canAnswer);
      if (!isVolatile) {
        if (newlyAnswerable) newlyAnswerableCount++;
        newFactTotal += newFacts.length;
        changedFactTotal += changedFacts.length;
        lostFactTotal += lostFacts.length;
      }

      // AI自身の言葉(クラブの見解)の変化
      const aiChanged = !!(t.aiWordsJa && y && y.aiWordsJa && t.aiWordsJa !== y.aiWordsJa);

      items.push({
        id: t.id, questionJa: t.questionJa, subjectJa: t.subjectJa || null,
        volatile: isVolatile,
        hadYesterday: !!y,
        canAnswerToday: !!t.canAnswer, canAnswerYesterday: y ? !!y.canAnswer : null,
        newlyAnswerable,
        factCountToday: tFacts.size, factCountYesterday: y ? yFacts.size : null,
        newFacts: newFacts.slice(0, 10),
        changedFacts: changedFacts.slice(0, 10),
        lostFacts: lostFacts.slice(0, 6),
        sameCount: [...tFacts.keys()].filter((k) => yFacts.get(k) === tFacts.get(k)).length,
        aiWordsToday: t.aiWordsJa || null,
        aiWordsYesterday: y ? (y.aiWordsJa || null) : null,
        aiWordsChanged: aiChanged,
        reasonJa: t.reasonJa || null,
      });
    }

    const hasYesterday = !!(yesterdaySet && (yesterdaySet.answers || []).length);
    const grew = newFactTotal > 0 || changedFactTotal > 0 || newlyAnswerableCount > 0;
    // 監査で判明: 増えたことしか見ておらず、「昨日は言えたのに今日は言えない」を
    // 一度も報告していなかった。索引が壊れて選手が消えても「賢くなりました」に
    // なりうる。減った側も必ず書く。
    const lostNote = lostFactTotal > 0
      ? `(いっぽうで、昨日は言えたのに今日は言えなくなったことが ${lostFactTotal}件 あります)`
      : "";
    return {
      available: true,
      hasYesterday,
      items,
      newFactTotal, changedFactTotal, lostFactTotal, newlyAnswerableCount,
      grew: hasYesterday ? grew : null,
      countingNoteJa: "「今日の試合」は毎日必ず顔ぶれが変わるため、増えた数には入れていません(何も学んでいない日でも増えたように見えてしまうため)。",
      verdictJa: !hasYesterday
        ? "昨日の答えが保存されていないため、今日は比較できません(明日から比較できます)。"
        : grew
          ? `同じ8つの質問に対して、昨日は言えなかったことを ${newFactTotal}件 言えるようになり、${changedFactTotal}件 の数値が新しくなりました`
            + (newlyAnswerableCount ? `。さらに ${newlyAnswerableCount}問 は昨日まったく答えられなかった質問です。` : "。")
            + lostNote
          : `同じ8つの質問に対して、昨日から言えることが1つも増えていません(データが更新されていない可能性があります)。${lostNote}`,
    };
  }

  /* ====================================================================
   * ③ 予測(的中率・自信度・説明可能性・較正・答え合わせ)
   * ==================================================================== */
  async function checkPredictions() {
    const [totalRaw, resolvedRaw, correctRaw] = await Promise.all([
      upstashCmd(["GET", "pred:total"]).catch(() => null),
      upstashCmd(["GET", "pred:resolved"]).catch(() => null),
      upstashCmd(["GET", "pred:correct"]).catch(() => null),
    ]);
    const total = parseInt(totalRaw, 10) || 0;
    const resolved = parseInt(resolvedRaw, 10) || 0;
    const correct = parseInt(correctRaw, 10) || 0;

    // ---- 監査で判明した測定先の誤り ----
    //   説明可能性(なぜそう予測したか)と自信度(得点期待値)は、
    //   **このAI自身のモデル**の記録 learn:ownpred:recent にしか入っていない。
    //   pred:recent は API-Football が出した予測の写しで、これらの項目を
    //   そもそも持たない。旧実装はそちらを見ていたため、実際には
    //   説明も自信度も記録されているのに、常に 0% と報告していた。
    const recs = await lrangeOrNull("pred:recent", -120, -1);          // API-Football側(的中率の分母)
    const ownRecs = await lrangeOrNull("learn:ownpred:recent", -300, -1); // このAI自身のモデル
    const readFailed = recs === null || ownRecs === null;
    const recsSafe = recs || [];
    const ownSafe = ownRecs || [];
    const resolvedRecs = recsSafe.filter((r) => r && r.resolved);
    const last24 = resolvedRecs.filter((r) => r.resolvedAt && (nowMs() - new Date(r.resolvedAt).getTime()) < 26 * 3600 * 1000);

    // 説明可能性: 「なぜそう予測したか」を持っている予測の割合(実測)
    const withReason = ownSafe.filter((r) => r && (r.stateHypothesis || (r.factorImportance && r.factorImportance.length))).length;
    // 自信度: λ(得点期待値)から計算できる勝率を持っている予測の割合
    const withConfidence = ownSafe.filter((r) => r && Number.isFinite(r.homeLambda) && Number.isFinite(r.awayLambda)).length;
    // 較正: 較正テーブルが更新されているか
    const calib = await upstashGetJSON("learn:calibration").catch(() => null);
    const weights = await upstashGetJSON("learn:weights").catch(() => null);

    const lastResolvedAt = resolvedRecs
      .map((r) => r.resolvedAt).filter(Boolean).sort().slice(-1)[0] || null;
    const staleHours = lastResolvedAt ? Math.round((nowMs() - new Date(lastResolvedAt).getTime()) / 3600000) : null;

    return {
      ok: total > 0,
      total, resolved, correct,
      accuracyPct: pct(correct, resolved),
      resolvedLast24h: last24.length,
      correctLast24h: last24.filter((r) => r.correct === true).length,
      lastResolvedAt, staleHours,
      explainabilityPct: ownRecs === null ? null : pct(withReason, ownSafe.length),
      confidencePct: ownRecs === null ? null : pct(withConfidence, ownSafe.length),
      sampleSize: ownSafe.length,
      sampleSourceJa: "説明可能性と自信度は、このAI自身のモデルの記録(learn:ownpred)から測っています。的中率はAPI-Football由来の予測の実績です。",
      readFailed,
      calibrationUpdatedAt: calib && calib.updatedAt ? calib.updatedAt : null,
      calibrationBins: calib && Array.isArray(calib.bins) ? calib.bins.length : null,
      weightsVersion: weights && weights.version !== undefined ? weights.version : null,
      weightsUpdatedAt: weights && weights.updatedAt ? weights.updatedAt : null,
      reasonJa: readFailed
        ? "予測の記録を読み出せませんでした(保存先に接続できていません)。0件だったのではなく、測れていません。"
        : total === 0
          ? "予測がまだ1件も記録されていません。"
          : resolved === 0
            ? "予測は記録されていますが、答え合わせがまだ1件もできていません。"
            : null,
    };
  }

  /* ====================================================================
   * ④ 成長指標(実際に増えたか)
   * ==================================================================== */
  async function buildSnapshot() {
    const C = (playerSearch && playerSearch.COL) || {};
    const { rows } = await loadIndexRows();
    const [knowledgeRaw, memoryRaw, totalRaw, resolvedRaw, correctRaw] = await Promise.all([
      upstashCmd(["GET", "learn:knowledge:total"]).catch(() => null),
      upstashCmd(["GET", "learn:memory:total"]).catch(() => null),
      upstashCmd(["GET", "pred:total"]).catch(() => null),
      upstashCmd(["GET", "pred:resolved"]).catch(() => null),
      upstashCmd(["GET", "pred:correct"]).catch(() => null),
    ]);
    const metrics = await upstashGetJSON("learn:metrics:latest").catch(() => null);
    const clubs = new Set(rows.map((r) => r[C.teamEn]).filter(Boolean));
    const resolved = parseInt(resolvedRaw, 10) || 0;
    const correct = parseInt(correctRaw, 10) || 0;
    return {
      at: new Date(nowMs()).toISOString(), dateKey: dateKeyOf(),
      playerCount: rows.length,
      clubCount: clubs.size,
      withRating: rows.filter((r) => num(r[C.rating]) !== null).length,
      withNationality: rows.filter((r) => r[C.nationality]).length,
      knowledgeTotal: parseInt(knowledgeRaw, 10) || null,
      memoryTotal: parseInt(memoryRaw, 10) || null,
      predTotal: parseInt(totalRaw, 10) || 0,
      predResolved: resolved,
      predCorrect: correct,
      accuracyPct: pct(correct, resolved),
      intelligenceScore: metrics && num(metrics.overallScore) !== null ? num(metrics.overallScore) : null,
    };
  }

  function diffSnapshots(today, yesterday) {
    const keys = [
      ["playerCount", "検索できる選手"], ["clubCount", "選手が入っているクラブ"],
      ["withRating", "平均評価まで取れている選手"], ["knowledgeTotal", "知識(Knowledge)"],
      ["memoryTotal", "記憶(Memory)"], ["predTotal", "予測(Prediction)"],
      ["predResolved", "答え合わせ済みの予測"], ["intelligenceScore", "知能スコア"],
    ];
    const items = keys.map(([k, labelJa]) => {
      const t = today ? num(today[k]) : null;
      const y = yesterday ? num(yesterday[k]) : null;
      return { key: k, labelJa, today: t, yesterday: y, delta: (t !== null && y !== null) ? Math.round((t - y) * 100) / 100 : null };
    });
    const measurable = items.filter((i) => i.delta !== null);
    const increased = measurable.filter((i) => i.delta > 0);
    // 監査で判明: 減少をまったく見ていなかった。選手索引が3,000人→500人に
    // 壊れても「予測が+3件」だけを見て前向きな判定を出していた。
    // 「大きく減った」は異常として扱う(5%以上かつ実数で10以上の減少)。
    const dropped = measurable.filter((i) => {
      if (i.delta >= 0) return false;
      const base = Math.abs(i.yesterday || 0);
      return Math.abs(i.delta) >= Math.max(10, base * 0.05);
    });
    return {
      items,
      hasYesterday: !!yesterday,
      increasedCount: increased.length,
      measurableCount: measurable.length,
      droppedCount: dropped.length,
      dropped: dropped.map((i) => ({ labelJa: i.labelJa, yesterday: i.yesterday, today: i.today, delta: i.delta })),
      dropReasonJa: dropped.length
        ? `昨日より大きく減ったものがあります: ${dropped.map((i) => `${i.labelJa} ${i.yesterday} → ${i.today}(${i.delta})`).join(" / ")}`
        : null,
      reasonJa: !yesterday
        ? "昨日の記録が無いため、増減を出せません(明日から出せます)。"
        : increased.length === 0
          ? "昨日から1つも増えていません。学習が完走していないか、収集が進んでいない可能性があります。"
          : null,
    };
  }

  /* ====================================================================
   * ⑥⑦ 取得したデータが、実際に画面から使えるところまで届いているか
   * ==================================================================== */
  async function checkReflection(yesterdaySnapshot) {
    const C = (playerSearch && playerSearch.COL) || {};
    const { rows, available } = await loadIndexRows();
    const out = { player: {}, club: {} };

    /* ⑥ 選手 */
    // 「収集した選手が検索に出るか」を、実際に検索関数を通して確かめる。
    let searchable = null, searchProbeJa = null;
    const probe = rows.find((r) => r[C.name] && num(r[C.rating]) !== null) || rows[0] || null;
    if (probe && playerSearch && typeof playerSearch.searchIndex === "function") {
      try {
        // 画面の検索とまったく同じ関数を通す(「索引にはあるのに検索に出ない」を検出するため)
        const list = playerSearch.searchIndex(rows, { name: String(probe[C.name]) }) || [];
        searchable = list.length > 0;
        searchProbeJa = `索引にいる「${probe[C.name]}」を、画面と同じ検索処理にかけたところ ${list.length}件 見つかりました。`;
      } catch (e) { searchable = false; searchProbeJa = `検索を実行できませんでした: ${e.message}`; }
    }
    const detailReady = probe ? playerFactsFromRow(probe, C).length : 0;
    out.player = {
      ok: !!(available && rows.length > 0 && searchable !== false),
      indexAvailable: available, indexCount: rows.length,
      searchable, searchProbeJa,
      detailFactCount: detailReady,
      withRating: rows.filter((r) => num(r[C.rating]) !== null).length,
      withNationality: rows.filter((r) => r[C.nationality]).length,
      newSincePrevSample: yesterdaySnapshot && num(yesterdaySnapshot.playerCount) !== null
        ? rows.length - num(yesterdaySnapshot.playerCount) : null,
      reasonJa: !available ? "選手索引が作られていません。"
        : rows.length === 0 ? "選手索引は作られていますが0人です。"
          : searchable === false ? "索引に入っている選手を検索したのに見つかりませんでした(検索の絞り込みに問題があります)。"
            : null,
    };

    /* ⑦ クラブ */
    const teams = (registeredTeams || []).slice(0, CLUBS_FOR_AGGREGATE);
    const sectionTally = { form: 0, standings: 0, injuries: 0, transfers: 0, squad: 0, coach: 0 };
    let dossiers = 0, withAnyChange = 0;
    for (const t of teams) {
      const d = clubDossier && typeof clubDossier.getDossier === "function"
        ? await clubDossier.getDossier(t.nameEn).catch(() => null) : null;
      if (!d) continue;
      dossiers++;
      const S = d.sections || {};
      Object.keys(sectionTally).forEach((k) => { if (S[k]) sectionTally[k]++; });
      if ((d.lastChangesJa || []).length) withAnyChange++;
    }
    const clubsInIndex = new Set(rows.map((r) => r[C.teamEn]).filter(Boolean)).size;
    out.club = {
      ok: dossiers > 0 && sectionTally.form > 0,
      clubsChecked: teams.length, dossiers,
      sections: sectionTally,
      clubsWithPlayersInIndex: clubsInIndex,
      clubsWithRecordedChanges: withAnyChange,
      reasonJa: dossiers === 0 ? "クラブ調査ファイルが1件も作られていません。"
        : sectionTally.form === 0 ? "調査ファイルはありますが、フォーム(直近成績)が1件も入っていません。"
          : null,
    };
    return out;
  }

  /* ====================================================================
   * ⑧ 異常の検知
   * ==================================================================== */
  function detectAnomalies(ctx) {
    const list = [];
    const add = (code, labelJa, detailJa, repairKey) => list.push({ code, labelJa, detailJa, repairKey: repairKey || null, repaired: false, repairNoteJa: null });

    if (!ctx.learning.available || !ctx.learning.finished || !ctx.learning.isToday) {
      add("LEARNING_STOPPED", "学習が完走していない", ctx.learning.reasonJa, "runDailyLearning");
    }
    if (!ctx.reflection.player.indexAvailable || ctx.reflection.player.indexCount === 0) {
      add("INDEX_MISSING", "選手索引が使えない", ctx.reflection.player.reasonJa || "索引がありません。", "rebuildPlayerIndex");
    }
    if (ctx.reflection.player.searchable === false) {
      add("SEARCH_BROKEN", "索引にいる選手を検索できない", ctx.reflection.player.searchProbeJa, "rebuildPlayerIndex");
    }
    if (ctx.reflection.club.dossiers === 0) {
      add("CLUB_DATA_MISSING", "クラブ情報が1件も無い", ctx.reflection.club.reasonJa, "collectPlayers");
    }
    if (ctx.predictions.total === 0) {
      add("PREDICTION_STOPPED", "予測が1件も記録されていない", ctx.predictions.reasonJa, "runDailyLearning");
    } else if (ctx.predictions.readFailed) {
      add("REDIS_READ_FAILED", "予測の記録を読み出せなかった", ctx.predictions.reasonJa, null);
    } else if (ctx.predictions.staleHours !== null && ctx.predictions.staleHours > 30) {
      add("RESOLVE_STALLED", "答え合わせが止まっている", `最後の答え合わせから ${ctx.predictions.staleHours}時間 経っています。`, "resolvePredictions");
    } else if (ctx.predictions.lastResolvedAt === null && ctx.predictions.total > 0) {
      add("RESOLVE_STALLED", "答え合わせが1件も進んでいない", "予測はありますが、結果と突き合わせた記録がありません。", "resolvePredictions");
    }
    if (ctx.growth.droppedCount > 0) {
      add("DATA_REGRESSION", "昨日より大きく減ったものがある", ctx.growth.dropReasonJa, "rebuildPlayerIndex");
    }
    if (ctx.answersDiff.hasYesterday && ctx.answersDiff.lostFactTotal > 0) {
      add("ANSWER_REGRESSION", "昨日は言えたのに今日は言えなくなったことがある",
        `${ctx.answersDiff.lostFactTotal}件が答えられなくなっています。`, "rebuildPlayerIndex");
    }
    if (ctx.growth.hasYesterday && ctx.growth.increasedCount === 0) {
      add("NO_GROWTH", "昨日から1つも増えていない", ctx.growth.reasonJa, "collectPlayers");
    }
    if (ctx.answersDiff.hasYesterday && ctx.answersDiff.grew === false) {
      add("ANSWER_UNCHANGED", "同じ質問への答えが昨日から変わっていない", ctx.answersDiff.verdictJa, "collectPlayers");
    }
    if (ctx.storageFailed) {
      add("REDIS_SAVE_FAILED", "保存先(データベース)への書き込みに失敗した", ctx.storageFailed, null);
    }
    return list;
  }

  /* ====================================================================
   * ⑨ 自己修復: 直せるものを直し、直したあとにもう一度測る
   * ==================================================================== */
  async function selfRepair(anomalies, done, noteByCode) {
    const log = [];
    const r = repair || {};
    for (const a of anomalies) {
      const note = (txt) => { a.repairNoteJa = txt; if (noteByCode) noteByCode.set(a.code, txt); };
      if (!a.repairKey) { note("この異常は自動では直せません(人による修正が必要です)。"); continue; }
      // 監査で判明: この Set は selfRepair の中で作られていたため
      // 「1回のQAで各1回まで」になっておらず、2巡すれば同じ修復が2回走っていた
      // (API-Footballの二重消費・索引の二重再構築)。呼び出し側から渡す。
      if (done.has(a.repairKey)) { note("同じ修復をこの実行内で既に試みています。"); continue; }
      const fn = r[a.repairKey];
      if (typeof fn !== "function") { note(`この環境では「${repairLabel(a.repairKey)}」を実行できません。`); continue; }
      done.add(a.repairKey);
      const startedAt = new Date(nowMs()).toISOString();
      try {
        const res = await fn();
        // ---- 監査で見つかった、いちばん重い問題 ----
        //   例外が飛ばなければ「直しました」と書いていた。ところが実際の修復処理は
        //   「既に実行中です」「本日の上限に達しました」を **例外ではなく戻り値** で
        //   返す。その結果、何もしていない日にも
        //   「索引を作り直しました」「学習を起動しました」と書いていた。
        //   このプロジェクトが最も禁じている、でっち上げそのものだった。
        const eff = judgeRepairResult(a.repairKey, res);
        a.repaired = eff.acted;
        note(eff.acted
          ? `「${a.labelJa}」に対して${repairLabel(a.repairKey)}を実行しました。${eff.resultJa}`
          : `${repairLabel(a.repairKey)}は実行されませんでした(${eff.resultJa})。`);
        log.push({
          repairKey: a.repairKey, labelJa: repairLabel(a.repairKey), forCode: a.code,
          startedAt, ok: eff.acted, resultJa: eff.resultJa,
        });
      } catch (e) {
        note(`${repairLabel(a.repairKey)}を実行しましたが、失敗しました。${errJa(e)}`);
        log.push({
          repairKey: a.repairKey, labelJa: repairLabel(a.repairKey), forCode: a.code,
          startedAt, ok: false, resultJa: `${repairLabel(a.repairKey)}に失敗しました。${errJa(e)}`,
        });
      }
    }
    return log;
  }

  /**
   * 修復処理の戻り値を読んで「本当に何かしたのか」を判定する。
   * 実行されなかった場合は、その理由をそのまま日本語で残す。
   */
  function judgeRepairResult(key, res) {
    if (!res || typeof res !== "object") {
      return { acted: false, resultJa: "実行結果を確認できませんでした(何をしたのか分かりません)。" };
    }
    if (res.alreadyRunning === true) return { acted: false, resultJa: res.reasonJa || "同じ処理が既に実行中でした。" };
    if (res.started === false) return { acted: false, resultJa: res.reasonJa || "起動できませんでした。" };
    if (res.ok === false) return { acted: false, resultJa: res.reasonJa || "処理は走りましたが、成功しませんでした。" };
    if (key === "rebuildPlayerIndex") {
      const n = num(res.count);
      if (n === null) return { acted: false, resultJa: "作り直した人数が返ってこなかったため、成功したとは書けません。" };
      return { acted: n > 0, resultJa: `保存済みのデータから ${n.toLocaleString()}人 の索引を作り直しました(外部API ${res.apiCalls ?? 0}回)。` };
    }
    if (key === "collectPlayers") {
      const clubs = num(res.clubsFetched !== undefined ? res.clubsFetched : res.clubsProcessed);
      const players = num(res.playersFetched !== undefined ? res.playersFetched : (res.playersAdded !== undefined ? res.playersAdded : res.count));
      if (clubs === null && players === null) return { acted: false, resultJa: "取得件数が返ってこなかったため、成功したとは書けません。" };
      return {
        acted: (players || 0) > 0 || (clubs || 0) > 0,
        resultJa: `${clubs ?? "?"}クラブ・${players ?? "?"}人 を追加で収集しました(API ${res.apiRequests ?? "?"}回)。`,
      };
    }
    if (key === "resolvePredictions") {
      const n = num(res.resolved);
      if (n === null) return { acted: false, resultJa: "答え合わせの件数が返ってこなかったため、成功したとは書けません。" };
      return { acted: n > 0, resultJa: n > 0 ? `${n}件 の答え合わせを進めました(新規記録 ${res.logged ?? 0}件)。` : "答え合わせできる試合がまだありませんでした(0件)。" };
    }
    if (key === "runDailyLearning") {
      return { acted: res.started === true, resultJa: res.started === true ? "毎日の学習を起動しました(完走までは時間がかかります)。" : (res.reasonJa || "起動できませんでした。") };
    }
    return { acted: res.ok !== false, resultJa: res.reasonJa || "実行しました。" };
  }

  /* ====================================================================
   * 全体を通す
   * ==================================================================== */
  async function runAutoQA(opts) {
    const o = opts || {};
    const startedAt = new Date(nowMs()).toISOString();
    if (!upstashEnabled) {
      return { ok: false, available: false, reasonJa: "保存先(Upstash)が未設定のため、自動QAを実行できません。" };
    }
    const todayKey = dateKeyOf();
    const yKey = dateKeyOf(new Date(nowMs() - 86400000));

    let storageFailed = null;

    // --- 測る(1回目) ---
    const measure = async () => {
      // 修復のあとに測り直すので、前回の読み出しをそのまま使ってはいけない
      resetMemo();
      const learning = await checkLearningRun();
      const answersToday = await buildAnswers();
      const yesterdayAnswers = await upstashGetJSON(`qa:answers:${yKey}`).catch(() => null);
      const answersDiff = diffAnswers(answersToday, yesterdayAnswers);
      const predictions = await checkPredictions();
      const snapToday = await buildSnapshot();
      const snapYesterday = await upstashGetJSON(`qa:snapshot:${yKey}`).catch(() => null);
      const growth = diffSnapshots(snapToday, snapYesterday);
      const reflection = await checkReflection(snapYesterday);
      return { learning, answersToday, answersDiff, predictions, snapToday, snapYesterday, growth, reflection };
    };

    let m = await measure();
    let anomalies = detectAnomalies({ ...m, storageFailed });
    const anomaliesBefore = anomalies.map((a) => ({ code: a.code, labelJa: a.labelJa, detailJa: a.detailJa }));

    /* ⑨ 直す → もう一度測る(最大 repairRounds 回) */
    const maxRounds = Number.isFinite(o.repairRounds) ? o.repairRounds : 2;
    const repairLog = [];
    // 「同じ修復は1回のQAで1回まで」を、巡をまたいで守る
    const repairDone = new Set();
    // 監査で判明: 測り直すと異常オブジェクトが作り直されるため、
    // 「なぜ直せなかったか」の説明が全部 null に戻り、画面に何も出なかった。
    // 説明は異常の種類ごとに持ち越す。
    const noteByCode = new Map();
    let rounds = 0;
    while (anomalies.length > 0 && rounds < maxRounds) {
      rounds++;
      const roundLog = await selfRepair(anomalies, repairDone, noteByCode);
      repairLog.push({ round: rounds, actions: roundLog, anomalies: anomalies.map((a) => a.code) });
      if (!roundLog.some((x) => x.ok)) break; // 実際に何かできたものが1つも無いなら、繰り返しても意味がない
      m = await measure();
      anomalies = detectAnomalies({ ...m, storageFailed });
    }

    const remaining = anomalies.map((a) => ({
      code: a.code, labelJa: a.labelJa, detailJa: a.detailJa,
      repairNoteJa: a.repairNoteJa || noteByCode.get(a.code) || null,
    }));
    const fixedCodes = anomaliesBefore.map((a) => a.code).filter((c) => !remaining.some((r) => r.code === c));

    const report = {
      ok: remaining.length === 0,
      available: true,
      dateKey: todayKey,
      comparedWith: yKey,
      startedAt,
      finishedAt: new Date(nowMs()).toISOString(),
      /* ① */ learning: m.learning,
      /* ② */ answers: { today: m.answersToday, diff: m.answersDiff },
      /* ③ */ predictions: m.predictions,
      /* ④ */ growth: m.growth,
      /* ⑥⑦ */ reflection: m.reflection,
      /* ⑧⑨ */ anomalies: {
        foundCount: anomaliesBefore.length,
        found: anomaliesBefore,
        fixedCount: fixedCodes.length,
        fixedCodes,
        remainingCount: remaining.length,
        remaining,
        repairRounds: rounds,
        repairLog,
      },
      verdictJa: buildVerdict(m, remaining, fixedCodes),
      honestyJa: "この報告はすべて、保存されている実測値と実際の実行結果から機械的に作っています。"
        + "AIが文章を作って「賢くなりました」と述べているのではありません。"
        + "取得できていないものは、取得できていないと書いています。",
    };

    // ---- 保存(明日の比較材料 + 画面用) ----
    //   監査で判明: 保存の成否を見る前に report.ok を確定させていたため、
    //   **1件も保存できなかった日でも「ok:true・異常0件」** と報告していた。
    //   その日は翌日の比較材料も残らないので、翌日は永久に
    //   「昨日の答えが保存されていないため比較できません」になる。
    //   保存してから、その結果を報告に反映する。
    try {
      const okA = await upstashSetJSON(`qa:answers:${todayKey}`, m.answersToday);
      const okS = await upstashSetJSON(`qa:snapshot:${todayKey}`, m.snapToday);
      const okR = await upstashSetJSON(`qa:report:${todayKey}`, report);
      const okL = await upstashSetJSON("qa:report:latest", report);
      const failed = [];
      if (okA === false) failed.push("今日の答え");
      if (okS === false) failed.push("今日の指標");
      if (okR === false || okL === false) failed.push("今日の報告");
      if (failed.length) {
        storageFailed = `自動QAの結果を保存できませんでした(${failed.join("・")})。明日は「昨日との比較」ができません。`;
      }
      await upstashCmd(["EXPIRE", `qa:answers:${todayKey}`, String(45 * 86400)]).catch(() => {});
      await upstashCmd(["EXPIRE", `qa:snapshot:${todayKey}`, String(45 * 86400)]).catch(() => {});
      await upstashCmd(["EXPIRE", `qa:report:${todayKey}`, String(45 * 86400)]).catch(() => {});
    } catch (e) {
      storageFailed = `自動QAの結果を保存できませんでした。${errJa(e)} 明日は「昨日との比較」ができません。`;
    }
    if (storageFailed) {
      report.storageFailedJa = storageFailed;
      report.ok = false;
      report.anomalies.remaining = [
        ...report.anomalies.remaining,
        { code: "REDIS_SAVE_FAILED", labelJa: "保存先(データベース)への書き込みに失敗した", detailJa: storageFailed, repairNoteJa: null },
      ];
      report.anomalies.remainingCount = report.anomalies.remaining.length;
      report.anomalies.foundCount = report.anomalies.foundCount + 1;
      report.anomalies.found = [
        ...report.anomalies.found,
        { code: "REDIS_SAVE_FAILED", labelJa: "保存先(データベース)への書き込みに失敗した", detailJa: storageFailed },
      ];
      report.verdictJa = `${report.verdictJa}${storageFailed}`;
      // 保存できなかった報告を、せめて画面には出せるようにもう一度だけ試す
      await upstashSetJSON("qa:report:latest", report).catch(() => {});
    }
    return report;
  }

  function buildVerdict(m, remaining, fixedCodes) {
    const parts = [];
    parts.push(m.learning.ok ? `学習は${m.learning.expectedStageCount}段階すべてを完走しました。` : `学習は完走していません(${m.learning.reasonJa})。`);
    if (m.answersDiff.hasYesterday) {
      parts.push(m.answersDiff.grew
        ? `同じ8つの質問で、昨日は言えなかったことを${m.answersDiff.newFactTotal}件言えるようになり、${m.answersDiff.changedFactTotal}件の数値が新しくなりました。`
        : "同じ8つの質問で、昨日から言えることが増えていません。");
    } else {
      parts.push("昨日の答えが保存されていないため、今日は「昨日より賢くなったか」を判定できません(明日から判定できます)。");
    }
    if (m.growth.hasYesterday) {
      const up = m.growth.items.filter((i) => i.delta !== null && i.delta > 0)
        .map((i) => `${i.labelJa} +${i.delta}`).slice(0, 4);
      parts.push(up.length ? `増えたもの: ${up.join(" / ")}。` : "件数はどれも増えていません。");
    }
    if (m.growth.droppedCount > 0) parts.push(`${m.growth.dropReasonJa}。`);
    if (m.answersDiff.lostFactTotal > 0) parts.push(`昨日は言えたのに今日は言えなくなったことが${m.answersDiff.lostFactTotal}件あります。`);
    if (fixedCodes.length) parts.push(`見つけた異常のうち${fixedCodes.length}件は、この場で直して正常を確認しました。`);
    if (remaining.length) parts.push(`まだ直っていない異常が${remaining.length}件あります: ${remaining.map((r) => r.labelJa).join("、")}。`);
    return parts.join("");
  }

  return { runAutoQA, buildAnswers, diffAnswers, checkLearningRun, checkPredictions, buildSnapshot, diffSnapshots, checkReflection, detectAnomalies, FIXED_QUESTIONS };
}

module.exports = { createAutoQA, FIXED_QUESTIONS, YOUNG_AGE_MAX };
