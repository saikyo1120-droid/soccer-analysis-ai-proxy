"use strict";
/**
 * v104.2(2026年11月15日)・回答AIを 5.5 世代(claude-sonnet-5-5 / claude-opus-5-5)へ上げるための検証
 * ----------------------------------------------------------------------------
 * 公式ドキュメント(platform.claude.com/docs の models / thinking / 移行手順)の決まりを、
 * **決まりを破ると HTTP 400 を返す厳密な模擬 API** で確かめる。本物の Anthropic API は呼ばない。
 *   A. 既定モデルが 5.5 世代で、1つ前の版(5 世代)が戻り先として登録されている
 *   B. 考える分の余裕: API へ送る max_tokens = 本文の上限 + 余裕(4.x 系には足さない)
 *   C. 1往復: 先頭の thinking ブロックを読み飛ばし、複数の text ブロックを全部つなぐ
 *   D. 考える処理だけで上限を使い切った空の応答は、余裕を足して1回だけやり直す
 *   E. 新しい版の ID が無い(404)→ 1つ前の版で答え、30分は最初から1つ前の版を使う
 *   F. 新しい版だけが要求を拒む(400)→ 1つ前の版で答える。3回続いたら15分休ませる。両方が拒むなら数えない
 *   G. レート制限(429)・残高不足は版を変えずにそのまま投げる。混雑(529)は1つ前の版で答えるが休ませない
 *   H. 会話(まとめて受け取る): thinking / redacted_thinking を rawContent にそのまま残し、空白だけの text は外す
 *   I. 会話(流れる表示): thinking_delta / signature_delta で thinking を組み立て、空の text ブロックを作らない
 *   J. 道具の往復: 受け取ったまま返す・tools を変えない・仕上げは新しい1往復(道具のブロック無し)
 *   K. 道具の往復の途中で新しい版が拒んだら、その往復だけ1つ前の版で答える(記録に残る)
 *   L. /api/diag/llm が既定モデルと実績を返し、?deep=1 が5つの試験を実行する
 *   M. 本物の会話の入口(/api/discuss・/api/discuss/stream)が、本物の道具の定義のまま厳密な模擬 API を通る
 *   N. 回答の見送り(HTTP 200・stop_reason="refusal")→ 見送り用の戻り先(claude-sonnet-5)で1回だけ答え直す。
 *      分類 reasoning_extraction・本文を画面へ流したあと・戻り先自身の見送りは送り直さない。1件ずつ記録する
 *   O. 考える深さ(effort)は既定では送らない。環境変数で指定したときだけ送り、使えない値は無視し、
 *      API が指定を拒んだら指定なしで送り直す
 *   P. 実測の使用量: 応答の usage だけをモデルごとに数えて診断に出す(質問文・鍵は含めない)
 */
const http = require("http");
const assert = require("assert");
const path = require("path");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log("  ✓ " + name); } catch (e) { fail++; console.log("  ✗ " + name + " — " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e)); } };

// ---------------------------------------------------------------------------
// 厳密な模擬 Anthropic API
// ---------------------------------------------------------------------------
const KNOWN_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"]);
const state = {
  log: [],            // 受け取った要求 {model, max_tokens, stream, toolNames, messages, system}
  issued: new Map(),  // tool_use の id → { blocks(返した全ブロック), system, toolsJson, model }
  script: null,       // (body) => reply | {http, error}
  missingModels: new Set(), // 404 を返すモデル
  seq: 0,
};
const isBlank = (s) => typeof s !== "string" || !/\S/.test(s);
function violation(body) {
  if ("temperature" in body || "top_p" in body || "top_k" in body) return "temperature/top_p/top_k are not supported";
  if (body.tool_choice && (body.tool_choice.type === "any" || body.tool_choice.type === "tool")) return "tool_choice: type \"tool\" and \"any\" are not supported for this model";
  if (body.thinking && (body.thinking.type === "disabled" || body.thinking.type === "enabled") && /-5-5$/.test(body.model)) return "thinking.type is not supported for this model";
  if (body.output_config !== undefined) {
    // effort は 5 世代のモデルだけが対応(4.x 系へ送ると拒まれる)。値は決まった5つだけ
    if (!/^claude-(?:sonnet|opus)-5(?:-5)?$/.test(String(body.model))) return "output_config.effort: this model does not support the effort parameter";
    if (!body.output_config || !["low", "medium", "high", "xhigh", "max"].includes(body.output_config.effort)) return "output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'";
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (!msgs.length) return "messages: at least one message is required";
  if (msgs[msgs.length - 1].role === "assistant") return "prefill is not supported";
  let hasToolBlocks = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (typeof m.content === "string") { if (isBlank(m.content)) return `messages.${i}: text content must be non-empty`; continue; }
    if (!Array.isArray(m.content) || !m.content.length) return `messages.${i}: content must be non-empty`;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (!b || typeof b.type !== "string") return `messages.${i}.content.${j}: invalid block`;
      if (b.type === "text" && isBlank(b.text)) return `messages.${i}.content.${j}.text: text content blocks must contain non-whitespace text`;
      if (b.type === "thinking" && !(typeof b.signature === "string" && b.signature)) return `messages.${i}.content.${j}.signature: Field required`;
      if (b.type === "tool_use" || b.type === "tool_result") hasToolBlocks = true;
    }
    if (m.role === "assistant") {
      const tu = m.content.find((b) => b.type === "tool_use");
      if (tu) {
        const rec = state.issued.get(tu.id);
        if (!rec) return `messages.${i}: unknown tool_use id ${tu.id}`;
        // 決まり (a): thinking / redacted_thinking を含めて、返したままの順番・中身で戻すこと(空白だけの text は省いてよい)
        const expect = rec.blocks.filter((b) => !(b.type === "text" && isBlank(b.text)));
        const got = m.content;
        if (JSON.stringify(expect) !== JSON.stringify(got)) return `messages.${i}: thinking blocks must be passed back unmodified (expected ${expect.map((b) => b.type).join(",")} got ${got.map((b) => b.type).join(",")})`;
        // 決まり (b): thinking ブロックを出した時点から system / tools を変えないこと(同じ版のモデルに送る場合)
        const hasThinking = rec.blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking");
        if (hasThinking && rec.model === body.model) {
          if (rec.system !== String(body.system || "")) return "prefix check failed: system changed mid-conversation";
          if (rec.toolsJson !== JSON.stringify(body.tools || [])) return "prefix check failed: tools changed mid-conversation";
        }
      }
    }
  }
  if (hasToolBlocks && !(Array.isArray(body.tools) && body.tools.length)) return "tools must be defined when messages contain tool_use or tool_result blocks";
  return null;
}
function replyBlocks(reply) {
  const blocks = [];
  if (reply.redacted) blocks.push({ type: "redacted_thinking", data: "REDACTED-" + (++state.seq) });
  if (reply.thinking) blocks.push({ type: "thinking", thinking: "", signature: "SIG-" + (++state.seq) });
  if (reply.whitespaceText) blocks.push({ type: "text", text: "\n\n" });
  if (reply.preText) blocks.push({ type: "text", text: reply.preText });
  if (reply.toolUse) blocks.push({ type: "tool_use", id: "toolu_" + (++state.seq), name: reply.toolUse.name, input: reply.toolUse.input || {} });
  if (reply.text) blocks.push({ type: "text", text: reply.text });
  if (reply.text2) blocks.push({ type: "text", text: reply.text2 });
  return blocks;
}
function sseOf(blocks, stopReason, model, stopDetails) {
  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
  let out = ev("message_start", { message: { id: "msg_" + (++state.seq), model, usage: { input_tokens: 11, output_tokens: 1 } } });
  out += "event: ping\ndata: {\"type\": \"ping\"}\n\n";
  blocks.forEach((b, idx) => {
    if (b.type === "thinking") {
      out += ev("content_block_start", { index: idx, content_block: { type: "thinking", thinking: "", signature: "" } });
      out += ev("content_block_delta", { index: idx, delta: { type: "thinking_delta", thinking: "" } });
      out += ev("content_block_delta", { index: idx, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "redacted_thinking") {
      out += ev("content_block_start", { index: idx, content_block: { type: "redacted_thinking", data: b.data } });
    } else if (b.type === "tool_use") {
      out += ev("content_block_start", { index: idx, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input || {});
      const half = Math.ceil(json.length / 2);
      out += ev("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: json.slice(0, half) } });
      out += ev("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: json.slice(half) } });
    } else {
      out += ev("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
      for (let i = 0; i < b.text.length; i += 5) out += ev("content_block_delta", { index: idx, delta: { type: "text_delta", text: b.text.slice(i, i + 5) } });
    }
    out += ev("content_block_stop", { index: idx });
  });
  out += ev("message_delta", { delta: { stop_reason: stopReason, ...(stopDetails ? { stop_details: stopDetails } : {}) }, usage: { output_tokens: 23 } });
  out += ev("message_stop", {});
  return out;
}
function startStrictMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (e) { /* 壊れた要求は下で 400 */ }
        const entry = { model: body.model, max_tokens: body.max_tokens, stream: !!body.stream, toolNames: Array.isArray(body.tools) ? body.tools.map((x) => x.name) : [], messages: JSON.parse(JSON.stringify(body.messages || [])), system: String(body.system || ""), status: 200,
          effort: (body.output_config && body.output_config.effort) || null, hasOutputConfig: body.output_config !== undefined };
        state.log.push(entry);
        const sendErr = (status, type, message) => { entry.status = status; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type, message } })); };
        if (!KNOWN_MODELS.has(body.model) || state.missingModels.has(body.model)) return sendErr(404, "not_found_error", `model: ${body.model}`);
        const v = violation(body);
        if (v) return sendErr(400, "invalid_request_error", v);
        const reply = state.script ? state.script(body, entry) : { text: "OK" };
        if (reply && reply.http) return sendErr(reply.http, reply.type || "invalid_request_error", reply.error || "scripted error");
        // 回答の見送り: HTTP 200・stop_reason="refusal"・content は空(途中まで出力した場合はその出力つき)・stop_details つき
        const refusal = reply.refusal || null;
        const blocks = refusal ? (refusal.partialText ? [{ type: "text", text: refusal.partialText }] : []) : replyBlocks(reply);
        const stopReason = refusal ? "refusal" : (reply.stopReason || (reply.toolUse ? "tool_use" : "end_turn"));
        const stopDetails = refusal ? { type: "refusal", category: refusal.category === undefined ? "general_harms" : refusal.category, explanation: "This request was declined (mock)." } : null;
        if (refusal) entry.refused = true;
        const tu = blocks.find((b) => b.type === "tool_use");
        if (tu) state.issued.set(tu.id, { blocks: JSON.parse(JSON.stringify(blocks)), system: String(body.system || ""), toolsJson: JSON.stringify(body.tools || []), model: body.model });
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunks = sseOf(blocks, stopReason, body.model, stopDetails);
          const cut = Math.floor(chunks.length / 3);
          res.write(chunks.slice(0, cut));
          setTimeout(() => { res.write(chunks.slice(cut, cut * 2)); setTimeout(() => { res.write(chunks.slice(cut * 2)); res.end(); }, 8); }, 8);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_" + (++state.seq), type: "message", role: "assistant", model: body.model, content: blocks, stop_reason: stopReason, ...(stopDetails ? { stop_details: stopDetails } : {}), usage: reply.usage || { input_tokens: 12, output_tokens: 34 } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const hasToolResult = (messages) => (messages || []).some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result"));
