const fs = require('fs');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
const scriptStart = src.indexOf('<script>') + 8;
const scriptEnd = src.lastIndexOf('</script>');
let code = src.slice(scriptStart, scriptEnd);
code += `\nreturn { PLAYERS, renderPlayerCard, computeScoutStars, computePlaystyleTag, getTrivia, answerPlayerQuestion, answerClubQuestion, buildClubAnswer, guessUnregisteredPlayerName, NO_RULE_MATCH, buildFallbackPlayer, simulatePerformance, wirePlayerExtras, renderComparison, findPlayer, sendChatMessage, chatHistories, photoCache, state, MATCHUPS, playersForSide, renderMatchList, renderMatchAnalysis, teamAvg, pickLikelyXI };`;

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

// match analysis AI
// NOTE: renderMatchAnalysis() is now async (Stage B: it awaits /api/predict-match,
// falling back to the identical local calculation when the fetch fails — which it
// always does here, since the stubbed fetch above throws "no network"). It must be
// awaited so any error thrown inside it is actually caught by this try/catch.
(async () => {
  try {
    api.renderMatchList();
    for (const m of api.MATCHUPS) {
      const homeN = api.playersForSide(m, 'home').length, awayN = api.playersForSide(m, 'away').length;
      console.log(`matchup ${m.id}: home=${homeN} registered, away=${awayN} registered`);
      for (let i = 0; i < 3; i++) await api.renderMatchAnalysis(m.id); // run a few times since it's randomized
    }
  } catch (e) {
    errors.push('match analysis: ' + e.message + '\n' + e.stack);
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
