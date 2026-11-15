// Dedicated regression test for the "AI対話パートナー" (dialogue partner) feature:
// exercises sendChatMessage (per-player chat) and heroAskAI (hero chat) end-to-end
// against a fake DOM, and checks that buildDialogueExtras actually produced the
// expected reflect/perspective/followup HTML for each topic type (player/club/match/comparison),
// and that beginner level omits the "perspective" (別の視点) line as designed.
const fs = require('fs');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
// index.htmlには現在インライン<script>が2本ある(先頭: v56多言語辞書ブロック、後方: 本体)。
// 旧来の「最初の<script>〜最後の</script>」切り出しは間のHTMLまで巻き込んで
// SyntaxErrorになるため、src属性なしの<script>ブロックを個別に抽出し、
// 従来どおり本体スクリプト(最大=後方のブロック)だけを評価する。
const inlineScripts = [];
{
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) inlineScripts.push(m[1]);
}
if (!inlineScripts.length) throw new Error('no inline <script> blocks found in index.html');
let code = inlineScripts.reduce((a, b) => (b.length >= a.length ? b : a), '');
code += `\nreturn { PLAYERS, state, chatHistories, heroChatHistory, sendChatMessage, heroAskAI, renderPlayerCard, renderChatUI, renderHeroChatUI, buildDialogueExtras, effectiveDialogueLevel, findPlayer };`;

function makeEl(id) {
  const listeners = {};
  const el = {
    id, innerHTML: '', textContent: '', value: '', style: {}, children: [], dataset: {},
    addEventListener(ev, fn) { listeners[ev] = listeners[ev] || []; listeners[ev].push(fn); },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, classList: { toggle() {}, add() {}, remove(){}, contains(){ return false; } },
    scrollTop: 0, scrollHeight: 0, scrollIntoView() {},
    click() {},
  };
  return el;
}
const documentStub = {
  getElementById(id) { return makeEl(id); },
  documentElement: makeEl('html'),
  querySelectorAll() { return []; },
  querySelector() { return makeEl('stub'); },
  addEventListener() {},
};
const windowStub = { navigator: { clipboard: { writeText: async () => {} } }, scrollTo() {} };
const fn = new Function('document', 'window', 'navigator', 'fetch', code);
// v104.1: どの宛先へ通信しようとしたかを記録する(「サーバーのAIへ渡したか」を確かめるため)。通信そのものは常に失敗させる。
const fetchCalls = [];
const api = fn(documentStub, windowStub, windowStub.navigator, async (u) => { fetchCalls.push(String(u && u.url ? u.url : u)); throw new Error('no network'); });

let errors = [];
const fail = (msg) => errors.push(msg);

function extrasOf(historyArr) {
  const last = historyArr[historyArr.length - 1];
  if (!last || last.role !== 'ai') return null;
  return last.extras || '';
}

