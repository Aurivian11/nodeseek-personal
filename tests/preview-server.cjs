// Local-only visual fixture. It never contacts the real forum.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const port = Number(process.env.NSP_PREVIEW_PORT || 8765);
const routes = new Map([
  ['/', 'tests/preview.html'], ['/preview', 'tests/preview.html'],
  ...['00-core.js','15-profile-model.js','18-profile-actions.js','20-account.js','25-badges.js','28-inbox-entry.js','30-messages.js'].map(file => [`/src/${file}`,`src/${file}`])
]);
http.createServer((req,res)=>{
  const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  if (/^\/avatar\/\d+\.png$/.test(pathname)) {
    res.writeHead(200, {'Content-Type':'image/svg+xml'});
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="18" fill="#dceee5"/><circle cx="40" cy="31" r="14" fill="#4c9474"/><path d="M14 76c0-30 52-30 52 0" fill="#4c9474"/></svg>');return;
  }
  const file = routes.get(pathname);
  if(!file){res.writeHead(404);res.end('Not found');return;}
  res.writeHead(200, {'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});
  const source = fs.readFileSync(path.join(root,file), 'utf8');
  res.end(file === 'src/00-core.js' ? `const NSP_VERSION = ${JSON.stringify(version)};\n${source}` : source);
}).listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}/preview`));
