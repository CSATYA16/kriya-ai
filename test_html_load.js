const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
});

server.listen(3000, () => {
  console.log("Mock HTTP running on 3000");
  
  // now run puppeteer or just standard fetch
  import('puppeteer').then(async puppeteer => {
     const browser = await puppeteer.launch();
     const page = await browser.newPage();
     page.on('console', m => console.log('BROWSER LOG:', m.text()));
     page.on('pageerror', e => console.log('BROWSER ERR:', e));
     await page.goto('http://127.0.0.1:3000');
     await browser.close();
     server.close();
     console.log("Done checking!");
  }).catch(e => {
     console.log("No puppeteer available, can't verify browser.");
     server.close();
  });
});
