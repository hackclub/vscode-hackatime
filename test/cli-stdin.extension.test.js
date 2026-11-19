'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hackatime } = require('../out/src/wakatime');

// wakatime-cli can exit before it reads the extra heartbeats on stdin (a crash, an old
// build, a bad flag). writing to that closed pipe must not throw out of the extension.
suite('wakatime-cli exits without reading stdin', function () {
  let dir, record, warnings;

  setup(function () {
    if (process.platform === 'win32') this.skip();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-stdin-'));
    record = path.join(dir, 'calls.txt');
    warnings = [];
  });

  teardown(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // never reads stdin, just records that it ran and exits
  const fakeCli = () => {
    const file = path.join(dir, 'cli');
    fs.writeFileSync(
      file,
      '#!/bin/sh\n' +
        'if [ "$1" = "--help" ]; then echo "  --sync-ai-disabled"; exit 0; fi\n' +
        `printf '%s\\n' "$@" > '${record}'\n` +
        'exit 0\n',
    );
    fs.chmodSync(file, 0o755);
    return file;
  };

  const harness = (heartbeats) => {
    const cli = fakeCli();
    const h = Object.create(Hackatime.prototype);
    Object.assign(h, {
      cliFlagSupport: {},
      dependencies: { isCliInstalled: () => true, getCliLocation: () => cli },
      options: {
        getApiKey: async () => '',
        getApiUrl: async () => 'http://127.0.0.1:9/api',
        getConfigFile: () => path.join(dir, '.wakatime.cfg'),
        getLogFile: () => path.join(dir, 'wakatime.log'),
      },
      logger: {
        debug: () => {},
        debugException: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
      },
      editorName: 'vscode',
      extension: { version: 'test' },
      heartbeats,
      lastSent: 0,
      showStatusBar: false,
      isMetricsEnabled: false,
      isAiTranscriptSyncEnabled: () => false,
    });
    return h;
  };

  const sendAndSettle = async (h) => {
    await h._sendHeartbeats();
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(record)) {
      if (Date.now() > deadline) throw new Error('the fake cli was never called');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // give a broken pipe time to surface as an uncaught error, which mocha would pin here
    await new Promise((resolve) => setTimeout(resolve, 500));
  };

  test('a big extra heartbeats payload does not throw EPIPE, and the loss is a warning', async () => {
    // far more than a pipe buffer holds, so the write is still pending when the cli exits
    const long = 'x'.repeat(2000);
    const heartbeats = Array.from({ length: 300 }, (_, i) => ({
      entity: path.join(dir, `${long}-${i}.ts`),
      time: 1795000000 + i,
      is_write: false,
    }));
    await sendAndSettle(harness(heartbeats));
    const args = fs.readFileSync(record, 'utf8').split('\n');
    assert.ok(args.includes('--extra-heartbeats'), args.join(' '));
    assert.ok(
      warnings.some((w) => w.includes('before reading 299 extra heartbeats')),
      JSON.stringify(warnings),
    );
  });

  test('a single heartbeat with no extras does not throw either', async () => {
    await sendAndSettle(
      harness([{ entity: path.join(dir, 'a.ts'), time: 1795000000, is_write: false }]),
    );
    const args = fs.readFileSync(record, 'utf8').split('\n');
    assert.ok(!args.includes('--extra-heartbeats'), args.join(' '));
    assert.deepStrictEqual(warnings, []);
  });
});
