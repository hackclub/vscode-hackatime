'use strict';

const assert = require('assert');
const child_process = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { downloadToFile, getJson } = require('../out/src/http-get');

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
// keep-alive connections (and raw proxy tunnels) would keep close() waiting forever
const sockets = new Set();
const track = (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
};
const close = (server) => {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
};

suite('http-get (replaces request)', () => {
  let server, other, proxy, base, otherBase, proxyUrl, seen, tunnels, dir;

  suiteSetup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-http-'));
    seen = [];
    other = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('from the other host');
    });
    otherBase = `http://127.0.0.1:${await listen(other)}`;

    server = http.createServer((req, res) => {
      seen.push({ url: req.url, ua: req.headers['user-agent'] });
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tag_name: 'v2.28.4' }));
      }
      if (req.url === '/relative') {
        res.writeHead(302, { Location: '/json' });
        return res.end();
      }
      if (req.url === '/cross-host') {
        res.writeHead(302, { Location: `${otherBase}/file.zip` });
        return res.end();
      }
      if (req.url === '/loop') {
        res.writeHead(302, { Location: '/loop' });
        return res.end();
      }
      res.writeHead(404);
      res.end('nope');
    });
    base = `http://127.0.0.1:${await listen(server)}`;

    // a minimal CONNECT proxy that records every tunnel it opens
    tunnels = [];
    proxy = http.createServer((req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on('connect', (req, client, head) => {
      tunnels.push(req.url);
      track(client);
      const [host, port] = req.url.split(':');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      track(upstream);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });

  suiteTeardown(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(server), close(other), close(proxy)]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  setup(() => {
    seen.length = 0;
    tunnels.length = 0;
  });

  test('getJson parses the body and sends headers', async () => {
    const { status, body } = await getJson(`${base}/json`, {
      headers: { 'User-Agent': 'hackatime-test' },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.tag_name, 'v2.28.4');
    assert.strictEqual(seen[0].ua, 'hackatime-test');
  });

  test('follows relative redirects', async () => {
    const { status, body } = await getJson(`${base}/relative`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.tag_name, 'v2.28.4');
  });

  test('downloads across a redirect to another host, like github releases', async () => {
    const file = path.join(dir, 'cli.zip');
    await downloadToFile(`${base}/cross-host`, file);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'from the other host');
  });

  test('a failed download rejects and leaves no file behind', async () => {
    const file = path.join(dir, 'missing.zip');
    await assert.rejects(downloadToFile(`${base}/missing`, file), /status 404/);
    assert.strictEqual(fs.existsSync(file), false);
  });

  test('redirect loops give up', async () => {
    await assert.rejects(getJson(`${base}/loop`, { maxRedirects: 3 }), /Too many redirects/);
  });

  test('a server that never answers times out instead of hanging', async () => {
    // accepts the connection but never says anything back
    const silent = net.createServer(() => {});
    const port = await listen(silent);
    try {
      await assert.rejects(
        getJson(`http://127.0.0.1:${port}/`, { idleTimeoutMs: 500 }),
        /Timed out/,
      );
    } finally {
      silent.close();
    }
  });

  test('the proxy setting tunnels requests through the proxy', async () => {
    const { body } = await getJson(`${base}/json`, { proxy: proxyUrl });
    assert.strictEqual(body.tag_name, 'v2.28.4');
    assert.deepStrictEqual(tunnels, [base.replace('http://', '')]);
  });

  suite('self-signed https', () => {
    let tls, tlsBase;

    suiteSetup(async function () {
      const key = path.join(dir, 'key.pem');
      const cert = path.join(dir, 'cert.pem');
      const made = child_process.spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ]);
      if (made.status !== 0) this.skip();
      tls = https.createServer(
        { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
        (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        },
      );
      tlsBase = `https://127.0.0.1:${await listen(tls)}`;
    });

    suiteTeardown(async () => {
      if (tls) await close(tls);
    });

    test('certificates are checked by default', async () => {
      await assert.rejects(getJson(`${tlsBase}/`), /self[- ]signed|certificate/i);
    });

    test('no_ssl_verify (strictSSL false) accepts them', async () => {
      const { body } = await getJson(`${tlsBase}/`, { strictSSL: false });
      assert.strictEqual(body.ok, true);
    });

    test('no_ssl_verify also applies through the proxy', async () => {
      await assert.rejects(getJson(`${tlsBase}/`, { proxy: proxyUrl }));
      const { body } = await getJson(`${tlsBase}/`, { proxy: proxyUrl, strictSSL: false });
      assert.strictEqual(body.ok, true);
      assert.ok(tunnels.length >= 1);
    });
  });
});
