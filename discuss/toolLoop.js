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
 *     続けられないときは道具を外して最終回答だけを求める(exhausted:true を開示)。
 *   ・時間切れ: 重いモデルの往復が TIMEOUT なら、fallbackTier(軽量)で同じ往復を1回だけやり直す。
 *   ・失敗はこの関数の外へ投げる(呼び出し側が従来の1往復へ戻すかを決める)。
 */

const DEFAULTS = { maxRounds: 3, maxCalls: 5, maxTokens: 1200, timeoutMs: 45000 };

function textOf(content) {
  return (content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("");
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
  const toolCalls = [];
  let rounds = 0;
  let calls = 0;
  let exhausted = false;
  let tools = Array.isArray(p.tools) ? p.tools : [];
  let last = null;
  let lastModel = null;
  let usedFallbackFrom = null;
  const generateRound = async (tier, opts) => {
    const o = opts || {};
    let streamedText = "";
    const onDelta = p.stream ? (t) => { streamedText += t; emit({ t: "delta", text: t }); } : undefined;
    try {
      const r = await p.generateConversation({
        systemPrompt: p.systemPrompt, messages, tools: o.tools === undefined ? tools : o.tools,
        maxTokens: o.maxTokens || p.maxTokens || DEFAULTS.maxTokens, tier,
        timeoutMs: o.timeoutMs || p.timeoutMs || DEFAULTS.timeoutMs, stream: !!p.stream, onDelta,
      });
      return { ...r, streamedText };
    } catch (e) {
      if (e && e.code === "TIMEOUT" && tier === "heavy" && p.fallbackTier && p.fallbackTier !== tier) {
        if (streamedText) emit({ t: "reset" });
        emit({ t: "status", key: "fallback", ja: "重いモデルが時間切れのため、高速モデルで答え直しています…" });
        usedFallbackFrom = "heavy";
        streamedText = "";
        const r2 = await p.generateConversation({
          systemPrompt: p.systemPrompt, messages, tools: o.tools === undefined ? tools : o.tools,
          maxTokens: Math.min(o.maxTokens || p.maxTokens || DEFAULTS.maxTokens, 1000), tier: p.fallbackTier,
          timeoutMs: p.fallbackTimeoutMs || 25000, stream: !!p.stream, onDelta,
        });
        return { ...r2, streamedText, fallbackFrom: "heavy" };
      }
      throw e;
    }
  };

  for (;;) {
    rounds++;
    const tier = p.tier || "light";
    last = await generateRound(tier, { tools: exhausted ? [] : tools });
    lastModel = last.model || lastModel;
    const toolUses = (last.content || []).filter((b) => b && b.type === "tool_use");
    if (!toolUses.length || exhausted) break;
    // 道具を呼ぶ往復だった → 流した途中経過を消して、道具の進行を伝える
    if (last.streamedText) emit({ t: "reset" });
    messages.push({ role: "assistant", content: last.content });
    const results = [];
    for (const tu of toolUses) {
      if (calls >= maxCalls) {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ ok: false, reasonJa: "1つの質問で使える道具の回数の上限に達しました。手元の情報で答えてください。" }) });
        continue;
      }
      calls++;
      emit({ t: "status", key: "tool", tool: tu.name, ja: `${toolLabel(tu.name)}を確認しています…` });
      const r = await p.execute(tu.name, tu.input || {});
      toolCalls.push({ name: tu.name, input: tu.input || {}, ok: !!r.ok, elapsedMs: r.elapsedMs, summaryJa: r.summaryJa });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.resultJson });
    }
    messages.push({ role: "user", content: results });
    if (rounds >= maxRounds) {
      exhausted = true; // 次の往復は道具なしで最終回答を求める
      messages.push({ role: "user", content: "道具の往復回数の上限に達しました。ここまでに取得できた情報だけで、指定の形式で最終回答を書いてください(取得できなかった項目は「取得できません」と正直に書く)。" });
      continue;
    }
    if (typeof p.canAffordRound === "function") {
      const ok = await p.canAffordRound();
      if (!ok) {
        exhausted = true;
        messages.push({ role: "user", content: "本日のサイト全体のAI利用予算が残り少ないため、これ以上道具は使えません。ここまでに取得できた情報だけで、指定の形式で最終回答を書いてください。" });
        continue;
      }
    }
    emit({ t: "status", key: "thinking", ja: "取得したデータをもとに考えています…" });
  }

  // 最終回答を重いモデルで書き直す(道具の往復は軽量モデル、仕上げだけ上位モデル)。
  //   道具を使わなかった場合も、重い質問(実データの揃ったクラブ考察)は上位モデルで仕上げる
  //   (従来の heavy 1回と同じ品質を保つ=劣化禁止。軽量モデルの下書きは材料として渡す)。
  let finalOut = last;
  let finalSkippedForBudget = false;
  if (p.finalTier && p.finalTier !== (p.tier || "light")) {
    // 仕上げの1回もサイト全体の予算に数える(予算が無ければ軽量モデルの下書きをそのまま答えにする=必ず答えは返る)
    if (typeof p.canAffordRound === "function" && !(await p.canAffordRound())) {
      finalSkippedForBudget = true;
    }
  }
  if (p.finalTier && p.finalTier !== (p.tier || "light") && !finalSkippedForBudget) {
    if (last.streamedText) emit({ t: "reset" });
    emit({ t: "status", key: "finalizing", ja: "上位モデルが最終回答をまとめています…" });
    messages.push({ role: "assistant", content: last.content });
    messages.push({ role: "user", content: p.finalInstruction || "上の下書きと取得済みのデータをもとに、指定の形式で最終回答を書き直してください。数字は取得済みのものだけを使うこと。" });
    finalOut = await generateRound(p.finalTier, { tools: [], maxTokens: p.finalMaxTokens || 1400, timeoutMs: p.finalTimeoutMs || 60000 });
    lastModel = finalOut.model || lastModel;
  }
  return {
    text: textOf(finalOut.content),
    content: finalOut.content,
    model: lastModel,
    tier: finalOut.tier || null,
    truncated: !!finalOut.truncated,
    fallbackFrom: finalOut.fallbackFrom || usedFallbackFrom || null,
    rounds, calls, toolCalls, exhausted, finalSkippedForBudget,
    messages,
  };
}

function toolLabel(name) {
  const L = { get_today_predictions: "今日のAI予想", get_prediction_detail: "予想の詳細", get_team_snapshot: "クラブの現状", get_match_analysis: "対戦分析", get_player_stats: "選手の今季成績", get_recent_misses: "外した予想の反省", get_accuracy_summary: "的中率の実測" };
  return L[name] || name;
}

module.exports = { runToolLoop, DEFAULTS, toolLabel };
