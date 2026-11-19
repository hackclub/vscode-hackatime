'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hackatime } = require('../out/src/wakatime');

// these tests never run a real wakatime-cli: a fake script records the arguments it gets,
// so nothing can read real AI transcripts
suite('AI transcript sync is opt-in', function () {
  let dir, record;

  setup(function () {
    if (process.platform === 'win32') this.skip();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-aisync-'));
    record = path.join(dir, 'calls.txt');
  });

  teardown(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // a fake cli whose --help does or doesn't list --sync-ai-disabled, like old builds
  const fakeCli = (knowsFlag) => {
    const file = path.join(dir, knowsFlag ? 'cli-new' : 'cli-old');
    fs.writeFileSync(
      file,
      '#!/bin/sh\n' +
        'if [ "$1" = "--help" ]; then\n' +
        (knowsFlag ? '  echo "  --sync-ai-disabled   Disable parsing AI transcript logs"\n' : '') +
        '  echo "  --entity string"; exit 0\n' +
        'fi\n' +
        `printf '%s\\n' "$@" >> '${record}'\n` +
        `echo '---' >> '${record}'\n` +
        'exit 0\n',
    );
    fs.chmodSync(file, 0o755);
    return file;
  };

  const calls = () =>
    fs.existsSync(record)
      ? fs
          .readFileSync(record, 'utf8')
          .split('---\n')
          .filter(Boolean)
          .map((c) => c.trim().split('\n'))
      : [];

  const waitForCall = async () => {
    const deadline = Date.now() + 5000;
    while (calls().length === 0) {
      if (Date.now() > deadline) throw new Error('the fake cli was never called');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return calls()[0];
  };

  const harness = (cli, overrides = {}) => {
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
      logger: { debug: () => {}, debugException: () => {}, warn: () => {}, error: () => {} },
      editorName: 'vscode',
      extension: { version: 'test' },
      heartbeats: [{ entity: path.join(dir, 'a.ts'), time: 1795000000, is_write: false }],
      lastSent: 0,
      showStatusBar: false,
      isMetricsEnabled: false,
      ...overrides,
    });
    return h;
  };

  test('off by default: heartbeats tell the cli to skip transcripts', async () => {
    // the real setting lookup, which is unset in the test instance, so this is the default
    const h = harness(fakeCli(true));
    assert.strictEqual(h.isAiTranscriptSyncEnabled(), false);
    await h._sendHeartbeats();
    const args = await waitForCall();
    assert.ok(args.includes('--sync-ai-disabled'), args.join(' '));
  });

  test('turned on: heartbeats leave transcript parsing to the cli', async () => {
    const h = harness(fakeCli(true), { isAiTranscriptSyncEnabled: () => true });
    await h._sendHeartbeats();
    const args = await waitForCall();
    assert.ok(!args.includes('--sync-ai-disabled'), args.join(' '));
  });

  test('old clis without the flag still get working heartbeats', async () => {
    const h = harness(fakeCli(false));
    await h._sendHeartbeats();
    const args = await waitForCall();
    assert.ok(args.includes('--entity'), args.join(' '));
    assert.ok(!args.includes('--sync-ai-disabled'), args.join(' '));
  });

  test('off by default: --sync-ai-activity never runs', async () => {
    const h = harness(fakeCli(true));
    h.syncAIHeartbeatsDebounced();
    assert.strictEqual(h.syncAIHeartbeatsDebounce, undefined, 'a sync was scheduled');
    await h.syncAIHeartbeats();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepStrictEqual(calls(), []);
  });

  test('turned on: --sync-ai-activity runs again', async () => {
    const h = harness(fakeCli(true), { isAiTranscriptSyncEnabled: () => true });
    await h.syncAIHeartbeats();
    const args = await waitForCall();
    assert.strictEqual(args[0], '--sync-ai-activity');
  });
});
