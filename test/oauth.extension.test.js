'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const net = require('net');
const vscode = require('vscode');
const { Hackatime } = require('../out/src/wakatime');
const { Utils } = require('../out/src/utils');

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// resolves { status, body }, or { error } when nothing is listening
const get = (port, query, pathname = '/callback') =>
  new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: `${pathname}?${query}`, agent: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', (error) => resolve({ error }));
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// the browser and the token exchange are stubbed, so nothing here talks to Hackatime
suite('OAuth login (extension host)', () => {
  let original, opened, exchanged, errors, h, port;

  setup(async () => {
    original = {
      info: vscode.window.showInformationMessage,
      err: vscode.window.showErrorMessage,
    };
    opened = [];
    exchanged = [];
    errors = [];
    vscode.window.showInformationMessage = async () => 'Open Browser';
    vscode.window.showErrorMessage = async (msg) => {
      errors.push(msg);
      return undefined;
    };
    port = await freePort();
    h = harness();
  });

  teardown(() => {
    h?.closeCallbackServer();
    vscode.window.showInformationMessage = original.info;
    vscode.window.showErrorMessage = original.err;
  });

  function harness(overrides = {}) {
    const x = Object.create(Hackatime.prototype);
    Object.assign(x, {
      oauthPort: port,
      httpServer: null,
      logger: { debug: () => {}, warn: () => {}, error: () => {}, debugException: () => {} },
      openBrowser: (url) => opened.push(new URL(url)),
      exchangeCodeForApiKey: async (code, codeVerifier) => exchanged.push({ code, codeVerifier }),
      ...overrides,
    });
    return x;
  }

  const lastState = () => opened[opened.length - 1].searchParams.get('state');

  test('the browser goes to Hackatime with a state and a PKCE challenge', async () => {
    await h.loginWithHackatime();
    assert.strictEqual(opened.length, 1);
    const url = opened[0];
    assert.strictEqual(url.origin + url.pathname, 'https://hackatime.hackclub.com/oauth/authorize');
    const q = url.searchParams;
    assert.strictEqual(q.get('redirect_uri'), `http://localhost:${port}/callback`);
    assert.strictEqual(q.get('response_type'), 'code');
    assert.strictEqual(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('state').length >= 16, q.get('state'));
    assert.ok(q.get('code_challenge'));

    const res = await get(port, `code=good&state=${encodeURIComponent(lastState())}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(exchanged.length, 1);
    assert.strictEqual(exchanged[0].code, 'good');
    const challenge = crypto
      .createHash('sha256')
      .update(exchanged[0].codeVerifier)
      .digest('base64url');
    assert.strictEqual(challenge, q.get('code_challenge'));
  });

  test('the server closes once the login is done', async () => {
    await h.loginWithHackatime();
    await get(port, `code=good&state=${encodeURIComponent(lastState())}`);
    assert.strictEqual(h.httpServer, null);
    await sleep(50);
    assert.ok((await get(port, 'code=again')).error, 'still listening');
  });

  test('a callback without this attempt’s state is turned away and the login keeps waiting', async () => {
    await h.loginWithHackatime();
    for (const query of ['code=evil', 'code=evil&state=nope', 'error=access_denied']) {
      const res = await get(port, query);
      assert.strictEqual(res.status, 400, query);
      assert.match(res.body, /out of date or was not started by your editor/);
    }
    assert.deepStrictEqual(exchanged, []);

    const res = await get(port, `code=good&state=${encodeURIComponent(lastState())}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      exchanged.map((e) => e.code),
      ['good'],
    );
  });

  test('other paths get a 404', async () => {
    await h.loginWithHackatime();
    const res = await get(
      port,
      `code=good&state=${encodeURIComponent(lastState())}`,
      '/favicon.ico',
    );
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(exchanged, []);
  });

  test('a denied login closes the server without exchanging anything', async () => {
    await h.loginWithHackatime();
    const res = await get(port, `error=access_denied&state=${encodeURIComponent(lastState())}`);
    assert.strictEqual(res.status, 400);
    assert.match(res.body, /access_denied/);
    assert.deepStrictEqual(exchanged, []);
    assert.strictEqual(h.httpServer, null);
  });

  test('logging in twice reuses the server and only the newest attempt counts', async () => {
    await h.loginWithHackatime();
    const first = lastState();
    await h.loginWithHackatime();
    const second = lastState();
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(opened.length, 2);
    assert.notStrictEqual(first, second);

    assert.strictEqual(
      (await get(port, `code=old&state=${encodeURIComponent(first)}`)).status,
      400,
    );
    assert.strictEqual(
      (await get(port, `code=new&state=${encodeURIComponent(second)}`)).status,
      200,
    );
    assert.deepStrictEqual(
      exchanged.map((e) => e.code),
      ['new'],
    );
  });

  test('an unfinished login gives the port back after the idle timeout', async () => {
    h = harness({ oauthIdleTimeoutMs: 200 });
    await h.loginWithHackatime();
    await sleep(400);
    assert.strictEqual(h.httpServer, null);
    assert.ok((await get(port, 'code=late')).error, 'still listening');
    // and a new login can use the port again
    await h.loginWithHackatime();
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(h.httpServer.listening, true);
  });

  test('a port that is taken shows an error and opens no browser', async () => {
    const blocker = net.createServer().listen(port);
    await new Promise((resolve) => blocker.once('listening', resolve));
    try {
      await h.loginWithHackatime();
      assert.deepStrictEqual(errors, ['Failed to start OAuth callback server']);
      assert.deepStrictEqual(opened, []);
      assert.strictEqual(h.httpServer, null);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

suite('OAuth token exchange', () => {
  test('sends the PKCE verifier along with the code', async () => {
    let body;
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        body = new URLSearchParams(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'tok' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address();
      const token = await Utils.exchangeCodeForToken(
        `http://127.0.0.1:${port}`,
        'the-code',
        'http://localhost:54321/callback',
        'the-verifier',
      );
      assert.strictEqual(token, 'tok');
      assert.strictEqual(body.get('code'), 'the-code');
      assert.strictEqual(body.get('code_verifier'), 'the-verifier');
      assert.strictEqual(body.get('grant_type'), 'authorization_code');
      assert.ok(body.get('client_id'));
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
