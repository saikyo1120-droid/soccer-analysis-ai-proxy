const fs = require('fs');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
const scriptStart = src.indexOf('<script>') + 8;
const scriptEnd = src.lastIndexOf('</script>');
const chunk = src.slice(scriptStart, scriptEnd);
try {
  new Function('document', 'window', chunk);
  console.log('Full script: syntactically valid');
} catch (e) {
  console.log('SYNTAX ERR:', e.message);
}
