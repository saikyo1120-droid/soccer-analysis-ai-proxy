/**
 * 2026年8月・優先順位⑤(今日の試合検索)のフロントエンド純粋関数テスト。
 * 「レアル」のような日本語で打つだけでクラブ名/リーグ名/国名から本日の試合を
 * 検索できること、日本語別名テーブル(FIXTURE_SEARCH_ALIASES)が正しく機能する
 * こと、監督名検索の結果(/api/coach-searchのレスポンス形)をマージするロジック
 * (mergeCoachMatchedFixtures)が正しく追加・重複排除できることを確認する。
 */
const fs = require('fs');
const assert = require('assert');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
const scriptStart = src.indexOf('<script>') + 8;
const scriptEnd = src.lastIndexOf('</script>');
let code = src.slice(scriptStart, scriptEnd);
code += `\nreturn { fixtureMatchesQuery, filterFixturesByQuery, mergeCoachMatchedFixtures, FIXTURE_SEARCH_ALIASES };`;

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

const fixtures = [
  { id: 1, home: { name: 'Real Madrid' }, away: { name: 'Sevilla' }, league: 'La Liga', country: 'Spain', status: 'NS' },
  { id: 2, home: { name: 'Manchester City' }, away: { name: 'Arsenal' }, league: 'Premier League', country: 'England', status: 'NS' },
  { id: 3, home: { name: 'Napoli' }, away: { name: 'Roma' }, league: 'Serie A', country: 'Italy', status: 'FT' },
  { id: 4, home: { name: 'Kashima Antlers' }, away: { name: 'Urawa Reds' }, league: 'J1 League', country: 'Japan', status: '1H' },
];

// ---- クエリ無し ----
test('fixtureMatchesQuery: クエリが空なら常にtrue', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[0], ''), true);
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[0], '   '), true);
});

// ---- 英語表記への直接部分一致 ----
test('fixtureMatchesQuery: 英語のクラブ名の部分一致でヒットする(大文字小文字を区別しない)', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[0], 'real'), true);
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[0], 'REAL'), true);
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[1], 'arsenal'), true);
});
test('fixtureMatchesQuery: リーグ名・国名の部分一致でもヒットする', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[1], 'premier'), true);
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[2], 'italy'), true);
});

// ---- 日本語別名(ご要望の「レアルと打つだけで検索できる」の核心) ----
test('fixtureMatchesQuery: 「レアル」と日本語で打つだけでReal Madridの試合がヒットする', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[0], 'レアル'), true);
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[1], 'レアル'), false, '無関係の試合はヒットしないはず');
});
test('fixtureMatchesQuery: 日本語のリーグ名別名(プレミアリーグ)でもヒットする', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[1], 'プレミアリーグ'), true);
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[1], 'プレミア'), true, '部分一致の別名でもヒットするはず');
});
test('fixtureMatchesQuery: 日本語の国名別名(イタリア)でもヒットする', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[2], 'イタリア'), true);
});
test('fixtureMatchesQuery: どこにも一致しないクエリはヒットしない(でっち上げてヒットさせない)', () => {
  assert.strictEqual(api.fixtureMatchesQuery(fixtures[0], 'まったく無関係なクエリ'), false);
});

// ---- filterFixturesByQuery ----
test('filterFixturesByQuery: 「レアル」で試合一覧全体を絞り込むと1件だけになる', () => {
  const result = api.filterFixturesByQuery(fixtures, 'レアル');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 1);
});
test('filterFixturesByQuery: 日本(国名)で絞り込むとJ1リーグの試合がヒットする', () => {
  const result = api.filterFixturesByQuery(fixtures, '日本');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 4);
});

// ---- 監督名検索のマージ(mergeCoachMatchedFixtures) ----
test('mergeCoachMatchedFixtures: 監督の所属チーム名から、通常検索でヒットしなかった試合を追加する', () => {
  const alreadyFiltered = []; // 「アンチェロッティ」というクエリでは通常検索は0件
  const merged = api.mergeCoachMatchedFixtures(fixtures, alreadyFiltered, ['Real Madrid']);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].id, 1);
});
test('mergeCoachMatchedFixtures: 既にフィルタ済みの試合は重複して追加しない', () => {
  const alreadyFiltered = [fixtures[0]];
  const merged = api.mergeCoachMatchedFixtures(fixtures, alreadyFiltered, ['Real Madrid']);
  assert.strictEqual(merged.length, 1, '既に含まれている試合が重複しないはず');
});
test('mergeCoachMatchedFixtures: 一致するチームが無ければ何も追加しない', () => {
  const alreadyFiltered = [];
  const merged = api.mergeCoachMatchedFixtures(fixtures, alreadyFiltered, ['Some Unrelated FC']);
  assert.strictEqual(merged.length, 0);
});
test('mergeCoachMatchedFixtures: 監督名検索の結果が空配列/未定義でも例外を投げない', () => {
  assert.strictEqual(api.mergeCoachMatchedFixtures(fixtures, [], []).length, 0);
  assert.strictEqual(api.mergeCoachMatchedFixtures(fixtures, [], undefined).length, 0);
});

// ---- 別名テーブル自体の健全性(欧州5大リーグを最低限カバーしているか) ----
test('FIXTURE_SEARCH_ALIASES: 欧州5大リーグの日本語名が最低限登録されている', () => {
  const jaNames = api.FIXTURE_SEARCH_ALIASES.map((a) => a.ja);
  ['プレミアリーグ', 'ラリーガ', 'ブンデスリーガ', 'セリエA', 'リーグアン'].forEach((name) => {
    assert.ok(jaNames.indexOf(name) !== -1, `${name}が別名テーブルに含まれているはず`);
  });
});

console.log(failures === 0 ? '\nAll fixture-search (優先順位⑤) tests PASSED.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