(async () => {

// ---- 1) per-player chat (sendChatMessage) : topicType "player" ----
const keys = Object.keys(api.PLAYERS);
const p1key = keys[0];
const player1 = { key: p1key, ...api.PLAYERS[p1key] };
api.state.level = 'standard';
await api.sendChatMessage(player1, '全盛期はいつ？');
{
  const extras = extrasOf(api.chatHistories[player1.key] || api.chatHistories[Object.keys(api.chatHistories)[0]]);
  const key = Object.keys(api.chatHistories)[0];
  const ex = extrasOf(api.chatHistories[key]);
  if (!ex || !ex.includes('dialogue-extra')) fail('player chat: no dialogue-extra block produced. Got: ' + JSON.stringify(ex));
  if (!ex.includes('dialogue-reflect')) fail('player chat: missing dialogue-reflect');
  if (!ex.includes('followup-chip-row') || !ex.includes('chat-followup-btn')) fail('player chat: missing followup chips');
  if (!ex.includes('dialogue-perspective')) fail('player chat (standard level): expected dialogue-perspective to be present');
}

// ---- 2) beginner level should OMIT the perspective line ----
api.state.level = 'beginner';
const beginnerHistoryKeyBefore = Object.keys(api.chatHistories).length;
await api.sendChatMessage(player1, 'この選手のすごいところは？');
{
  const key = Object.keys(api.chatHistories)[0];
  const ex = extrasOf(api.chatHistories[key]);
  if (ex && ex.includes('dialogue-perspective')) fail('beginner level: dialogue-perspective should be omitted but was present. Got: ' + ex);
}

// ---- 3) comparison topic via per-player chat ----
api.state.level = 'standard';
const p2key = keys[1];
const player2 = { key: p2key, ...api.PLAYERS[p2key] };
await api.sendChatMessage(player1, `${api.PLAYERS[p2key].name}との違いは？`);
{
  const key = Object.keys(api.chatHistories)[0];
  const ex = extrasOf(api.chatHistories[key]);
  if (!ex || !ex.includes('dialogue-extra')) fail('comparison chat: no dialogue-extra produced (mention-detection may have failed). Got: ' + JSON.stringify(ex));
}

// ---- 4) hero chat: player topic ----
await api.heroAskAI(`${player1.name}はどんな選手？`);
{
  const ex = extrasOf(api.heroChatHistory);
  if (!ex || !ex.includes('dialogue-extra')) fail('hero chat (player): no dialogue-extra. Got: ' + JSON.stringify(ex));
}

// ---- 5) hero chat: club topic ----
// mirror clubBase()'s own normalization (strip any "(...)" loan/rumor suffix) so this
// matches exactly what detectClubMention() would resolve the question to.
// 2026年8月・優先順位①: 「なぜ強い」のような分析を要する角度の質問はもう
// answerClubQuestion()の即答パターンには一致せず、正しくAIの議論エンジンへ
// エスカレーションされる(=buildDialogueExtras方式のdialogue-extraではなく、
// discuss engine独自のUIになる)。このテストは「素朴な概要質問」が引き続き
// 即答(dialogue-extra)で処理されることを検証する対象なので、質問文もその
// 経路に一致するものに合わせる(エスカレーション自体は下のテスト10で別途検証)。
const someClub = (api.PLAYERS[p1key].club || "").split("(")[0].trim() || null;
if (someClub) {
  await api.heroAskAI(`${someClub}はどんなクラブ？`);
  const ex = extrasOf(api.heroChatHistory);
  if (!ex || !ex.includes('dialogue-extra')) fail('hero chat (club): no dialogue-extra for club question "' + someClub + '". Got: ' + JSON.stringify(ex));
}

// ---- 6) hero chat: match topic ----
// v104.1(総点検)で仕様を変更: 「今日の試合」「どっちが勝つ」の質問は、画面内の固定の「おすすめカード」
// (登録クラブどうしの仮の対戦)で答えて終わらせず、サーバーのAI(今日の予想・自信ランク・対戦分析の道具つき)へ渡す。
// 旧仕様では「今日の自信のある試合は?」「今日のSランクの試合を教えて」などがAIに一度も届いていなかった。
// (このテストは長く古い画面ファイルを読んでいたため、旧仕様のまま通っていた。)
for (const q of ['今日見るべき試合は？', '今日の自信のある試合は？', '今日のSランクの試合を教えて', '明日の試合の予想は？']) {
  const before = fetchCalls.length;
  await api.heroAskAI(q);
  const last = api.heroChatHistory[api.heroChatHistory.length - 1];
  const text = (last && last.text) || '';
  const ex = extrasOf(api.heroChatHistory);
  const sent = fetchCalls.slice(before);
  if (!sent.some((u) => /\/api\/discuss/.test(u))) fail(`hero chat (match): "${q}" がサーバーのAI(/api/discuss)へ渡っていない。通信先: ${JSON.stringify(sent)}`);
  if (/具体的な対戦カードが分からなかった/.test(text)) fail(`hero chat (match): "${q}" に固定の「おすすめカード」で答えている(旧仕様)`);
  if (ex && ex.includes('dialogue-extra')) fail(`hero chat (match): "${q}" に旧来の定型の続き(dialogue-extra)が付いている`);
  if (!text || !text.length) fail(`hero chat (match): "${q}" の返答が空`);
}

// ---- 7) hero chat: comparison topic ----
await api.heroAskAI(`${player1.name}と${player2.name}どっちが上手い？`);
{
  const ex = extrasOf(api.heroChatHistory);
  if (!ex || !ex.includes('dialogue-extra')) fail('hero chat (comparison): no dialogue-extra. Got: ' + JSON.stringify(ex));
}

// ---- 8) hero chat: unrecognized question -> should have NO dialogue-extra ----
// (このテストのfetchスタブは常にthrowするため、議論エンジンへエスカレーション
// された結果は「正直な接続エラー」メッセージになる。dialogue-extra方式ではない
// ので、ここではその形式で無いことだけを確認する。)
await api.heroAskAI('あああああ意味不明な質問123');
{
  const ex = extrasOf(api.heroChatHistory);
  if (ex && ex.includes('dialogue-extra')) fail('hero chat (unrecognized): should have NO dialogue-extra but got one: ' + ex);
}

// ---- 9) effectiveDialogueLevel: vocabulary bump ----
{
  const lv1 = api.effectiveDialogueLevel('5バックで守ったらどうなる？', 'beginner');
  if (lv1 !== 'standard') fail('effectiveDialogueLevel: beginner + advanced vocab should bump to standard, got ' + lv1);
  const lv2 = api.effectiveDialogueLevel('5バックで守ったらどうなる？', 'standard');
  if (lv2 !== 'expert') fail('effectiveDialogueLevel: standard + advanced vocab should bump to expert, got ' + lv2);
  const lv3 = api.effectiveDialogueLevel('普通の質問です', 'beginner');
  if (lv3 !== 'beginner') fail('effectiveDialogueLevel: no advanced vocab should NOT change level, got ' + lv3);
}

// ---- 10) 2026年8月・優先順位①(最重要): 以前は「うまく認識できませんでした」
// 「この聞き方にはまだうまくお答えできませんでした」で即座に諦めていた質問群が、
// 今はすべて実データ+LLMの議論エンジンへエスカレーションされることを確認する。
// このテスト環境のfetchは常にthrowするため最終的な文言は「接続できませんでした」
// という正直なエラーになるが、重要なのは「もう理解を諦めるための固定文言を
// 一切出さない」こと。
{
  const deadEndPhrases = [
    'うまく認識できませんでした',
    'この聞き方にはまだうまくお答えできませんでした',
  ];
  const casesToEscalate = [
    `${someClub || 'レアル・マドリード'}は最近弱くなった？`, // club: real-data-dependent angle -> must escalate, not fabricate
    `${someClub || 'レアル・マドリード'}は補強すべき？`,
    '今日強いクラブは？', // no subject at all -> previously a flat dead end
    '将来性ある選手は誰？',
    'ベストイレブン組んで',
  ];
  for (const q of casesToEscalate) {
    await api.heroAskAI(q);
    const last = api.heroChatHistory[api.heroChatHistory.length - 1];
    const text = (last && last.text) || '';
    for (const dead of deadEndPhrases) {
      if (text.includes(dead)) fail(`hero chat escalation: "${q}" still produced the old dead-end phrase "${dead}"`);
    }
    // must show either a real discuss-engine reply or the honest "couldn't reach the AI" message —
    // never blank/undefined.
    if (!text || !text.length) fail(`hero chat escalation: "${q}" produced an empty reply`);
  }
}

if (errors.length) {
  console.log('ERRORS (' + errors.length + '):');
  errors.forEach(e => console.log(' -', e));
  process.exitCode = 1;
} else {
  console.log('Dialogue partner feature: all checks passed (player/club/comparison topics, match questions escalate to the server AI, beginner-omits-perspective, followup chips, level inference, unrecognized-question has no extras, and previously-unanswerable questions now escalate to the discuss engine instead of dead-ending).');
}

})();
