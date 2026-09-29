const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const WEB_ROOT = path.join(__dirname, '.webrtc-webroot');
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 8888;

const server = http.createServer((req, res) => {
  console.log(`[proxy] ${req.method} ${req.url}`);

  // Proxy WHEP / signaling requests to GStreamer WebRTC server on port 8888
  if (req.url === '/whep' || req.url.startsWith('/whep?')) {
    const proxyReq = http.request({
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy error]', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: ' + err.message);
    });

    req.pipe(proxyReq);
    return;
  }

  // Serve static files from the WebRTC webroot
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Strip query parameters for local file path resolution
  filePath = filePath.split('?')[0];
  const fullPath = path.join(WEB_ROOT, filePath);

  // Security check to prevent directory traversal
  if (!fullPath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    let contentType = 'text/plain';
    if (fullPath.endsWith('.html')) contentType = 'text/html';
    else if (fullPath.endsWith('.js')) contentType = 'application/javascript';
    else if (fullPath.endsWith('.css')) contentType = 'text/css';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(fullPath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web/WHEP proxy server running on port ${PORT}`);
});