const lastToolResult = (messages) => { for (let i = (messages || []).length - 1; i >= 0; i--) { const m = messages[i]; if (m.role === "user" && Array.isArray(m.content)) { const tr = m.content.find((b) => b && b.type === "tool_result"); if (tr) return String(tr.content || ""); } } return ""; };
const firstUserText = (messages) => { const m = (messages || [])[0]; return m ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : ""; };

(async () => {
  const mock = await startStrictMock();
  const mockPort = mock.address().port;
  process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${mockPort}/v1/messages`;
  process.env.ANTHROPIC_API_KEY = "test-key-12345678";
  delete process.env.ANTHROPIC_MODEL; delete process.env.ANTHROPIC_MODEL_HEAVY; delete process.env.ANTHROPIC_FALLBACK_MODEL; delete process.env.ANTHROPIC_PREVIOUS_FALLBACK;
  delete process.env.ANTHROPIC_THINKING_HEADROOM; delete process.env.ANTHROPIC_THINKING_HEADROOM_HEAVY; delete process.env.ANTHROPIC_THINKING_RETRY_BOOST;
  delete process.env.ANTHROPIC_EFFORT; delete process.env.ANTHROPIC_EFFORT_HEAVY; delete process.env.ANTHROPIC_REFUSAL_FALLBACK; delete process.env.ANTHROPIC_REFUSAL_FALLBACK_MODEL;
  delete process.env.ANTHROPIC_THINKING_HEADROOM_MIN;
  process.env.LLM_EMPTY_RETRY_DELAY_MS = "1";
  const SERVER_DIR = __dirname;
  const anthropic = require(path.join(SERVER_DIR, "llm/providers/anthropic.js"));
  const T = anthropic.__v1042ForTest;
  const toolLoop = require(path.join(SERVER_DIR, "discuss/toolLoop.js"));
  const llm = require(path.join(SERVER_DIR, "llm"));
  const reset = () => { state.log.length = 0; state.issued.clear(); state.script = null; state.missingModels.clear(); T.resetModelHealth(); T.setEffortForTest(null, null); };
  // 別プロセスで(環境変数を変えて)プロバイダーを動かす。模擬 API はこのプロセスにあるので、待つあいだも応答できるよう非同期で起動する
  const runChild = (code, env) => new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile(process.execPath, ["-e", code], { env: { ...process.env, ...env }, encoding: "utf-8", timeout: 20000 }, (err, stdout, stderr) => resolve({ stdout: String(stdout || "").trim(), stderr: String(stderr || ""), err }));
  });
  const ANTHROPIC_PATH = JSON.stringify(path.join(SERVER_DIR, "llm/providers/anthropic.js"));

  console.log("■ A. 既定モデルと戻り先");
  await t("既定は claude-sonnet-5-5 / claude-opus-5-5、戻り先は claude-sonnet-5 / claude-opus-5、最後の砦は claude-haiku-4-5", () => {
    assert.strictEqual(anthropic.resolveModel("light"), "claude-sonnet-5-5");
    assert.strictEqual(anthropic.resolveModel("heavy"), "claude-opus-5-5");
    const d = anthropic.diagnostics();
    assert.deepStrictEqual([d.models.previousLight, d.models.previousHeavy, d.models.lastResort, d.models.previousFallbackEnabled], ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", true]);
    assert.strictEqual(T.previousModelOf("claude-sonnet-5"), null, "1つ前の版のさらに前には戻らない");
    assert.strictEqual(d.models.refusalFallback, "claude-sonnet-5", "回答の見送り用の戻り先が登録されていない");
    assert.deepStrictEqual([d.effort.light, d.effort.heavy], [null, null], "既定で effort を指定している");
  });

  console.log("■ B. 考える分の余裕");
  await t("5 世代以降だけに余裕を足す(本文の上限の2倍・下限600・軽量は2000まで・上位は3000まで)", () => {
    assert.strictEqual(T.thinksByDefault("claude-sonnet-5-5"), true); assert.strictEqual(T.thinksByDefault("claude-opus-5"), true);
    assert.strictEqual(T.thinksByDefault("claude-haiku-4-5"), false); assert.strictEqual(T.thinksByDefault("light-model"), false);
    // 日付つきの ID(環境変数で指定された場合)も同じ扱い。4.x 系は日付つきでも足さない
    assert.strictEqual(T.thinksByDefault("claude-sonnet-5-5-20261101"), true); assert.strictEqual(T.thinksByDefault("claude-haiku-4-5-20251001"), false);
    assert.strictEqual(T.maxTokensWithThinking("claude-sonnet-5-5-20261101", 700), 700 + 1400);
    assert.strictEqual(T.maxTokensWithThinking("claude-sonnet-5-5", 260), 260 + 600);
    assert.strictEqual(T.maxTokensWithThinking("claude-sonnet-5-5", 700), 700 + 1400);
    assert.strictEqual(T.maxTokensWithThinking("claude-sonnet-5-5", 1400), 1400 + 2000);
    assert.strictEqual(T.maxTokensWithThinking("claude-opus-5-5", 1400), 1400 + 2800);
    assert.strictEqual(T.maxTokensWithThinking("claude-opus-5-5", 2000), 2000 + 3000);
    assert.strictEqual(T.maxTokensWithThinking("claude-haiku-4-5", 700), 700);
    assert.strictEqual(T.maxTokensWithThinking("claude-sonnet-5-5", 700, 4000), 700 + 1400 + 4000);
  });
  await t("実際に API へ送る max_tokens に余裕が入っている(1往復・会話とも)", async () => {
    reset();
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 260 });
    await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 900, tier: "heavy" });
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.max_tokens]), [["claude-sonnet-5-5", 860], ["claude-opus-5-5", 2700]]);
  });

  console.log("■ C. 1往復の応答の読み方");
  await t("先頭の thinking ブロックを読み飛ばし、複数の text ブロックを全部つなぐ", async () => {
    reset();
    state.script = () => ({ thinking: true, text: "前半。", text2: "後半。" });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.text, "前半。後半。"); assert.strictEqual(r.model, "claude-sonnet-5-5"); assert.strictEqual(r.fallbackFrom, undefined); assert.strictEqual(r.truncated, false);
  });

  console.log("■ D. 考える処理だけで上限を使い切った空の応答");
  await t("stop_reason=max_tokens で本文が空 → 余裕を足して1回だけやり直して答える", async () => {
    reset();
    let n = 0;
    state.script = () => (++n === 1 ? { thinking: true, stopReason: "max_tokens" } : { thinking: true, text: "やり直しで答えました" });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 260 });
    assert.strictEqual(r.text, "やり直しで答えました");
    assert.deepStrictEqual(state.log.map((x) => x.max_tokens), [860, 4860]);
    assert.strictEqual(anthropic.diagnostics().stats.thinkingExhaustedRetries, 1);
  });
  await t("やり直しても空なら EMPTY_RESPONSE(停止理由つき)を投げる。停止理由が max_tokens 以外の空は、上限を足したやり直しをしない", async () => {
    reset();
    state.script = () => ({ thinking: true, stopReason: "max_tokens" });
    let e1 = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 260 }); } catch (e) { e1 = e; }
    assert.ok(e1 && e1.code === "EMPTY_RESPONSE" && /stop_reason=max_tokens/.test(e1.message) && /blocks=thinking/.test(e1.message), e1 && e1.message);
    assert.strictEqual(state.log.length, 2);
    reset();
    state.script = () => ({ thinking: true, stopReason: "end_turn" });
    let e2 = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 260 }); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.code === "EMPTY_RESPONSE" && e2.stopReason === "end_turn" && !e2.refusal, e2 && e2.message);
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.max_tokens]), [["claude-sonnet-5-5", 860]], "上限と関係ない空の応答をやり直している");
  });
  await t("会話でも同じ(本文も道具の呼び出しも無い空の応答 → 余裕を足して1回だけやり直す)", async () => {
    reset();
    let n = 0;
    state.script = () => (++n === 1 ? { thinking: true, stopReason: "max_tokens" } : { thinking: true, text: "会話のやり直し" });
    const deltas = [];
    const r = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 700, stream: true, onDelta: (x) => deltas.push(x) });
    assert.strictEqual(r.text, "会話のやり直し"); assert.strictEqual(deltas.join(""), "会話のやり直し");
    assert.deepStrictEqual(state.log.map((x) => x.max_tokens), [2100, 6100]);
  });

  console.log("■ E. 新しい版の ID が無いとき");
  await t("404(model not found)→ 1つ前の版で答え、fallbackFrom / fallbackReason を開示する", async () => {
    reset();
    state.missingModels.add("claude-sonnet-5-5");
    state.script = (b) => ({ text: "答え[" + b.model + "]" });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.text, "答え[claude-sonnet-5]"); assert.strictEqual(r.model, "claude-sonnet-5");
    assert.strictEqual(r.fallbackFrom, "claude-sonnet-5-5"); assert.strictEqual(r.fallbackReason, "model_not_found");
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.status]), [["claude-sonnet-5-5", 404], ["claude-sonnet-5", 200]]);
  });
  await t("その後30分は最初から1つ前の版を使う(毎回の失敗ぶんの待ち時間を払わせない)。上位モデルには影響しない", async () => {
    state.log.length = 0;
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.deepStrictEqual(state.log.map((x) => x.model), ["claude-sonnet-5"]);
    assert.strictEqual(r.fallbackFrom, "claude-sonnet-5-5"); assert.ok(/^cooldown:/.test(r.fallbackReason), r.fallbackReason);
    const h = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300, tier: "heavy" });
    assert.strictEqual(h.model, "claude-opus-5-5"); assert.strictEqual(h.fallbackFrom, undefined);
    const d = anthropic.diagnostics();
    assert.ok(d.health["claude-sonnet-5-5"].restingUntil, JSON.stringify(d.health)); assert.strictEqual(d.stats.previousUsed, 2); assert.ok(d.stats.lastFallbacks.length >= 2);
    assert.ok(!JSON.stringify(d).includes("test-key-12345678"), "診断に鍵が含まれている");
  });
  await t("新しい版も1つ前の版も無いときだけ、最後の砦(claude-haiku-4-5)で答える", async () => {
    reset();
    state.missingModels.add("claude-sonnet-5-5"); state.missingModels.add("claude-sonnet-5");
    state.script = (b) => ({ text: "砦[" + b.model + "]" });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.model, "claude-haiku-4-5"); assert.strictEqual(r.fallbackFrom, "claude-sonnet-5-5"); assert.strictEqual(r.fallbackReason, "model_not_found");
    assert.strictEqual(state.log[2].max_tokens, 300, "4.x 系には余裕を足さない");
  });

  console.log("■ F. 新しい版だけが要求を拒むとき");
  await t("400 → 1つ前の版で答える。3回続いたら15分休ませ、新しい版が通れば連続回数は戻る", async () => {
    reset();
    let reject55 = true;
    state.script = (b) => (/-5-5$/.test(b.model) && reject55 ? { http: 400, error: "some new rule of this model" } : { text: "答え[" + b.model + "]" });
    for (let i = 0; i < 2; i++) { const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 }); assert.strictEqual(r.model, "claude-sonnet-5"); assert.strictEqual(r.fallbackReason, "http_400"); }
    assert.strictEqual(anthropic.diagnostics().health["claude-sonnet-5-5"].rejectStreak, 2);
    reject55 = false;
    const ok = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(ok.model, "claude-sonnet-5-5"); assert.strictEqual(anthropic.diagnostics().health["claude-sonnet-5-5"].rejectStreak, 0);
    reject55 = true;
    for (let i = 0; i < 3; i++) await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.ok(anthropic.diagnostics().health["claude-sonnet-5-5"].restingUntil, "3回続いたのに休ませていない");
    state.log.length = 0;
    const r4 = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.deepStrictEqual(state.log.map((x) => x.model), ["claude-sonnet-5"]); assert.strictEqual(r4.model, "claude-sonnet-5");
  });
  await t("1つ前の版も同じく拒むなら、版のせいではないので数えず、最初(新しい版)のエラー文を添えて投げる", async () => {
    reset();
    state.script = () => ({ http: 400, error: "messages: something is wrong with the request itself" });
    let err = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 }); } catch (e) { err = e; }
    assert.ok(err && err.code === "HTTP_ERROR" && err.httpStatus === 400, err && err.message);
    assert.ok(/HTTP 400/.test(err.primaryModelError || ""), err.primaryModelError);
    assert.strictEqual(state.log.length, 2);
    const h = anthropic.diagnostics().health["claude-sonnet-5-5"];
    assert.ok(!h || (h.rejectStreak === 0 && !h.restingUntil), JSON.stringify(h));
  });
  await t("ANTHROPIC_PREVIOUS_FALLBACK=off なら戻らない(別プロセスで確認)", async () => {
    const { spawnSync } = require("child_process");
    const code = `process.env.ANTHROPIC_PREVIOUS_FALLBACK="off"; const a=require(${JSON.stringify(path.join(SERVER_DIR, "llm/providers/anthropic.js"))}); const d=a.diagnostics().models; console.log(JSON.stringify([d.previousLight,d.previousHeavy,d.previousFallbackEnabled,a.resolveModel("light")]));`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env }, encoding: "utf-8" });
    assert.strictEqual(r.stdout.trim(), JSON.stringify([null, null, false, "claude-sonnet-5-5"]), r.stdout + r.stderr);
  });

  console.log("■ G. 版を変えても同じ失敗は、そのまま投げる");
  await t("429(レート制限)・残高不足(400)は1つ前の版へ送り直さない。529(混雑)は送り直すが休ませない", async () => {
    reset();
    state.script = () => ({ http: 429, type: "rate_limit_error", error: "rate limited" });
    let e1 = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u" }); } catch (e) { e1 = e; }
    assert.ok(e1 && e1.httpStatus === 429); assert.strictEqual(state.log.length, 1);
    reset();
    state.script = () => ({ http: 400, error: "Your credit balance is too low to access the Anthropic API." });
    let e2 = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u" }); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.httpStatus === 400 && /credit balance/.test(e2.message)); assert.strictEqual(state.log.length, 1);
    reset();
    state.script = (b) => (/-5-5$/.test(b.model) ? { http: 529, type: "overloaded_error", error: "Overloaded" } : { text: "混雑時の答え" });
    for (let i = 0; i < 4; i++) { const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u" }); assert.strictEqual(r.model, "claude-sonnet-5"); assert.strictEqual(r.fallbackReason, "http_529"); }
    assert.strictEqual(state.log.filter((x) => x.model === "claude-sonnet-5-5").length, 4, "混雑なのに新しい版を休ませている");
    assert.strictEqual(anthropic.diagnostics().health["claude-sonnet-5-5"].restingUntil, null);
  });

  console.log("■ H. 会話(まとめて受け取る)のブロックの扱い");
  await t("content は text と tool_use だけ。rawContent は thinking / redacted_thinking を受け取ったまま残し、空白だけの text は外す", async () => {
    reset();
    state.script = () => ({ redacted: true, thinking: true, whitespaceText: true, toolUse: { name: "get_x", input: { a: 1 } } });
    const r = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "get_x", description: "d", input_schema: { type: "object", properties: {} } }], maxTokens: 500 });
    assert.deepStrictEqual(r.content.map((b) => b.type), ["text", "tool_use"]);
    assert.deepStrictEqual(r.rawContent.map((b) => b.type), ["redacted_thinking", "thinking", "tool_use"]);
    assert.ok(/^SIG-/.test(r.rawContent[1].signature) && r.rawContent[1].thinking === "" && /^REDACTED-/.test(r.rawContent[0].data));
    assert.strictEqual(r.stopReason, "tool_use"); assert.deepStrictEqual(r.content[1].input, { a: 1 });
  });

  console.log("■ I. 会話(流れる表示)のブロックの扱い");
  await t("thinking_delta / signature_delta で thinking を組み立て、本文の断片だけを流し、空の text ブロックを作らない", async () => {
    reset();
    state.script = () => ({ redacted: true, thinking: true, preText: "確認します。", toolUse: { name: "get_x", input: { team: "アーセナル" } } });
    const deltas = [];
    const r = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "get_x", description: "d", input_schema: { type: "object", properties: {} } }], maxTokens: 500, stream: true, onDelta: (x) => deltas.push(x) });
    assert.strictEqual(deltas.join(""), "確認します。");
    assert.deepStrictEqual(r.content.map((b) => b.type), ["text", "tool_use"]);
    assert.deepStrictEqual(r.rawContent.map((b) => b.type), ["redacted_thinking", "thinking", "text", "tool_use"]);
    const th = r.rawContent[1];
    assert.ok(/^SIG-/.test(th.signature) && th.thinking === "", JSON.stringify(th));
    assert.deepStrictEqual(r.rawContent[3].input, { team: "アーセナル" });
    assert.ok(r.rawContent.every((b) => b.type !== "text" || /\S/.test(b.text)), "空の text ブロックがある");
    assert.strictEqual(r.usage.output_tokens, 23);
  });
  await t("thinking だけ → 本文、の応答でも text は本文だけ(以前は thinking が空の text ブロックに化けていた)", async () => {
    reset();
    state.script = () => ({ thinking: true, text: "本文です" });
    const r = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 500, stream: true });
    assert.strictEqual(r.text, "本文です"); assert.deepStrictEqual(r.content, [{ type: "text", text: "本文です" }]);
    assert.deepStrictEqual(r.rawContent.map((b) => b.type), ["thinking", "text"]);
  });

  console.log("■ J. 道具の往復(厳密な模擬 API が決まり違反を 400 で拒む)");
  const TOOLS = [{ name: "get_check_code", description: "確認コードを返す", input_schema: { type: "object", properties: {}, additionalProperties: false } }];
  const loopScript = (body) => {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.length && !hasToolResult(body.messages)) return { redacted: true, thinking: true, whitespaceText: true, preText: "確認します。", toolUse: { name: "get_check_code", input: {} } };
    if (hasToolResult(body.messages)) { const m = lastToolResult(body.messages).match(/"code":(\d+)/); return { thinking: true, text: `確認コード: ${m ? m[1] : "?"}` }; }
    const m2 = firstUserText(body.messages).match(/"code":(\d+)/);
    return { thinking: true, text: `仕上げ[${body.model}] 確認コード: ${m2 ? m2[1] : "取得できません"}` };
  };
  const runLoop = (extra) => toolLoop.runToolLoop({
    systemPrompt: "SYS", userContent: "確認コードを教えて", tools: TOOLS,
    execute: async () => ({ ok: true, resultJson: JSON.stringify({ ok: true, code: 4321 }), summaryJa: "x", elapsedMs: 1 }),
    generateConversation: llm.generateConversation, tier: "light", maxTokens: 300, ...extra,
  });
  for (const stream of [false, true]) {
    await t(`${stream ? "流れる表示" : "まとめて受け取る"}: 受け取ったまま返すので拒まれず、道具の結果が最終回答に入る`, async () => {
      reset(); state.script = loopScript;
      const events = [];
      const r = await runLoop({ stream, emit: (e) => events.push(e) });
      assert.strictEqual(r.text, "確認コード: 4321"); assert.strictEqual(r.calls, 1); assert.strictEqual(r.rounds, 2);
      assert.ok(state.log.every((x) => x.status === 200), JSON.stringify(state.log.map((x) => x.status)));
      const echoed = state.log[1].messages[1];
      assert.strictEqual(echoed.role, "assistant");
      assert.deepStrictEqual(echoed.content.map((b) => b.type), ["redacted_thinking", "thinking", "text", "tool_use"]);
      assert.deepStrictEqual(state.log.map((x) => x.toolNames.join(",")), ["get_check_code", "get_check_code"], "往復の途中で tools が変わっている");
      assert.deepStrictEqual(r.modelFallbacks, []);
      if (stream) assert.ok(events.some((e) => e.t === "reset") && events.filter((e) => e.t === "delta").map((e) => e.text).join("").endsWith("確認コード: 4321"));
    });
  }
  await t("模擬 API は、以前の返し方(text と tool_use だけに作り直す)を実際に拒む(=この試験が決まりを見張っている)", async () => {
    reset(); state.script = loopScript;
    const first = await anthropic.generateMessages({ systemPrompt: "SYS", messages: [{ role: "user", content: "q" }], tools: TOOLS, maxTokens: 300 });
    const oldStyle = [{ role: "user", content: "q" }, { role: "assistant", content: first.content.filter((b) => b.type !== "text" || /\S/.test(b.text)) }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content.find((b) => b.type === "tool_use").id, content: "{}" }] }];
    let err = null; try { await anthropic.generateMessages({ systemPrompt: "SYS", messages: oldStyle, tools: TOOLS, maxTokens: 300 }); } catch (e) { err = e; }
    assert.ok(err && err.httpStatus === 400 && /passed back unmodified/.test(err.primaryModelError || err.message), err && (err.primaryModelError || err.message));
    // tools を外して同じ会話を続ける形も拒まれる
    reset(); state.script = loopScript;
    const f2 = await anthropic.generateMessages({ systemPrompt: "SYS", messages: [{ role: "user", content: "q" }], tools: TOOLS, maxTokens: 300 });
    const cont = [{ role: "user", content: "q" }, { role: "assistant", content: f2.rawContent }, { role: "user", content: [{ type: "tool_result", tool_use_id: f2.content.find((b) => b.type === "tool_use").id, content: "{}" }] }];
    let err2 = null; try { await anthropic.generateMessages({ systemPrompt: "SYS", messages: cont, tools: [], maxTokens: 300 }); } catch (e) { err2 = e; }
    assert.ok(err2 && err2.httpStatus === 400 && /prefix check failed: tools changed|tools must be defined/.test(err2.primaryModelError || err2.message), err2 && (err2.primaryModelError || err2.message));
  });
  await t("上位モデルの仕上げは「新しい1往復」(道具のブロック無し・tools 無し)。質問・道具の結果・下書きが文章で渡る", async () => {
    reset(); state.script = loopScript;
    const r = await runLoop({ finalTier: "heavy", finalMaxTokens: 400, finalInstruction: "仕上げてください" });
    assert.strictEqual(r.text, "仕上げ[claude-opus-5-5] 確認コード: 4321"); assert.strictEqual(r.model, "claude-opus-5-5");
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.toolNames.length, x.messages.length, x.status]), [["claude-sonnet-5-5", 1, 1, 200], ["claude-sonnet-5-5", 1, 3, 200], ["claude-opus-5-5", 0, 1, 200]]);
    const fresh = state.log[2].messages[0].content;
    assert.ok(typeof fresh === "string" && fresh.startsWith("確認コードを教えて") && fresh.includes('"code":4321') && fresh.includes("下書き") && fresh.includes("確認コード: 4321") && fresh.trim().endsWith("仕上げてください"), fresh);
    assert.strictEqual(state.log[2].max_tokens, 400 + 800);
    assert.ok(r.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")), "数字の裏取り用の道具の結果が messages に残っていない");
  });
  await t("道具を呼び続ける回答AIは上限で打ち切り、新しい1往復で最終回答を書かせる(exhausted を開示・呼び出しは上限+1回)", async () => {
    reset();
    state.script = (body) => ((Array.isArray(body.tools) && body.tools.length) ? { thinking: true, toolUse: { name: "get_check_code", input: {} } } : { text: "打ち切り後の答え " + (/上限に達しました/.test(firstUserText(body.messages)) ? "(上限の説明あり)" : "") });
    const r = await runLoop({ maxRounds: 2, maxCalls: 5 });
    assert.strictEqual(r.exhausted, true); assert.strictEqual(r.rounds, 3); assert.strictEqual(r.calls, 2);
    assert.strictEqual(r.text, "打ち切り後の答え (上限の説明あり)");
    assert.deepStrictEqual(state.log.map((x) => [x.toolNames.length, x.messages.length, x.status]), [[1, 1, 200], [1, 3, 200], [0, 1, 200]]);
  });
  await t("打ち切り+上位モデルの仕上げは1往復にまとめる(以前は2回呼んでいた)", async () => {
    reset();
    state.script = (body) => ((Array.isArray(body.tools) && body.tools.length) ? { toolUse: { name: "get_check_code", input: {} } } : { text: "まとめ[" + body.model + "]" });
    const r = await runLoop({ maxRounds: 1, finalTier: "heavy" });
    assert.strictEqual(r.text, "まとめ[claude-opus-5-5]"); assert.strictEqual(r.exhausted, true);
    assert.deepStrictEqual(state.log.map((x) => x.model), ["claude-sonnet-5-5", "claude-opus-5-5"]);
    assert.ok(!state.log[1].messages[0].content.includes("下書き"), "打ち切りのときは下書きを渡さない");
  });
  await t("道具が空の結果を返しても、空の tool_result を送らない", async () => {
    reset(); state.script = loopScript;
    const r = await toolLoop.runToolLoop({ systemPrompt: "SYS", userContent: "q", tools: TOOLS, execute: async () => ({ ok: false, resultJson: "" }), generateConversation: llm.generateConversation, maxTokens: 300 });
    assert.strictEqual(r.text, "確認コード: ?");
    assert.strictEqual(state.log[1].messages[2].content[0].content, "{}");
  });

  console.log("■ K. 道具の往復の途中で新しい版が拒んだとき");
  await t("2往復目を新しい版が 400 で拒む → その往復だけ1つ前の版が答え、modelFallbacks に残る", async () => {
    reset();
    state.script = (body) => {
      if (/-5-5$/.test(body.model) && hasToolResult(body.messages)) return { http: 400, error: "unexpected rule on tool results (mock)" };
      return loopScript(body);
    };
    const r = await runLoop({});
    assert.strictEqual(r.text, "確認コード: 4321"); assert.strictEqual(r.model, "claude-sonnet-5");
    assert.deepStrictEqual(r.modelFallbacks, [{ from: "claude-sonnet-5-5", to: "claude-sonnet-5", reason: "http_400" }]);
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.status]), [["claude-sonnet-5-5", 200], ["claude-sonnet-5-5", 400], ["claude-sonnet-5", 200]]);
  });

  console.log("■ N. 回答の見送り(HTTP 200・stop_reason=\"refusal\")");
  const refuseOn55 = (extra) => (body) => (/-5-5$/.test(body.model) ? { refusal: { ...(extra || {}) } } : { thinking: true, text: "答え[" + body.model + "]" });
  await t("新しい版が見送る → 見送り用の戻り先(claude-sonnet-5)が答え、fallbackReason=\"refusal\" を開示する。モデルは休ませない", async () => {
    reset(); state.script = refuseOn55();
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.text, "答え[claude-sonnet-5]"); assert.strictEqual(r.model, "claude-sonnet-5");
    assert.strictEqual(r.fallbackFrom, "claude-sonnet-5-5"); assert.strictEqual(r.fallbackReason, "refusal");
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.status, !!x.refused]), [["claude-sonnet-5-5", 200, true], ["claude-sonnet-5", 200, false]]);
    const d = anthropic.diagnostics();
    assert.deepStrictEqual([d.stats.refusals, d.stats.refusalsAnswered], [1, 1]);
    const rec = d.stats.lastRefusals[0];
    assert.deepStrictEqual([rec.model, rec.category, rec.answeredBy, rec.note, rec.partialOutput], ["claude-sonnet-5-5", "general_harms", "claude-sonnet-5", null, false]);
    assert.ok(d.stats.lastFallbacks.some((f) => f.reason === "refusal" && f.to === "claude-sonnet-5"));
    const h = d.health["claude-sonnet-5-5"];
    assert.ok(!h || (h.rejectStreak === 0 && !h.restingUntil), "見送りをモデルの不調として数えている: " + JSON.stringify(h));
    // 見送りが続いても休ませない(版が使えないのではなく、その要求の内容の問題だから)。次の要求も新しい版から試す
    for (let i = 0; i < 4; i++) await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(state.log.filter((x) => x.model === "claude-sonnet-5-5").length, 5);
    assert.strictEqual(anthropic.diagnostics().stats.previousUsed, 0, "見送りを「1つ前の版へ戻った回数」に数えている");
  });
  await t("上位モデル(claude-opus-5-5)の見送りは、同じ分類器を持つ claude-opus-5 を飛ばして claude-sonnet-5 へ", async () => {
    reset(); state.script = refuseOn55();
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300, tier: "heavy" });
    assert.strictEqual(r.model, "claude-sonnet-5"); assert.strictEqual(r.fallbackFrom, "claude-opus-5-5"); assert.strictEqual(r.fallbackReason, "refusal");
    assert.deepStrictEqual(state.log.map((x) => x.model), ["claude-opus-5-5", "claude-sonnet-5"]);
  });
  await t("分類が null でも送り直す(判定は stop_reason)。分類 reasoning_extraction は送り直さない(公式: 文面を直す)", async () => {
    reset(); state.script = refuseOn55({ category: null });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.model, "claude-sonnet-5"); assert.strictEqual(anthropic.diagnostics().stats.lastRefusals[0].category, null);
    reset(); state.script = refuseOn55({ category: "reasoning_extraction" });
    let err = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 }); } catch (e) { err = e; }
    assert.ok(err && err.code === "EMPTY_RESPONSE" && err.stopReason === "refusal" && err.refusal.category === "reasoning_extraction" && /category=reasoning_extraction/.test(err.message), err && err.message);
    assert.strictEqual(state.log.length, 1, "送り直してはいけない分類を送り直している");
    const d = anthropic.diagnostics();
    assert.deepStrictEqual([d.stats.refusals, d.stats.refusalsAnswered, d.stats.lastRefusals[0].note], [1, 0, "category_not_retryable"]);
  });
  await t("戻り先のモデルも見送ったら、最初の見送りのエラー(EMPTY_RESPONSE・stopReason=refusal)を投げる。3つ目のモデルへは送らない", async () => {
    reset(); state.script = () => ({ refusal: { category: "general_harms" } });
    let err = null; try { await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 }); } catch (e) { err = e; }
    assert.ok(err && err.code === "EMPTY_RESPONSE" && err.stopReason === "refusal" && /model=claude-sonnet-5-5/.test(err.message), err && err.message);
    assert.ok(/refusal/.test(err.refusalFallbackError || ""), err.refusalFallbackError);
    assert.deepStrictEqual(state.log.map((x) => x.model), ["claude-sonnet-5-5", "claude-sonnet-5"]);
    const d = anthropic.diagnostics();
    assert.deepStrictEqual([d.stats.refusals, d.stats.refusalsAnswered, d.stats.lastRefusals[0].note], [1, 0, "fallback_failed:refusal"]);
  });
  await t("途中まで出力してからの見送り(まとめて受け取る): 途中の文は未完成として捨て、戻り先の答えだけを返す", async () => {
    reset(); state.script = refuseOn55({ partialText: "途中まで書いた文" });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.text, "答え[claude-sonnet-5]");
    const m = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 300 });
    assert.strictEqual(m.text, "答え[claude-sonnet-5]"); assert.strictEqual(m.fallbackReason, "refusal");
    assert.ok(!JSON.stringify(m.rawContent).includes("途中まで"), "捨てるべき途中の文が残っている");
  });
  await t("流れる表示: 本文が流れる前の見送りは戻り先が答え、画面には戻り先の文だけが流れる", async () => {
    reset(); state.script = refuseOn55();
    const deltas = [];
    const r = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 300, stream: true, onDelta: (x) => deltas.push(x) });
    assert.strictEqual(r.text, "答え[claude-sonnet-5]"); assert.strictEqual(deltas.join(""), "答え[claude-sonnet-5]");
    assert.strictEqual(r.fallbackFrom, "claude-sonnet-5-5"); assert.strictEqual(r.fallbackReason, "refusal");
    assert.strictEqual(anthropic.diagnostics().stats.lastRefusals[0].category, "general_harms", "流れる表示で stop_details を読めていない");
  });
  await t("流れる表示: 本文を画面へ流したあとの見送りは、ここでは送り直さない(呼び出し側が画面を消してからやり直す)", async () => {
    reset(); state.script = refuseOn55({ partialText: "途中まで流れた文" });
    const deltas = [];
    let err = null;
    try { await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 300, stream: true, onDelta: (x) => deltas.push(x) }); } catch (e) { err = e; }
    assert.ok(err && err.code === "EMPTY_RESPONSE" && err.stopReason === "refusal" && err.partialStreamed === true, err && err.message);
    assert.strictEqual(deltas.join(""), "途中まで流れた文"); assert.strictEqual(state.log.length, 1);
    assert.strictEqual(anthropic.diagnostics().stats.lastRefusals[0].note, "partial_text_already_shown");
    // 画面へ流していない(onDelta なし)なら、途中の出力があっても送り直してよい
    reset(); state.script = refuseOn55({ partialText: "途中まで" });
    const r = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 300, stream: true });
    assert.strictEqual(r.text, "答え[claude-sonnet-5]");
  });
  await t("道具の往復の途中で見送られたら、その往復だけ戻り先が答える(考えた跡つきの会話をそのまま渡す・記録に残る)", async () => {
    reset();
    state.script = (body) => { if (/-5-5$/.test(body.model) && hasToolResult(body.messages)) return { refusal: { category: "general_harms" } }; return loopScript(body); };
    for (const stream of [false, true]) {
      state.log.length = 0; state.issued.clear(); T.resetModelHealth();
      const events = [];
      const r = await runLoop({ stream, emit: (e) => events.push(e) });
      assert.strictEqual(r.text, "確認コード: 4321"); assert.strictEqual(r.model, "claude-sonnet-5");
      assert.deepStrictEqual(r.modelFallbacks, [{ from: "claude-sonnet-5-5", to: "claude-sonnet-5", reason: "refusal" }]);
      assert.deepStrictEqual(state.log.map((x) => [x.model, x.status, !!x.refused]), [["claude-sonnet-5-5", 200, false], ["claude-sonnet-5-5", 200, true], ["claude-sonnet-5", 200, false]]);
      assert.deepStrictEqual(state.log[2].messages[1].content.map((b) => b.type), ["redacted_thinking", "thinking", "text", "tool_use"], "戻り先へ渡す会話を作り直している");
    }
  });
  await t("ANTHROPIC_REFUSAL_FALLBACK=off なら送り直さない / 戻り先は ANTHROPIC_REFUSAL_FALLBACK_MODEL で変えられる(別プロセスで確認)", async () => {
    reset(); state.script = refuseOn55();
    const code = `const a=require(${ANTHROPIC_PATH}); a.generate({systemPrompt:"s",userPrompt:"u",maxTokens:300}).then((r)=>console.log(JSON.stringify({model:r.model,reason:r.fallbackReason,fb:a.diagnostics().models.refusalFallback})),(e)=>console.log(JSON.stringify({err:e.code,stop:e.stopReason,fb:a.diagnostics().models.refusalFallback,note:a.diagnostics().stats.lastRefusals[0].note})));`;
    const off = await runChild(code, { ANTHROPIC_REFUSAL_FALLBACK: "off" });
    assert.strictEqual(off.stdout, JSON.stringify({ err: "EMPTY_RESPONSE", stop: "refusal", fb: null, note: "fallback_off" }), off.stdout + off.stderr);
    assert.deepStrictEqual(state.log.map((x) => x.model), ["claude-sonnet-5-5"]);
    state.log.length = 0;
    const other = await runChild(code, { ANTHROPIC_REFUSAL_FALLBACK_MODEL: "claude-haiku-4-5" });
    assert.strictEqual(other.stdout, JSON.stringify({ model: "claude-haiku-4-5", reason: "refusal", fb: "claude-haiku-4-5" }), other.stdout + other.stderr);
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.max_tokens]), [["claude-sonnet-5-5", 900], ["claude-haiku-4-5", 300]]);
  });

  console.log("■ O. 考える深さ(effort)の任意設定");
  await t("設定の読み方: low / medium / high だけを受け付け、xhigh / max / 打ち間違いは無視する(既定は指定なし)", () => {
    assert.deepStrictEqual(T.parseEffortLevel(" Medium "), { value: "medium", ignored: null });
    assert.deepStrictEqual(T.parseEffortLevel("low"), { value: "low", ignored: null });
    assert.deepStrictEqual(T.parseEffortLevel("HIGH"), { value: "high", ignored: null });
    assert.deepStrictEqual(T.parseEffortLevel(""), { value: null, ignored: null });
    assert.deepStrictEqual(T.parseEffortLevel(undefined), { value: null, ignored: null });
    for (const bad of ["xhigh", "max", "midium", "1"]) assert.deepStrictEqual(T.parseEffortLevel(bad), { value: null, ignored: bad });
  });
  await t("既定では output_config を1度も送らない(1往復・会話・流れる表示・道具の往復)", async () => {
    reset(); state.script = loopScript;
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300, tier: "heavy" });
    await runLoop({ stream: true, emit: () => {} });
    assert.ok(state.log.length >= 4 && state.log.every((x) => x.hasOutputConfig === false), JSON.stringify(state.log.map((x) => [x.model, x.hasOutputConfig])));
  });
  await t("指定したときだけ送る: 軽量と上位で別々・1つ前の版にも同じ指定・4.x 系(最後の砦)には送らない", async () => {
    reset(); T.setEffortForTest("medium", "high"); state.script = loopScript;
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300, tier: "heavy" });
    await runLoop({ stream: true, emit: () => {}, finalTier: "heavy" });
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.effort, x.status]), [
      ["claude-sonnet-5-5", "medium", 200], ["claude-opus-5-5", "high", 200],
      ["claude-sonnet-5-5", "medium", 200], ["claude-sonnet-5-5", "medium", 200], ["claude-opus-5-5", "high", 200],
    ]);
    const d = anthropic.diagnostics();
    assert.deepStrictEqual([d.effort.light, d.effort.heavy, Object.keys(d.effort.rejectedByApi).length], ["medium", "high", 0]);
    // 新しい版も1つ前の版も無い → 最後の砦(4.x 系)へは effort を付けない(付けると模擬 API が 400 で拒む)
    state.log.length = 0; T.resetModelHealth();
    state.missingModels.add("claude-sonnet-5-5");
    const r1 = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r1.model, "claude-sonnet-5");
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.effort]), [["claude-sonnet-5-5", "medium"], ["claude-sonnet-5", "medium"]]);
    state.log.length = 0; T.resetModelHealth(); state.missingModels.add("claude-sonnet-5");
    const r2 = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r2.model, "claude-haiku-4-5");
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.hasOutputConfig, x.status]), [["claude-sonnet-5-5", true, 404], ["claude-sonnet-5", true, 404], ["claude-haiku-4-5", false, 200]]);
  });
  await t("API が effort の指定を拒んだら(400)、同じモデルへ指定なしで1回だけ送り直し、以後そのモデルには送らない(版は切り替えない)", async () => {
    reset(); T.setEffortForTest("low", null);
    state.script = (body, entry) => (entry.hasOutputConfig ? { http: 400, error: "output_config.effort: Extra inputs are not permitted" } : { thinking: true, text: "答え[" + body.model + "]" });
    const r = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    assert.strictEqual(r.model, "claude-sonnet-5-5"); assert.strictEqual(r.fallbackFrom, undefined);
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.effort, x.status]), [["claude-sonnet-5-5", "low", 400], ["claude-sonnet-5-5", null, 200]]);
    const deltas = [];
    const m = await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 300, stream: true, onDelta: (x) => deltas.push(x) });
    assert.strictEqual(m.model, "claude-sonnet-5-5"); assert.strictEqual(deltas.join(""), "答え[claude-sonnet-5-5]");
    assert.strictEqual(state.log.length, 3, "拒まれたあとも effort を送り続けている");
    assert.strictEqual(state.log[2].hasOutputConfig, false);
    const d = anthropic.diagnostics();
    assert.ok(d.effort.rejectedByApi["claude-sonnet-5-5"] && d.effort.rejectedByApi["claude-sonnet-5-5"].effort === "low", JSON.stringify(d.effort));
    const h = d.health["claude-sonnet-5-5"];
    assert.ok(!h || (h.rejectStreak === 0 && !h.restingUntil), "effort の拒否をモデルの不調として数えている");
    assert.strictEqual(d.stats.previousUsed, 0);
  });
  await t("環境変数からの指定(別プロセス): ANTHROPIC_EFFORT=low は送られ、使えない値(ANTHROPIC_EFFORT_HEAVY=max)は無視して既定のまま動く", async () => {
    reset(); state.script = (body) => ({ thinking: true, text: "答え[" + body.model + "]" });
    const code = `const a=require(${ANTHROPIC_PATH}); (async()=>{ const l=await a.generate({systemPrompt:"s",userPrompt:"u",maxTokens:300}); const h=await a.generate({systemPrompt:"s",userPrompt:"u",maxTokens:300,tier:"heavy"}); const d=a.diagnostics().effort; console.log(JSON.stringify([l.model,h.model,d.light,d.heavy,d.ignored.heavy])); })().catch((e)=>console.log("ERR "+e.message));`;
    const out = await runChild(code, { ANTHROPIC_EFFORT: "low", ANTHROPIC_EFFORT_HEAVY: "max" });
    assert.strictEqual(out.stdout, JSON.stringify(["claude-sonnet-5-5", "claude-opus-5-5", "low", null, "max"]), out.stdout + out.stderr);
    assert.ok(/ANTHROPIC_EFFORT_HEAVY="max" は使えない値/.test(out.stderr), "無視したことをログに残していない: " + out.stderr.slice(0, 200));
    assert.deepStrictEqual(state.log.map((x) => [x.model, x.effort, x.hasOutputConfig, x.status]), [["claude-sonnet-5-5", "low", true, 200], ["claude-opus-5-5", null, false, 200]]);
  });
  T.setEffortForTest(null, null);

  console.log("■ P. 実測の使用量(応答の usage だけを数える)");
  await t("モデルごとに 回数・合計・1回の最大・上限に達した数・見送りの数 を数える(質問文や鍵は含まない)", async () => {
    reset();
    let n = 0;
    state.script = () => { n++; if (n === 2) return { thinking: true, text: "長い答え", usage: { input_tokens: 100, output_tokens: 900 } }; if (n === 3) return { thinking: true, text: "切れた答え", stopReason: "max_tokens" }; return { thinking: true, text: "答え" }; };
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300 });
    const cut = await anthropic.generate({ systemPrompt: "s", userPrompt: "u", maxTokens: 300, truncateRetry: false });
    assert.strictEqual(cut.truncated, true);
    await anthropic.generateMessages({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], maxTokens: 300, stream: true });
    const u = anthropic.diagnostics().usage;
    assert.ok(!Number.isNaN(Date.parse(u.since)), u.since);
    assert.deepStrictEqual(u.byModel["claude-sonnet-5-5"], {
      calls: 4, withUsage: 4, inputTokens: 12 + 100 + 12 + 11, outputTokens: 34 + 900 + 34 + 23, maxOutputTokens: 900, hitMaxTokens: 1, refusals: 0,
      avgOutputTokens: Math.round((34 + 900 + 34 + 23) / 4),
    });
    // 見送った応答と、戻り先のモデルの応答は、それぞれのモデルに数える
    reset(); state.script = refuseOn55();
    await anthropic.generate({ systemPrompt: "s", userPrompt: "secret-question-text", maxTokens: 300 });
    const b = anthropic.diagnostics().usage.byModel;
    assert.deepStrictEqual([b["claude-sonnet-5-5"].calls, b["claude-sonnet-5-5"].refusals, b["claude-sonnet-5"].calls, b["claude-sonnet-5"].refusals], [1, 1, 1, 0]);
    const all = JSON.stringify(anthropic.diagnostics());
    assert.ok(!all.includes("secret-question-text") && !all.includes("test-key-12345678"), "診断に質問文か鍵が含まれている");
  });
  await t("余裕の下限は ANTHROPIC_THINKING_HEADROOM_MIN で変えられる(別プロセスで確認)", async () => {
    const code = `const a=require(${ANTHROPIC_PATH}); const T=a.__v1042ForTest; console.log(JSON.stringify([T.maxTokensWithThinking("claude-sonnet-5-5",260), T.maxTokensWithThinking("claude-sonnet-5-5",700), T.maxTokensWithThinking("claude-haiku-4-5",260), a.diagnostics().thinkingHeadroom.min]));`;
    const out = await runChild(code, { ANTHROPIC_THINKING_HEADROOM_MIN: "1200" });
    assert.strictEqual(out.stdout, JSON.stringify([260 + 1200, 700 + 1400, 260, 1200]), out.stdout + out.stderr);
  });

  console.log("■ L. /api/diag/llm(既定モデル・実績)と深い自己診断");
  process.env.PORT = "0"; process.env.API_FOOTBALL_KEY = "k";
  process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:1"; process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  process.env.RATE_LIMIT_PER_MINUTE = "100000"; process.env.SELF_HEAL_DAILY_LEARNING = "0"; process.env.LINEUP_WATCH = "0";
  const srv = require(path.join(SERVER_DIR, "server.js"));
  const store = new Map();
  const cmd = async (c) => { const [op, ...a] = c;
    if (op === "GET") return store.has(a[0]) ? store.get(a[0]) : null;
    if (op === "MGET") return a.map((k) => (store.has(k) ? store.get(k) : null));
    if (op === "SET") { store.set(a[0], a[1]); return "OK"; }
    if (op === "HGETALL") { const h = store.get(a[0]); return h && typeof h === "object" ? Object.entries(h).flat() : []; }
    if (op === "HSET") { const h = store.get(a[0]) || {}; for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1]; store.set(a[0], h); return 1; }
    if (op === "LRANGE") return Array.isArray(store.get(a[0])) ? store.get(a[0]) : [];
    if (op === "INCR") { const v = (parseInt(store.get(a[0]), 10) || 0) + 1; store.set(a[0], String(v)); return v; }
    if (op === "INCRBY") { const v = (parseInt(store.get(a[0]), 10) || 0) + (parseInt(a[1], 10) || 0); store.set(a[0], String(v)); return v; }
    if (op === "EXPIRE") return 1;
    return null; };
  const kickoff = new Date(Date.now() + 3 * 3600000).toISOString();
  const fx = (id, hid, hn, aid, an, lid, ln) => ({ fixture: { id, date: kickoff, status: { short: "NS" }, venue: { name: "Stadium" } }, league: { id: lid, name: ln, country: "England" }, teams: { home: { id: hid, name: hn, logo: "" }, away: { id: aid, name: an, logo: "" } }, goals: { home: null, away: null } });
  srv.__setTestHooks({
    upstashCmd: cmd, upstashGetJSON: async (k) => { const r = await cmd(["GET", k]); return r === null ? null : JSON.parse(r); }, upstashSetJSON: async (k, v) => { await cmd(["SET", k, JSON.stringify(v)]); return true; },
    callApiFootball: async (ep, pr) => {
      if (ep === "/fixtures" && pr && pr.date) return { response: [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League")] };
      if (ep === "/fixtures" && pr && pr.id) return { response: Number(pr.id) === 501 ? [fx(501, 42, "Arsenal", 999, "Dibrados FC", 39, "Premier League")] : [] };
      return { response: [] };
    },
  });
  store.set("learn:ratings:v1", JSON.stringify({ byTeam: { 42: { att: 1.2, def: 0.9 } }, namesById: { 42: "Arsenal" }, matches: 1000 }));
  store.set("learn:teamnames", JSON.stringify({ 42: "Arsenal" }));
  store.set("kb:universe:teammap", JSON.stringify({ clubs: [{ teamId: 42, nameEn: "Arsenal", nameJa: "アーセナル" }] }));
  store.set("learn:ownpred:501", JSON.stringify({ fixtureId: 501, homeTeamEn: "Arsenal", awayTeamEn: "Dibrados FC", predictedWinner: "home", homeLambda: 1.6, awayLambda: 1.0, resolved: false, kickoff, weightsVersion: 12, loggedAt: "2026-11-12T02:00:00Z", leagueId: 39, league: "Premier League", leagueCountry: "England",
    finalProbs: { homeWin: 0.52, draw: 0.26, awayWin: 0.22, source: "market_blend" }, factorImportance: [{ key: "formDiff", labelJa: "直近フォーム", stars: 4 }], supplied: { formDiff: true } }));
  await new Promise((r) => (srv.server.listening ? r() : srv.server.on("listening", r)));
  const port = srv.server.address().port;
  const get = (p) => new Promise((resolve, reject) => { http.get({ host: "127.0.0.1", port, path: p }, (res) => { let buf = ""; res.setEncoding("utf8"); res.on("data", (c) => { buf += c; }); res.on("end", () => resolve({ status: res.statusCode, text: buf })); }).on("error", reject); });
  const diagScript = (body) => {
    const sys = String(body.system || "");
    if (/「OK」とだけ返してください/.test(sys)) return { thinking: true, text: "OK" };
    return loopScript(body);
  };
  await t("/api/diag/llm: 実呼び出しのモデルが claude-sonnet-5-5、既定モデル・戻り先・会話の実績が付く(鍵は含まない)", async () => {
    reset(); state.script = diagScript;
    const r = await get("/api/diag/llm");
    const b = JSON.parse(r.text);
    assert.strictEqual(b.ok, true, r.text.slice(0, 300)); assert.strictEqual(b.model, "claude-sonnet-5-5"); assert.strictEqual(b.modelFallbackFrom, null);
    assert.strictEqual(b.providerDiagnostics.models.heavy, "claude-opus-5-5"); assert.strictEqual(b.providerDiagnostics.models.previousLight, "claude-sonnet-5");
    assert.ok(b.conversation && Number.isFinite(b.conversation.toolPathOk) && Array.isArray(b.conversation.lastToolPathErrors));
    // 見送り用の戻り先・考える深さの設定・実測の使用量も読める(本番の外から WebFetch で確かめるため)
    assert.strictEqual(b.providerDiagnostics.models.refusalFallback, "claude-sonnet-5");
    assert.deepStrictEqual([b.providerDiagnostics.effort.light, b.providerDiagnostics.effort.heavy], [null, null]);
    assert.ok(b.providerDiagnostics.usage.byModel["claude-sonnet-5-5"].calls >= 1 && Number.isFinite(b.providerDiagnostics.usage.byModel["claude-sonnet-5-5"].outputTokens), JSON.stringify(b.providerDiagnostics.usage));
    assert.ok(!r.text.includes("test-key-12345678"));
    const again = JSON.parse((await get("/api/diag/llm")).text);
    assert.strictEqual(again.cached, true); assert.ok(again.providerDiagnostics && again.conversation);
  });
  await t("/api/diag/llm?deep=1: 最初は「開始」、少し待つと5つの試験の結果(全部成功・道具の確認コードが回答に入る)", async () => {
    reset(); state.script = diagScript;
    const first = JSON.parse((await get("/api/diag/llm?deep=1")).text);
    assert.strictEqual(first.status, "started"); assert.strictEqual(first.ok, null);
    let b = null;
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 50)); b = JSON.parse((await get("/api/diag/llm?deep=1")).text); if (b.steps) break; assert.strictEqual(b.status, "running"); }
    assert.ok(b && b.steps, "結果が出ない");
    assert.deepStrictEqual(b.steps.map((s) => [s.step, s.ok]), [["1_light_single", true], ["2_heavy_single", true], ["3_tools_nonstream", true], ["4_tools_stream", true], ["5_tools_heavy_final", true]], JSON.stringify(b.steps).slice(0, 900));
    assert.strictEqual(b.ok, true); assert.strictEqual(b.cached, true);
    assert.deepStrictEqual([b.steps[0].model, b.steps[1].model, b.steps[2].model, b.steps[4].model], ["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    const s3 = b.steps[2];
    assert.ok(s3.toolCalled && s3.codeEchoed && s3.rounds.length === 2 && s3.rounds[0].blocks.includes("thinking") && s3.rounds[0].blocks.includes("tool_use"), JSON.stringify(s3));
    assert.ok(b.steps[3].deltas > 0 && b.steps[3].stream === true);
    assert.strictEqual(b.steps[4].rounds[2].toolsSent, 0); assert.strictEqual(b.steps[4].rounds[2].messagesSent, 1);
    assert.ok(state.log.every((x) => x.status === 200), "診断中に拒まれた要求がある: " + JSON.stringify(state.log.filter((x) => x.status !== 200).map((x) => [x.model, x.status])));
    assert.ok(!JSON.stringify(b).includes("test-key-12345678"));
    const n = state.log.length;
    const cached = JSON.parse((await get("/api/diag/llm?deep=1")).text);
    assert.strictEqual(cached.cached, true); assert.strictEqual(state.log.length, n, "キャッシュ中に再実行している");
  });
  await t("深い自己診断は、新しい版が道具の往復を拒む場合もそのまま報告する(どの試験で・どの版が答えたか)", async () => {
    // 診断の状態を消して、拒む模擬 API でもう一度(テスト用フックが無いので、サーバーを作り直さず内部状態を直接戻す)
    const V = srv.__v1042ForTest;
    assert.ok(V && typeof V.resetLlmDeepDiag === "function", "__v1042ForTest.resetLlmDeepDiag が無い");
    V.resetLlmDeepDiag(); reset();
    state.script = (body) => { if (/-5-5$/.test(body.model) && hasToolResult(body.messages)) return { http: 400, error: "unexpected rule (mock)" }; return diagScript(body); };
    await get("/api/diag/llm?deep=1");
    let b = null;
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 50)); b = JSON.parse((await get("/api/diag/llm?deep=1")).text); if (b.steps) break; }
    const s3 = b.steps.find((s) => s.step === "3_tools_nonstream");
    assert.strictEqual(s3.ok, true); assert.strictEqual(s3.model, "claude-sonnet-5");
    assert.deepStrictEqual(s3.modelFallbacks, [{ from: "claude-sonnet-5-5", to: "claude-sonnet-5", reason: "http_400" }]);
    assert.ok(b.providerDiagnostics.stats.previousUsed >= 1 && b.providerDiagnostics.stats.lastFallbacks.some((f) => /unexpected rule/.test(f.detail || "")), JSON.stringify(b.providerDiagnostics.stats));
  });

  await t("深い自己診断の実行は1日の上限(既定6回)まで。超えたら回答AIを呼ばず、直近の結果を「1日の上限」と明記して返す(費用の保護)", async () => {
    const V = srv.__v1042ForTest;
    V.resetLlmDeepDiag(); reset(); state.script = diagScript;
    const waitDone = async () => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 50)); const b = JSON.parse((await get("/api/diag/llm?deep=1")).text); if (b.steps) return b; } throw new Error("結果が出ない"); };
    const max = V.llmDeepDiagInfo().maxPerDay;
    assert.strictEqual(max, 6);
    for (let i = 0; i < max; i++) {
      const first = JSON.parse((await get("/api/diag/llm?deep=1")).text);
      assert.strictEqual(first.status, "started", `${i + 1}回目: ` + JSON.stringify(first).slice(0, 200));
      const done = await waitDone();
      assert.strictEqual(done.ok, true, JSON.stringify(done.steps).slice(0, 300));
      V.resetLlmDeepDiag({ keepResult: true, keepCount: true }); // 30分のキャッシュが切れた状態にする(結果と今日の回数は残す)
    }
    assert.strictEqual(V.llmDeepDiagInfo().runsToday, max);
    const n = state.log.length;
    const over = JSON.parse((await get("/api/diag/llm?deep=1")).text);
    assert.strictEqual(over.status, "daily_limit", JSON.stringify(over).slice(0, 200));
    assert.strictEqual(over.cached, true); assert.ok(Array.isArray(over.steps) && over.steps.length === 5, "直近の結果が付いていない");
    assert.deepStrictEqual([over.runsToday, over.maxPerDay], [max, max]);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(state.log.length, n, "上限を超えたのに回答AIを呼んでいる");
    V.resetLlmDeepDiag();
  });

  console.log("■ M. 本物の会話の入口(本物の道具の定義 → 厳密な模擬 API)");
  process.env.PER_IP_LLM_CALLS_PER_DAY = "1000"; process.env.MAX_LLM_CALLS_PER_DAY = "100000";
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let buf = ""; res.setEncoding("utf8"); res.on("data", (c) => { buf += c; }); res.on("end", () => resolve({ status: res.statusCode, text: buf, headers: res.headers }));
    });
    req.on("error", reject); req.end(data);
  });
  // 回答AIの台本: 予想の質問には、まず本物の道具 get_today_predictions を呼び(考えた跡つき)、結果の確率を答えに入れる
  const discussScript = (body) => {
    const tools = Array.isArray(body.tools) ? body.tools.map((x) => x.name) : [];
    if (tools.includes("get_today_predictions") && !hasToolResult(body.messages)) return { thinking: true, whitespaceText: true, preText: "確認します。", toolUse: { name: "get_today_predictions", input: { team: "Arsenal" } } };
    const tr = lastToolResult(body.messages);
    const m = tr.match(/"confidencePct":(\d+)/) || tr.match(/"homeWinPct":(\d+)/);
    return { thinking: true, text: `###予想###\nアーセナル勝利が有利です(${m ? m[1] + "%" : "取得できません"})。\n\n###根拠###\n保存済みの予想の確率です。\n\n###注意###\n特になし\n\n###フォローアップ###\n相手の怪我人は?` };
  };
  for (const stream of [false, true]) {
    await t(`${stream ? "/api/discuss/stream" : "/api/discuss"}: 道具を1回使い、拒まれる要求が1つも無く、答えたモデルは claude-sonnet-5-5`, async () => {
      reset(); state.script = discussScript;
      const r = await post(stream ? "/api/discuss/stream" : "/api/discuss", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
      let b;
      if (stream) { const events = r.text.trim().split("\n").map((l) => JSON.parse(l)); const fin = events[events.length - 1]; assert.strictEqual(fin.t, "final", r.text.slice(0, 200)); b = fin.body; assert.ok(events.some((e) => e.t === "delta") && events.some((e) => e.t === "reset")); }
      else b = JSON.parse(r.text);
      assert.strictEqual(b.ok, true, r.text.slice(0, 400));
      assert.strictEqual(b.meta.tools.calls, 1, JSON.stringify(b.meta.tools));
      assert.strictEqual(b.meta.tools.fallbackReasonJa, null, "従来の1往復へ戻っている: " + b.meta.tools.fallbackReasonJa);
      assert.deepStrictEqual(b.meta.tools.modelFallbacks, []);
      assert.strictEqual(b.meta.llmModel, "claude-sonnet-5-5");
      assert.ok(b.prediction && /\d+%/.test(b.prediction.prediction), JSON.stringify(b.prediction));
      assert.ok(state.log.length >= 2 && state.log.every((x) => x.status === 200), "拒まれた要求がある: " + JSON.stringify(state.log.map((x) => [x.model, x.status])));
      // 2往復目: 本物の道具の定義が1往復目と同じまま渡り、考えた跡が受け取ったまま返っている
      assert.deepStrictEqual(state.log[1].toolNames, state.log[0].toolNames);
      assert.ok(state.log[0].toolNames.length >= 5, "本物の道具の定義が渡っていない: " + state.log[0].toolNames);
      assert.deepStrictEqual(state.log[1].messages[1].content.map((x) => x.type), ["thinking", "text", "tool_use"]);
      assert.ok(state.log.every((x) => x.max_tokens > 700), "考える分の余裕が入っていない: " + state.log.map((x) => x.max_tokens));
    });
  }
  await t("会話の経路の実績(/api/diag/llm の conversation)に、道具つきの成功が数えられている", async () => {
    const V = srv.__v1042ForTest;
    assert.ok(V.discussPathStats.toolPathOk >= 2, JSON.stringify(V.discussPathStats));
    assert.strictEqual(V.discussPathStats.toolPathFellBackToLegacy, 0);
  });
  await t("新しい版が会話を拒み、1つ前の版も拒むときは、従来の1往復で必ず答える(理由が meta と実績に残る)", async () => {
    reset();
    state.script = (body) => { if (Array.isArray(body.tools) && body.tools.length) return { http: 400, error: "tools: rejected (mock)" }; return { thinking: true, text: "###予想###\n従来の方式の答えです。\n\n###根拠###\n-\n\n###注意###\n特になし\n\n###フォローアップ###\n次は?" }; };
    const r = await post("/api/discuss", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.ok, true, r.text.slice(0, 300));
    assert.ok(/HTTP 400/.test(b.meta.tools.fallbackReasonJa || ""), JSON.stringify(b.meta.tools));
    assert.ok(b.prediction.prediction.includes("従来の方式の答え"));
    const V = srv.__v1042ForTest;
    assert.ok(V.discussPathStats.toolPathFellBackToLegacy >= 1 && V.discussPathStats.lastToolPathErrors.length >= 1 && /tools: rejected/.test(JSON.stringify(V.discussPathStats.lastToolPathErrors)), JSON.stringify(V.discussPathStats));
  });

  await t("/api/discuss: 新しい版が会話を見送っても、道具つきの会話のまま戻り先のモデルが答える(従来の1往復へ戻らない・理由が meta に残る)", async () => {
    reset();
    state.script = (body) => (/-5-5$/.test(body.model) ? { refusal: { category: "general_harms" } } : discussScript(body));
    const r = await post("/api/discuss", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
    const b = JSON.parse(r.text);
    assert.strictEqual(b.ok, true, r.text.slice(0, 300));
    assert.strictEqual(b.meta.llmModel, "claude-sonnet-5");
    assert.strictEqual(b.meta.tools.calls, 1, JSON.stringify(b.meta.tools)); assert.strictEqual(b.meta.tools.fallbackReasonJa, null);
    assert.ok(b.meta.tools.modelFallbacks.length >= 2 && b.meta.tools.modelFallbacks.every((f) => f.from === "claude-sonnet-5-5" && f.to === "claude-sonnet-5" && f.reason === "refusal"), JSON.stringify(b.meta.tools.modelFallbacks));
    assert.ok(/\d+%/.test(b.prediction.prediction), "道具の結果が答えに入っていない: " + JSON.stringify(b.prediction));
    assert.ok(state.log.every((x) => x.status === 200), "拒まれた要求がある: " + JSON.stringify(state.log.map((x) => [x.model, x.status])));
  });
  await t("/api/discuss/stream: 本文を流したあとに見送られたら、画面を消して従来の1往復でやり直し、戻り先のモデルが答える", async () => {
    reset();
    const before = srv.__v1042ForTest.discussPathStats.toolPathFellBackToLegacy;
    state.script = (body) => {
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (/-5-5$/.test(body.model)) return hasTools ? { refusal: { partialText: "途中まで流れた文。" } } : { refusal: {} };
      return { thinking: true, text: "###予想###\n戻り先のモデルの答えです。\n\n###根拠###\n-\n\n###注意###\n特になし\n\n###フォローアップ###\n次は?" };
    };
    const r = await post("/api/discuss/stream", { question: "アーセナルは今日勝てる?", subject: { type: "club", labelJa: "アーセナル", labelEn: "Arsenal" }, lang: "ja" });
    const events = r.text.trim().split("\n").map((l) => JSON.parse(l));
    const fin = events[events.length - 1];
    assert.strictEqual(fin.t, "final", r.text.slice(0, 300)); assert.strictEqual(fin.body.ok, true, JSON.stringify(fin.body).slice(0, 300));
    const iDelta = events.findIndex((e) => e.t === "delta"); const iReset = events.findIndex((e, i) => i > iDelta && e.t === "reset");
    assert.ok(iDelta >= 0 && iReset > iDelta, "途中の文を流したあとに画面を消していない: " + JSON.stringify(events.map((e) => e.t)));
    assert.ok(fin.body.prediction.prediction.includes("戻り先のモデルの答え") && !JSON.stringify(fin.body).includes("途中まで流れた文"), JSON.stringify(fin.body.prediction));
    assert.strictEqual(fin.body.meta.llmModel, "claude-sonnet-5");
    assert.ok(/EMPTY_RESPONSE/.test(fin.body.meta.tools.fallbackReasonJa || ""), JSON.stringify(fin.body.meta.tools));
    assert.strictEqual(srv.__v1042ForTest.discussPathStats.toolPathFellBackToLegacy, before + 1);
    const d = anthropic.diagnostics();
    assert.deepStrictEqual([d.stats.refusals, d.stats.refusalsAnswered, d.stats.lastRefusals.map((x) => x.note)], [2, 1, ["partial_text_already_shown", null]], JSON.stringify(d.stats.lastRefusals));
  });

  mock.close(); srv.server.close();
  console.log(`\nv104.2 llm: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
