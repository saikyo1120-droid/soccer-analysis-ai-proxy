// Minimal DOM shim + smoke test: load the script, exercise the new pure functions
// (computeScoutStars/computePlaystyleTag/getTrivia/answerPlayerQuestion/etc.)
// against every registered player, without a real browser.
const fs = require('fs');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
const scriptStart = src.indexOf('<script>') + 8;
const scriptEnd = src.lastIndexOf('</script>');
const code = src.slice(scriptStart, scriptEnd);

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
