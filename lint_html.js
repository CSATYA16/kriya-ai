const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  fs.writeFileSync('temp.js', scriptMatch[1]);
  try {
    new (require('vm').Script)(scriptMatch[1]);
    console.log("Syntax is OK!");
  } catch(e) {
    console.error(e);
  }
}
