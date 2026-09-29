const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PORT = 3000;
const WEB_ROOT = path.join(__dirname, '.webrtc-webroot');
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 8888;

function checkBackendStatus(callback) {
  const socket = new net.Socket();
  let statusReported = false;

  socket.setTimeout(1000);

  socket.on('connect', () => {
    statusReported = true;
    socket.destroy();
    callback(null, true);
  });

  socket.on('timeout', () => {
    statusReported = true;
    socket.destroy();
    callback(null, false, 'Connection timed out');
  });

  socket.on('error', (err) => {
    if (!statusReported) {
      statusReported = true;
      callback(null, false, err.message);
    }
  });

  socket.connect(TARGET_PORT, TARGET_HOST);
}

const server = http.createServer((req, res) => {
  // Add permissive CORS headers for local/preview access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Status endpoint to check whether OBS GStreamer WebRTC daemon (port 8888) is listening
  if (req.url === '/api/status') {
    checkBackendStatus((err, isOnline, message) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        online: isOnline,
        targetHost: TARGET_HOST,
        targetPort: TARGET_PORT,
        message: isOnline ? 'GStreamer WebRTC server is listening' : (message || 'ECONNREFUSED'),
        timestamp: new Date().toISOString()
      }));
    });
    return;
  }

  // Proxy WHEP / signaling requests to GStreamer WebRTC server on port 8888
  if (req.url === '/whep' || req.url.startsWith('/whep?')) {
    const proxyReq = http.request({
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${TARGET_HOST}:${TARGET_PORT}`
      }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy error]', err.message);
      // NOTE: Do NOT use status 502, 503, or 504 here!
      // In this environment, NGINX intercepts 502/503/504 and serves warmup.html (HTML code).
      // We return 500 with application/json so client gets a clean, machine-readable offline status.
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'X-Stream-Status': 'offline'
      });
      res.end(JSON.stringify({
        error: 'GStreamer WebRTC backend offline: ' + err.message,
        code: 'STREAM_BACKEND_OFFLINE',
        targetHost: TARGET_HOST,
        targetPort: TARGET_PORT
      }));
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
    res.writeHead(403, { 'Content-Type': 'text/plain' });
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
    else if (fullPath.endsWith('.json')) contentType = 'application/json';
    else if (fullPath.endsWith('.svg')) contentType = 'image/svg+xml';
    else if (fullPath.endsWith('.png')) contentType = 'image/png';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(fullPath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web/WHEP proxy server running on port ${PORT}`);
});
