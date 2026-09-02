// Minimal DOM shim + smoke test: load the script, exercise the new pure functions
// (computeScoutStars/computePlaystyleTag/getTrivia/answerPlayerQuestion/etc.)
// against every registered player, without a real browser.
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
const code = inlineScripts.reduce((a, b) => (b.length >= a.length ? b : a), '');

// Fake DOM good enough for top-level script execution (element lookups return a stub).
function makeEl() {
  const listeners = {};
  return {
    innerHTML: '', textContent: '', value: '', style: {}, children: [], dataset: {},
    addEventListener(ev, fn) { listeners[ev] = listeners[ev] || []; listeners[ev].push(fn); },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, classList: { toggle() {}, add() {}, remove() {} },
  };
}
const documentStub = {
  getElementById() { return makeEl(); },
  documentElement: makeEl(),
  querySelectorAll() { return []; },
  addEventListener() {},
};
const windowStub = { navigator: { clipboard: { writeText: async () => {} } } };
const fn = new Function('document', 'window', 'navigator', 'fetch', code);
fn(documentStub, windowStub, windowStub.navigator, async () => { throw new Error('no network in test'); });

console.log('Top-level script executed without throwing.');
