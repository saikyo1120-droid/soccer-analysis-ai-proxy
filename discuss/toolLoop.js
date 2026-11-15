"use strict";
/**
 * v104(2026年11月12日)・会話②④: 道具つきの会話ループ(プロバイダー非依存)
 * ----------------------------------------------------------------------------
 *   1. 回答AIに質問+文脈+道具の定義を渡す
 *   2. 回答AIが tool_use を返したら、道具を実行して tool_result を返す(最大 maxRounds 往復・maxCalls 回)
 *   3. tool_use が無い応答(=最終回答)が返ったら終了
 *   ・流れる表示: 各往復の本文断片は emit({t:"delta"}) で即座に流す。その往復が道具呼び出しで
 *     終わった(=本文は「確認します」などの途中経過だった)ときは emit({t:"reset"}) で画面を消し、
 *     道具の進行を emit({t:"status"}) で伝える。最後の往復だけが本文として残る。
 *   ・予算: 2往復目以降は canAffordRound() が true のときだけ続ける(サイト全体のLLM予算)。
 *     続けられないときは、ここまでのデータだけで最終回答を求める(exhausted:true を開示)。
 *   ・時間切れ: 重いモデルの往復が TIMEOUT なら、fallbackTier(軽量)で同じ往復を1回だけやり直す。
 *   ・失敗はこの関数の外へ投げる(呼び出し側が従来の1往復へ戻すかを決める)。
 *
 * v104.2(2026年11月15日・回答AIを 5.5 世代へ上げるための、公式の決まりへの対応)
 * ----------------------------------------------------------------------------
 *   5 世代以降の Claude は、応答に thinking ブロック(考えた跡。中身は空でも署名つき)を付けることがあり、
 *   道具の往復には次の決まりがある(platform.claude.com/docs の thinking / 移行手順より):
 *     (a) 道具を呼んだ応答は、thinking ブロックも含めて**受け取ったまま**次の要求へ返す
 *     (b) 会話の途中で system や tools を変えない(変えると、後ろの thinking ブロックの照合に失敗して拒まれうる)
 *     (c) 空の text ブロックを送らない
 *   これまでの実装は (a) text と tool_use だけに作り直して返し、(b) 上限・予算切れのときと上位モデルの
 *   仕上げのときに tools を外して同じ会話を続けていた。そこで次のように改めた:
 *     ・道具の往復: 応答は rawContent(受け取ったままの全ブロック)で返す。tools は最後まで同じものを渡す
 *     ・仕上げ(上限・予算切れのあとの最終回答、上位モデルでの書き直し): 道具の会話を続けず、
 *       **新しい1往復**(質問+文脈 + 道具で取得したデータを文章にしたもの + 下書き)で書かせる。
 *       道具のブロックも thinking ブロックも含まない最も単純な形なので、モデルを切り替えても決まりに触れない。
 *       上限・予算切れで上位モデルの仕上げもある場合は、その1往復にまとめる(呼び出しが1回減る)。
 *   渡す内容(質問・文脈・道具の結果・下書き)は従来と同じ。変わったのは渡し方だけ。
 */

const DEFAULTS = { maxRounds: 3, maxCalls: 5, maxTokens: 1200, timeoutMs: 45000 };

