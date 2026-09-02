// 2026年8月・「議論できるAIへの強化」フェーズ 優先順位①(最重要・AIチャットの
// 理解力)専用のテスト。dialogue_partner_test.jsはfetchを常にthrowさせて
// 「エスカレーションが正しく起きること」と「もう固定の失敗文言を出さないこと」を
// 確認しているが、このテストはさらに踏み込んで:
//   1) guessUnregisteredPlayerName() ― 未登録選手名の推測ヒューリスティックが
//      期待通りに動くこと
//   2) answerClubQuestion() ― 素朴な概要質問は即答、分析が必要な角度の質問は
//      正しくエスカレーション(NO_RULE_MATCH)されること
//   3) fetchを「成功する議論エンジンの応答」でモックし、エスカレーションされた
//      質問が実際に本物のAI考察(6部構成)としてレンダリングされること(ハッピー
//      パスの動作確認。これまでのテストは失敗パスしか見ていなかった)
// を検証する。
const assert = require('assert');
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
code += `\nreturn { PLAYERS, MATCHUPS, state, chatHistories, heroChatHistory, sendChatMessage, heroAskAI, answerClubQuestion, buildClubAnswer, answerPlayerQuestion, guessUnregisteredPlayerName, NO_RULE_MATCH, detectClubMention, findAllMentionedPlayers };`;

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, children: [], dataset: {},
    addEventListener() {}, querySelectorAll() { return []; }, closest() { return null; },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    scrollTop: 0, scrollHeight: 0, scrollIntoView() {}, click() {},
  };
}
const documentStub = {
  getElementById(id) { return makeEl(id); },
  documentElement: makeEl('html'),
  querySelectorAll() { return []; },
  querySelector() { return makeEl('stub'); },
  addEventListener() {},
};
const windowStub = { navigator: { clipboard: { writeText: async () => {} } }, scrollTo() {} };

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}`); failures++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}\n${e.stack}`); failures++; }
}

(async () => {
  // ---- fetchが常に失敗するインスタンス(ヒューリスティック単体テスト用) ----
  const fnFail = new Function('document', 'window', 'navigator', 'fetch', code);
  const apiFail = fnFail(documentStub, windowStub, windowStub.navigator, async () => { throw new Error('no network'); });

  test('guessUnregisteredPlayerName: カタカナの選手名を抽出できる', () => {
    assert.strictEqual(apiFail.guessUnregisteredPlayerName('ハーランドってどんな選手？'), 'ハーランド');
    assert.strictEqual(apiFail.guessUnregisteredPlayerName('ヴィニシウスの得点力は？'), 'ヴィニシウス');
  });

  test('guessUnregisteredPlayerName: 既知の日本人選手の簡易辞書から抽出できる', () => {
    assert.strictEqual(apiFail.guessUnregisteredPlayerName('三笘の得意技は？'), '三笘');
  });

  test('guessUnregisteredPlayerName: 手がかりが無ければnullを返す(捏造しない)', () => {
    assert.strictEqual(apiFail.guessUnregisteredPlayerName('こんにちは'), null);
  });

  test('answerClubQuestion: 素朴な概要質問は即答(NO_RULE_MATCHではない)', () => {
    const clubName = Object.values(apiFail.PLAYERS)[0].club.split('(')[0].trim();
    const ans = apiFail.answerClubQuestion(clubName, `${clubName}はどんなクラブ？`, 'standard');
    assert.notStrictEqual(ans, apiFail.NO_RULE_MATCH);
    assert.ok(typeof ans === 'string' && ans.length > 0);
  });

  test('answerClubQuestion: 実データの裏付けが必要な角度の質問はエスカレーション(NO_RULE_MATCH)される', () => {
    const clubName = Object.values(apiFail.PLAYERS)[0].club.split('(')[0].trim();
    ['最近弱くなった？', '補強すべき？', '監督采配はどう？', '順位は大丈夫？'].forEach((q) => {
      const ans = apiFail.answerClubQuestion(clubName, `${clubName}は${q}`, 'standard');
      assert.strictEqual(ans, apiFail.NO_RULE_MATCH, `"${q}" should escalate but got: ${String(ans)}`);
    });
  });

  // ---- fetchが成功した議論エンジン応答を返すインスタンス(ハッピーパス確認用) ----
  const MOCK_DISCUSS_RESPONSE = {
    ok: true,
    generalView: '一般的には強豪と見なされています。',
    aiOpinion: 'AI独自の分析では、直近のデータからも高い競争力が確認できます。',
    counterArgument: '一方で、主力の負傷離脱には注意が必要という見方もあります。',
    finalConclusion: '総合的には引き続き優勝候補の一角と評価します。',
    futureOutlook: '今後数試合でその真価が問われるでしょう。',
    mostImportantOpinion: '私は選手層の厚さが最も重要だと考えます。',
    confidence: { stars: 4, reasonJa: '実データに基づく分析のため。' },
    facts: ['直近5試合の得失点差はプラスです。'],
    followUpQuestions: ['監督の采配についてどう思う？'],
    meta: { parsedOk: true },
  };
  const fnOk = new Function('document', 'window', 'navigator', 'fetch', code);
  const apiOk = fnOk(documentStub, windowStub, windowStub.navigator, async () => ({
    ok: true,
    json: async () => MOCK_DISCUSS_RESPONSE,
  }));

  await testAsync('heroAskAI: 分析が必要なクラブ質問が実際に議論エンジンの6部構成で返る(エスカレーションのハッピーパス)', async () => {
    const clubName = Object.values(apiOk.PLAYERS)[0].club.split('(')[0].trim();
    await apiOk.heroAskAI(`${clubName}は最近弱くなった？`);
    const last = apiOk.heroChatHistory[apiOk.heroChatHistory.length - 1];
    assert.ok(last && last.text.includes('AI独自の意見'), 'discuss engine reply should render the 6-part structure');
    assert.ok(last.text.includes('直近のデータからも高い競争力'));
    assert.ok(!last.text.includes('うまく認識できませんでした'));
  });

  await testAsync('heroAskAI: 主題が特定できない一般的な質問でも実際にAIの考察が返る(以前は即座に失敗していたケース)', async () => {
    await apiOk.heroAskAI('今日強いクラブは？');
    const last = apiOk.heroChatHistory[apiOk.heroChatHistory.length - 1];
    assert.ok(last && last.text.includes('AI独自の意見'));
    assert.ok(!last.text.includes('うまく認識できませんでした'));
  });

  await testAsync('heroAskAI: 未登録選手っぽい質問でも実際にAIの考察が返る(API-Football実検索へのエスカレーション)', async () => {
    // 「ザネッティ」はこのアプリのローカル選手カード(PLAYERS)には未登録だが、
    // カタカナ表記のためguessUnregisteredPlayerName()が拾い、サーバー側の
    // API-Football実検索(handlePlayerSeasonStats)に委ねられるはず。
    assert.deepStrictEqual(apiOk.findAllMentionedPlayers('ザネッティの将来性ある？', 2), [], 'test precondition: this name must NOT be in the local roster');
    await apiOk.heroAskAI('ザネッティの将来性ある？');
    const last = apiOk.heroChatHistory[apiOk.heroChatHistory.length - 1];
    assert.ok(last && last.text.includes('AI独自の意見'));
    assert.ok(!last.text.includes('うまく認識できませんでした'));
    assert.ok(!last.text.includes('この聞き方にはまだうまくお答えできませんでした'));
  });

  console.log(failures === 0 ? '\nAll chat-understanding (優先順位①) tests PASSED.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
