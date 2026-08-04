/**
 * 2026年8月・優先順位②③④の実装確認テスト。
 *
 * ②ホーム画面に「今日の試合」カードを追加: realFixturesCardをホーム画面上部
 *   (growthLogCardの直後)に移動したことは目視確認が必要なためここでは扱わないが、
 *   その表示ロジック自体(renderRealFixturesIfAvailable/fixtureRowHtml)は
 *   ④のテストで間接的にカバーされる。
 * ③試合展開の90分ストーリー予想: build90MinStoryHtmlが、でっち上げの具体的な
 *   出来事(架空のゴールなど)を書かず、実データ(登録選手の能力値)に基づいた
 *   確率的な言い回しで序盤/中盤/終盤を語ること、データが片方/両方無い場合の
 *   挙動を確認する。
 * ④試合を「開始前/試合中/終了」で整理: classifyFixtureStatusが各種status.short
 *   を正しく3分類(+その他)すること、fixtureRowHtmlが対応するバッジを出すことを
 *   確認する。
 */
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
const scriptStart = src.indexOf('<script>') + 8;
const scriptEnd = src.lastIndexOf('</script>');
let code = src.slice(scriptStart, scriptEnd);
code += `\nreturn { PLAYERS, classifyFixtureStatus, fixtureStatusLabel, fixtureRowHtml, build90MinStoryHtml, pickPlayerByAttr, buildUpcomingPreviewHtml, buildLiveAnalysisHtml, buildFinishedAnalysisHtml, teamAvg, mapEnglishClubToRegistered, registeredPlayersForClubJa, fixturesByLeagueHtml, FIXTURE_LIVE_STATUSES, FIXTURE_FINISHED_STATUSES, FIXTURE_NOTSTARTED_STATUSES };`;

function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', style: {}, children: [], dataset: {},
    addEventListener() {}, querySelectorAll() { return []; }, closest() { return null; },
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

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  [OK] ${name}`); }
  catch (e) { console.error(`  [FAIL] ${name}: ${e.message}`); failures++; }
}

// ---- ④ ステータス分類 ----
test('classifyFixtureStatus: 試合前のステータスをupcomingに分類する', () => {
  assert.strictEqual(api.classifyFixtureStatus('NS'), 'upcoming');
  assert.strictEqual(api.classifyFixtureStatus('TBD'), 'upcoming');
});
test('classifyFixtureStatus: 試合中のステータスをliveに分類する', () => {
  ['1H', 'HT', '2H', 'ET', 'P'].forEach((s) => assert.strictEqual(api.classifyFixtureStatus(s), 'live', `status=${s}`));
});
test('classifyFixtureStatus: 終了系のステータスをfinishedに分類する', () => {
  ['FT', 'AET', 'PEN'].forEach((s) => assert.strictEqual(api.classifyFixtureStatus(s), 'finished', `status=${s}`));
});
test('classifyFixtureStatus: 延期・中止などはotherに分類し、でっち上げの分類をしない', () => {
  assert.strictEqual(api.classifyFixtureStatus('PST'), 'other');
  assert.strictEqual(api.classifyFixtureStatus('CANC'), 'other');
  assert.strictEqual(api.classifyFixtureStatus(null), 'other');
  assert.strictEqual(api.classifyFixtureStatus('SOME_UNKNOWN_FUTURE_CODE'), 'other');
});
test('fixtureRowHtml: 試合中の試合にはLIVEバッジと点滅ドットを表示する', () => {
  const html = api.fixtureRowHtml({ id: 1, date: new Date().toISOString(), status: '1H', home: { name: 'A' }, away: { name: 'B' }, score: { home: 1, away: 0 }, venue: null });
  assert.ok(html.includes('is-live'), 'is-liveクラスが付与されるはず');
  assert.ok(html.includes('live-dot'), 'ライブ点滅ドットが含まれるはず');
});
test('fixtureRowHtml: 終了した試合には✅終了バッジを表示する', () => {
  const html = api.fixtureRowHtml({ id: 2, date: new Date().toISOString(), status: 'FT', home: { name: 'A' }, away: { name: 'B' }, score: { home: 2, away: 1 }, venue: null });
  assert.ok(html.includes('is-finished'), 'is-finishedクラスが付与されるはず');
});
test('fixtureRowHtml: 試合前の試合には⏰これからバッジを表示する', () => {
  const html = api.fixtureRowHtml({ id: 3, date: new Date().toISOString(), status: 'NS', home: { name: 'A' }, away: { name: 'B' }, score: null, venue: null });
  assert.ok(html.includes('is-upcoming'), 'is-upcomingクラスが付与されるはず');
});

// ---- ③ 90分ストーリー予想 ----
const anyPlayerKey = Object.keys(api.PLAYERS)[0];
const anyClub = api.PLAYERS[anyPlayerKey].club;
const realHomePlayers = api.registeredPlayersForClubJa(anyClub);

test('build90MinStoryHtml: 両クラブとも未登録の場合は何も生成しない(でっち上げない)', () => {
  const html = api.build90MinStoryHtml({ home: { name: 'X' }, away: { name: 'Y' } }, [], []);
  assert.strictEqual(html, '', '両者ともデータが無いなら空文字を返すはず');
});
test('build90MinStoryHtml: 片方だけ登録データがある場合は3フェーズの予想を生成し、その旨を明記する', () => {
  const html = api.build90MinStoryHtml({ home: { name: anyClub }, away: { name: '未登録クラブ' } }, realHomePlayers, []);
  assert.ok(html.includes('90分ストーリー予想'), '見出しが含まれるはず');
  assert.ok(html.includes('序盤') && html.includes('中盤') && html.includes('終盤'), '3フェーズすべて含まれるはず');
  assert.ok(html.includes('参考程度'), '片方のみのデータである旨が明記されるはず');
});
test('build90MinStoryHtml: 断定的な架空の出来事(具体的な得点シーン等)を書かない', () => {
  const html = api.build90MinStoryHtml({ home: { name: anyClub }, away: { name: '未登録クラブ' } }, realHomePlayers, []);
  // 「〜分に〜が得点しました」のような断定文が無いことを確認する簡易チェック
  assert.ok(!/\d+分に.+得点しました/.test(html), '架空の得点シーンを断定的に書いてはいけない');
});

// ---- ②④ 統合: buildLiveAnalysisHtml / buildFinishedAnalysisHtml の分岐が正しく機能する ----
test('buildLiveAnalysisHtml: LIVEバッジを表示し、「勝敗を分けた」のような結論めいた文言を含まない', () => {
  const analysis = {
    fixture: { home: { name: 'Man United' }, away: { name: 'Man City' }, league: 'Premier League', venue: 'Old Trafford', score: { home: 1, away: 0 } },
    homePlayers: [{ name: 'B. Fernandes', position: 'M', minutes: 30, rating: 7.2, goals: 1, assists: 0 }],
    awayPlayers: [],
    events: [{ minute: 12, team: 'Man United', player: 'B. Fernandes', type: 'Goal', detail: 'Normal Goal' }],
    elapsed: 30,
  };
  const html = api.buildLiveAnalysisHtml(analysis, 'standard');
  assert.ok(html.includes('LIVE'), 'LIVE表示が含まれるはず');
  assert.ok(!html.includes('何が勝敗を分けたか'), '試合中は「勝敗を分けた」という結論めいた文言を出してはいけない');
  assert.ok(html.includes('まだ結果は確定していません'), '「まだ結果は確定していない」旨の注記があるはず');
});

console.log(failures === 0 ? '\nAll fixtures-UI (優先順位②③④) tests PASSED.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
