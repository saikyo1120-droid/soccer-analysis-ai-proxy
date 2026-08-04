const fs = require('fs');
const src = fs.readFileSync('/tmp/soccer-analysis-ai/index.html', 'utf8');
console.log('file length:', src.length);