function textOf(content) {
  return (content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("");
}

/** 会話へ返す assistant の内容: 受け取ったままの全ブロック(無ければ従来どおり text / tool_use) */
function assistantContentOf(out) {
  const raw = out && Array.isArray(out.rawContent) && out.rawContent.length ? out.rawContent : null;
  return raw || (out && out.content) || [];
}

const FRESH_SEP = "──────────";
/**
 * 仕上げの1往復に渡す利用者メッセージ(文章だけ)。
 *   質問+文脈(最初のメッセージそのまま)→ 道具で取得したデータ → 下書き(あれば)→ 指示、の順。
 */
function buildFreshFinalContent(userContent, toolResultsLog, draftText, instruction) {
  const parts = [String(userContent || "")];
  if (Array.isArray(toolResultsLog) && toolResultsLog.length) {
    parts.push("", FRESH_SEP, "この質問のためにサーバーが道具で取得したデータ(数字・固有名詞はここと上の事実にあるものだけを使い、無いものは「取得できません」と書くこと):");
    toolResultsLog.forEach((t, i) => {
      parts.push(`[${i + 1}] 道具: ${t.name} / 入力: ${JSON.stringify(t.input || {})}`, `結果: ${t.resultJson}`);
    });
  }
  if (draftText) {
    parts.push("", FRESH_SEP, "下書き(上の事実とデータをもとに、先に書かれたもの):", draftText);
  }
  parts.push("", FRESH_SEP, String(instruction || ""));
  return parts.join("\n");
}

/**
 * @param {object} p
 * @param {string} p.systemPrompt
 * @param {string} p.userContent              最初の利用者メッセージ(文脈+質問)
 * @param {Array}  p.tools                    toolDefinitions() の結果(空なら道具なし=1往復)
 * @param {(name:string,input:object)=>Promise<{resultJson:string, summaryJa:string, ok:boolean, elapsedMs:number}>} p.execute
 * @param {Function} p.generateConversation   llm/index.js の generateConversation
 * @param {"light"|"heavy"} [p.tier]          道具の往復に使うモデル
 * @param {"light"|"heavy"} [p.finalTier]     最終回答に使うモデル(tier と違うときは最後に1回だけ追加で呼ぶ)
 * @param {boolean} [p.stream]
 * @param {(ev:object)=>void} [p.emit]
 * @param {() => Promise<boolean>} [p.canAffordRound]  2往復目以降の予算確認
 * @param {number} [p.maxRounds] [p.maxCalls] [p.maxTokens] [p.timeoutMs] [p.finalTimeoutMs] [p.finalMaxTokens]
 * @param {string} [p.finalInstruction]       finalTier の追加呼び出しで添える指示
 */
async function runToolLoop(p) {
  const maxRounds = Math.max(1, p.maxRounds || DEFAULTS.maxRounds);
  const maxCalls = Math.max(1, p.maxCalls || DEFAULTS.maxCalls);
  const emit = typeof p.emit === "function" ? p.emit : () => {};
  const messages = [{ role: "user", content: p.userContent }];
  const tools = Array.isArray(p.tools) ? p.tools : [];
  const toolCalls = [];
  const toolResultsLog = []; // 仕上げの1往復へ文章で渡すための控え {name, input, resultJson}
  const modelFallbacks = []; // 別の版のモデルで答えた往復の記録 {from, to, reason}(開示・診断用)
  let rounds = 0;
  let calls = 0;
  let exhausted = false;
  let exhaustedReasonJa = null;
  let last = null;
  let lastModel = null;
  let usedFallbackFrom = null;
  const noteModelFallback = (r) => {
    if (r && r.fallbackFrom && r.fallbackReason && r.fallbackReason !== "timeout") modelFallbacks.push({ from: r.fallbackFrom, to: r.model || null, reason: r.fallbackReason });
  };
  const generateRound = async (tier, opts) => {
    const o = opts || {};
    const roundMessages = o.messages || messages;
    const roundTools = o.tools === undefined ? tools : o.tools;
    let streamedText = "";
    const onDelta = p.stream ? (t) => { streamedText += t; emit({ t: "delta", text: t }); } : undefined;
    try {
      const r = await p.generateConversation({
        systemPrompt: p.systemPrompt, messages: roundMessages, tools: roundTools,
        maxTokens: o.maxTokens || p.maxTokens || DEFAULTS.maxTokens, tier,
        timeoutMs: o.timeoutMs || p.timeoutMs || DEFAULTS.timeoutMs, stream: !!p.stream, onDelta,
      });
      noteModelFallback(r);
      return { ...r, streamedText };
    } catch (e) {
      if (e && e.code === "TIMEOUT" && tier === "heavy" && p.fallbackTier && p.fallbackTier !== tier) {
        if (streamedText) emit({ t: "reset" });
        emit({ t: "status", key: "fallback", ja: "重いモデルが時間切れのため、高速モデルで答え直しています…" });
        usedFallbackFrom = "heavy";
        streamedText = "";
        const r2 = await p.generateConversation({
          systemPrompt: p.systemPrompt, messages: roundMessages, tools: roundTools,
          maxTokens: Math.min(o.maxTokens || p.maxTokens || DEFAULTS.maxTokens, 1000), tier: p.fallbackTier,
          timeoutMs: p.fallbackTimeoutMs || 25000, stream: !!p.stream, onDelta,
        });
        noteModelFallback(r2);
        return { ...r2, streamedText, fallbackFrom: "heavy" };
      }
      throw e;
    }
  };

  const loopTier = p.tier || "light";
  for (;;) {
    rounds++;
    last = await generateRound(loopTier);
    lastModel = last.model || lastModel;
    const toolUses = (last.content || []).filter((b) => b && b.type === "tool_use");
    if (!toolUses.length) break;
    // 道具を呼ぶ往復だった → 流した途中経過を消して、道具の進行を伝える
    if (last.streamedText) emit({ t: "reset" });
    // v104.2 (a): 受け取ったままの形で返す(thinking ブロックを落とさない・並べ替えない)
    messages.push({ role: "assistant", content: assistantContentOf(last) });
    const results = [];
    for (const tu of toolUses) {
      if (calls >= maxCalls) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ ok: false, reasonJa: "1つの質問で使える道具の回数の上限に達しました。手元の情報で答えてください。" }) });
        continue;
      }
      calls++;
      emit({ t: "status", key: "tool", tool: tu.name, ja: `${toolLabel(tu.name)}を確認しています…` });
      const r = await p.execute(tu.name, tu.input || {});
      const resultJson = (r && typeof r.resultJson === "string" && r.resultJson) ? r.resultJson : "{}";
      toolCalls.push({ name: tu.name, input: tu.input || {}, ok: !!(r && r.ok), elapsedMs: r && r.elapsedMs, summaryJa: r && r.summaryJa, summary: (r && r.summary) || null });
      toolResultsLog.push({ name: tu.name, input: tu.input || {}, resultJson });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: resultJson });
    }
    messages.push({ role: "user", content: results });
    if (rounds >= maxRounds) {
      exhausted = true;
      exhaustedReasonJa = "道具の往復回数の上限に達しました。";
      break;
    }
    if (typeof p.canAffordRound === "function") {
      const ok = await p.canAffordRound();
      if (!ok) {
        exhausted = true;
        exhaustedReasonJa = "本日のサイト全体のAI利用予算が残り少ないため、これ以上道具は使えません。";
        break;
      }
    }
    emit({ t: "status", key: "thinking", ja: "取得したデータをもとに考えています…" });
  }

  // ---- 仕上げ ----
  //   ・上限・予算切れで道具の往復を打ち切ったとき → ここまでのデータだけで最終回答を書かせる
  //   ・重い質問(実データの揃ったクラブ考察など)→ 上位モデルで書き直す(軽量モデルの下書きは材料として渡す)
  //   どちらも「新しい1往復」で行う(v104.2 (b)。道具の会話は続けない)。両方に当てはまるときは1回にまとめる。
  let finalOut = last;
  let finalSkippedForBudget = false;
  const wantsFinalTier = !!(p.finalTier && p.finalTier !== loopTier);
  if (wantsFinalTier && typeof p.canAffordRound === "function" && !(await p.canAffordRound())) {
    // 仕上げの1回もサイト全体の予算に数える(予算が無ければ軽量モデルのまま答える=必ず答えは返る)
    finalSkippedForBudget = true;
  }
  const useFinalTier = wantsFinalTier && !finalSkippedForBudget;
  if (exhausted || useFinalTier) {
    const draftText = exhausted ? "" : textOf(last.content);
    if (!exhausted && last.streamedText) emit({ t: "reset" }); // 下書きとして流した本文を消す(打ち切りのときは道具の往復で既に消してある)
    emit(useFinalTier
      ? { t: "status", key: "finalizing", ja: "上位モデルが最終回答をまとめています…" }
      : { t: "status", key: "thinking", ja: "取得したデータをもとに考えています…" });
    const baseFinalInstruction = p.finalInstruction || "上の下書きと取得済みのデータをもとに、指定の形式で最終回答を書き直してください。数字は取得済みのものだけを使うこと。";
    const instruction = exhausted
      ? `${exhaustedReasonJa}ここまでに取得できた情報だけで、指定の形式で最終回答を書いてください(取得できなかった項目は「取得できません」と正直に書く)。`
      : baseFinalInstruction;
    const freshMessages = [{ role: "user", content: buildFreshFinalContent(p.userContent, toolResultsLog, draftText, instruction) }];
    if (exhausted) rounds++; // 打ち切り後の最終回答も1往復として数える(従来と同じ数え方)
    finalOut = await generateRound(useFinalTier ? p.finalTier : loopTier, useFinalTier
      ? { messages: freshMessages, tools: [], maxTokens: p.finalMaxTokens || 1400, timeoutMs: p.finalTimeoutMs || 60000 }
      : { messages: freshMessages, tools: [] });
    lastModel = finalOut.model || lastModel;
  }
  return {
    text: textOf(finalOut.content),
    content: finalOut.content,
    model: lastModel,
    tier: finalOut.tier || null,
    truncated: !!finalOut.truncated,
    fallbackFrom: (finalOut.fallbackFrom === "heavy" ? "heavy" : null) || usedFallbackFrom || null,
    modelFallbacks,
    rounds, calls, toolCalls, exhausted, finalSkippedForBudget,
    messages,
  };
}

function toolLabel(name) {
  const L = { get_today_predictions: "今日のAI予想", get_prediction_detail: "予想の詳細", get_team_snapshot: "クラブの現状", get_match_analysis: "対戦分析", get_player_stats: "選手の今季成績", get_recent_misses: "外した予想の反省", get_accuracy_summary: "的中率の実測" };
  return L[name] || name;
}

module.exports = { runToolLoop, DEFAULTS, toolLabel, buildFreshFinalContent, assistantContentOf };
