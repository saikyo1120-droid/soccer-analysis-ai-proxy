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
code += `\nreturn { PLAYERS, renderPlayerCard, computeScoutStars, computePlaystyleTag, getTrivia, answerPlayerQuestion, answerClubQuestion, buildClubAnswer, guessUnregisteredPlayerName, NO_RULE_MATCH, buildFallbackPlayer, simulatePerformance, wirePlayerExtras, renderComparison, findPlayer, sendChatMessage, chatHistories, photoCache, state, teamAvg };`;

function makeEl(id) {
  const listeners = {};
  const el = {
    id, innerHTML: '', textContent: '', value: '', style: {}, children: [], dataset: {},
    addEventListener(ev, fn) { listeners[ev] = listeners[ev] || []; listeners[ev].push(fn); },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, classList: { toggle() {}, add() {}, remove() {} },
    scrollTop: 0, scrollHeight: 0, scrollIntoView() {},
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
const api = fn(documentStub, windowStub, windowStub.navigator, async () => { throw new Error('no network'); });

const keys = Object.keys(api.PLAYERS);
console.log('Total registered players:', keys.length);

let errors = [];
for (const key of keys) {
  const player = { key, ...api.PLAYERS[key] };
  try {
    api.renderPlayerCard(player, 'beginner');
    api.renderPlayerCard(player, 'standard');
    api.renderPlayerCard(player, 'expert');
    const stars = api.computeScoutStars(player);
    const tag = api.computePlaystyleTag(player);
    const trivia = api.getTrivia(player);
    if (!stars || !tag || !trivia) throw new Error('empty result from a helper');
    // exercise chat with a handful of example questions.
    // 2026年8月・優先順位①: answerPlayerQuestionはもう「全ての質問に必ず文字列で
    // 答える」関数ではない。ルールベースのパターンに一致しない質問(例:
    // 「ランダムな質問です」のような無関係な文、または対象が特定できない比較質問)
    // ではNO_RULE_MATCHを返し、呼び出し側(sendChatMessage/heroAskAI)がAIの議論
    // エンジンへエスカレーションする設計に変わった。そのため、ここでは
    // 「文字列(=無料の即答が成立した)」か「NO_RULE_MATCH(=正しくAIへ委ねる
    // 判断をした)」のどちらかであることを確認する(空文字列やundefinedのような
    // 「壊れた」戻り値だけを不正とみなす)。
    ['全盛期はいつ？', 'なぜ評価が高い？', '弱点は？', 'どんな戦術に合う？', '初心者にもわかるように説明して', '久保建英との違いは？', 'ランダムな質問です'].forEach(q => {
      const ans = api.answerPlayerQuestion(player, q);
      const valid = ans === api.NO_RULE_MATCH || (typeof ans === 'string' && ans.length > 0);
      if (!valid) throw new Error('bad chat answer for: ' + q);
    });
    // 明らかに無関係な質問は、必ずNO_RULE_MATCH(=AIへのエスカレーション)に
    // なるべきで、でっち上げの回答を返してはならない。
    if (api.answerPlayerQuestion(player, 'ランダムな質問です') !== api.NO_RULE_MATCH) {
      throw new Error('unrelated question should escalate to the discuss engine, not fabricate an answer');
    }
    // exercise comparison against one other random player
    const otherKey = keys[(keys.indexOf(key) + 7) % keys.length];
    if (otherKey !== key) api.renderComparison(player, otherKey);
  } catch (e) {
    errors.push(`${key}: ${e.message}`);
  }
}

// fallback (unregistered) player path
try {
  const fb = api.buildFallbackPlayer('未登録テスト太郎');
  api.renderPlayerCard(fb, 'beginner');
  const ans = api.answerPlayerQuestion(fb, '弱点は？');
  if (!ans) throw new Error('empty fallback chat answer');
} catch (e) {
  errors.push('fallback player: ' + e.message);
}

// v104.2(利用者のご要望「仮の対戦は全部消す」): ここで検査していた「注目の試合カード」
// (登録選手のデータから作る仮の対戦 MATCHUPS と、その AI 試合プレビュー renderMatchAnalysis)は
// 画面ごと外した。外したものが本体のスクリプトに残っていないことと、実際の試合の分析などが
// 引き続き使う平均の計算(teamAvg)が「選手0人なら null」を返すことを確かめる。
(async () => {
  try {
    for (const gone of ['MATCHUPS', 'renderMatchList', 'renderMatchAnalysis', 'playersForSide', 'pickLikelyXI', 'computeMatchAnalysisLocally', 'getDailyFeaturedMatchup', 'renderRankingsTab', 'initMatchAnalysisWidget']) {
      if (new RegExp('(?:function|const|let|var)\\s+' + gone + '\\b').test(code)) throw new Error('外したはずの ' + gone + ' が本体のスクリプトに残っています');
    }
    if (api.teamAvg([], 'overall') !== null) throw new Error('teamAvg([]) が null ではありません');
    const somePlayers = Object.keys(api.PLAYERS).slice(0, 3).map((k) => api.PLAYERS[k]);
    const avg = api.teamAvg(somePlayers, 'overall');
    if (!(typeof avg === 'number' && avg > 0)) throw new Error('teamAvg が数値を返しません: ' + avg);
  } catch (e) {
    errors.push('removed simulated-match code: ' + e.message + '\n' + e.stack);
  }

  if (errors.length) {
    console.log('ERRORS (' + errors.length + '):');
    errors.slice(0, 20).forEach(e => console.log(' -', e));
    process.exitCode = 1;
  } else {
    console.log('All ' + Object.keys(api.PLAYERS || {}).length + ' players + fallback rendered across all 3 levels with no thrown errors.');
    console.log('Chat/compare/scout-star/trivia helpers all returned non-empty results for every player.');
  }
})();
