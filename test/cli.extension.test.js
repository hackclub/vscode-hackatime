'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const vscode = require('vscode');
const { Dependencies } = require('../out/src/dependencies');
const { Options } = require('../out/src/options');
const { Hackatime } = require('../out/src/wakatime');

suite('wakatime-cli integration (extension host)', () => {
  const cliPath = process.env.WAKATIME_CLI_PATH;

  test('normalizes a Live Share heartbeat without losing its identity', async function () {
    if (!cliPath) this.skip();
    assert.ok(fs.existsSync(cliPath), `WAKATIME_CLI_PATH does not exist: ${cliPath}`);

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-cli-test-'));
    const workspace = path.join(tempHome, 'live-share-workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      path.join(tempHome, '.wakatime.cfg'),
      '[settings]\n' +
        'api_key = 00000000-0000-4000-8000-000000000000\n' +
        'debug = true\n' +
        'heartbeat_rate_limit_seconds = 0\n' +
        'sync_ai_disabled = true\n',
    );

    const oldEnv = {
      HOME: process.env.HOME,
      WAKATIME_HOME: process.env.WAKATIME_HOME,
      HACKATIME_API_KEY: process.env.HACKATIME_API_KEY,
      WAKATIME_API_URL: process.env.WAKATIME_API_URL,
    };
    let registration;
    let server;
    let snapshot;
    const logs = [];

    try {
      process.env.HOME = tempHome;
      process.env.WAKATIME_HOME = tempHome;
      delete process.env.HACKATIME_API_KEY;

      await vscode.workspace.updateWorkspaceFolders(
        0,
        vscode.workspace.workspaceFolders?.length || 0,
        {
          uri: vscode.Uri.file(workspace),
          name: 'Live Share Workspace',
        },
      );

      registration = vscode.workspace.registerTextDocumentContentProvider('vsls-scc', {
        provideTextDocumentContent: () => 'const shared: string = "Live Share";\n',
      });
      const uri = vscode.Uri.parse('vsls-scc://session-id/project/src/shared.ts');
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);

      const request = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const chunks = [];
          req.on('data', (chunk) => chunks.push(chunk));
          req.on('error', reject);
          req.on('end', () => {
            try {
              let body = Buffer.concat(chunks);
              if (req.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
              const payload = JSON.parse(body.toString('utf8'));
              res.writeHead(201, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ responses: payload.map(() => [{}, 201]) }));
              resolve(payload);
            } catch (error) {
              reject(error);
            }
          });
        });
        server.listen(0, '127.0.0.1', () => {
          process.env.WAKATIME_API_URL = `http://127.0.0.1:${server.address().port}`;
        });
      });
      await new Promise((resolve) => server.once('listening', resolve));

      const logger = {
        debug: (message) => logs.push(String(message)),
        debugException: (error) => logs.push(String(error)),
        error: (message) => logs.push(String(message)),
        warn: (message) => logs.push(String(message)),
      };
      const options = new Options(logger, tempHome);
      const dependencies = new Dependencies(options, logger, tempHome);
      dependencies.cliLocation = cliPath;
      const harness = Object.create(Hackatime.prototype);
      Object.assign(harness, {
        dependencies,
        options,
        logger,
        editorName: 'Visual Studio Code',
        extension: { version: 'test' },
        heartbeats: [],
        lineChanges: { ai: {}, human: {} },
        filesWithHumanTyping: {},
        dedupe: {},
        lastSent: Date.now(),
        lastCodeReviewing: false,
        showStatusBar: false,
        isMetricsEnabled: false,
        maybePromptForMissingGitRepo: async () => {},
        sendHeartbeatsIfNecessary: async () => {},
      });

      await harness.appendHeartbeat(
        document,
        Date.now(),
        new vscode.Position(0, 0),
        false,
        false,
        false,
        false,
      );
      assert.strictEqual(harness.heartbeats.length, 1);
      snapshot = harness.heartbeats[0].local_file;
      assert.ok(snapshot.endsWith('.ts'), `snapshot did not retain .ts suffix: ${snapshot}`);
      assert.ok(fs.existsSync(snapshot), 'snapshot was not created');

      await harness._sendHeartbeats();
      const posted = await Promise.race([
        request,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`CLI request timed out\n${logs.join('\n')}`)), 10_000),
        ),
      ]);
      const heartbeat = Array.isArray(posted) ? posted[0] : posted;
      assert.strictEqual(heartbeat.entity, '/__liveshare__/session-id/project/src/shared.ts');
      assert.strictEqual(heartbeat.project, 'Live Share Workspace');
      assert.strictEqual(heartbeat.language, 'TypeScript');

      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const check = () => {
          if (!fs.existsSync(snapshot)) return resolve();
          if (Date.now() >= deadline)
            return reject(new Error(`snapshot was not cleaned up: ${snapshot}`));
          setTimeout(check, 25);
        };
        check();
      });
    } catch (error) {
      error.message += `\nCLI debug output:\n${logs.join('\n')}`;
      const logFile = path.join(tempHome, '.wakatime', 'wakatime.log');
      if (fs.existsSync(logFile))
        error.message += `\nCLI log:\n${fs.readFileSync(logFile, 'utf8')}`;
      throw error;
    } finally {
      registration?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      if (server) await new Promise((resolve) => server.close(resolve));
      if (snapshot && fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
      await vscode.workspace.updateWorkspaceFolders(
        0,
        vscode.workspace.workspaceFolders?.length || 0,
      );
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
