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

  test('a hanging flag check still tells the cli to skip transcripts', async () => {
    const cli = path.join(dir, 'cli-hangs');
    fs.writeFileSync(
      cli,
      '#!/bin/sh\n' +
        'if [ "$1" = "--help" ]; then exec sleep 30; fi\n' +
        `printf '%s\\n' "$@" >> '${record}'\n` +
        `echo '---' >> '${record}'\n` +
        'exit 0\n',
    );
    fs.chmodSync(cli, 0o755);
    const h = harness(cli, { cliProbeTimeoutMs: 300 });
    await h._sendHeartbeats();
    const args = await waitForCall();
    assert.ok(args.includes('--sync-ai-disabled'), args.join(' '));
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

// the --help check decides whether heartbeats can pass --sync-ai-disabled, so a broken
// check must never get stuck on "no" (that would let the cli read transcripts)
suite('wakatime-cli flag check', function () {
  const FLAG = '--sync-ai-disabled';
  let dir, cli;

  setup(function () {
    if (process.platform === 'win32') this.skip();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-flagcheck-'));
    cli = path.join(dir, 'wakatime-cli');
  });

  teardown(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeCli = (body) => {
    fs.writeFileSync(cli, '#!/bin/sh\n' + body);
    fs.chmodSync(cli, 0o755);
  };
  const knowsFlag = () => writeCli(`echo "  ${FLAG}   Disable parsing AI transcript logs"\n`);
  const doesNotKnowFlag = () => writeCli('echo "  --entity string"\n');

  const harness = (timeoutMs) => {
    const h = Object.create(Hackatime.prototype);
    Object.assign(h, {
      logger: { debug: () => {}, debugException: () => {}, warn: () => {}, error: () => {} },
      cliProbeTimeoutMs: timeoutMs,
    });
    return h;
  };

  test('a missing binary (mid update) counts as supported and is checked again', async () => {
    const h = harness();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), true);
    doesNotKnowFlag();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false);
  });

  test('a hanging --help times out, counts as supported and is checked again', async () => {
    writeCli('exec sleep 30\n');
    const h = harness(300);
    const started = Date.now();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), true);
    assert.ok(Date.now() - started < 5000, 'the check did not time out');
    doesNotKnowFlag();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false);
  });

  test('help printed with a non-zero exit is still an answer, and is cached', async () => {
    writeCli('echo "  --entity string"\nexit 1\n');
    const h = harness();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false);
    knowsFlag();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false, 'should be cached');
  });

  test('a timeout counts as no answer even if some help was printed', async () => {
    writeCli('echo "  --entity string"\nexec sleep 30\n');
    const h = harness(300);
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), true);
    doesNotKnowFlag();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false, 'should have asked again');
  });

  test('a clean answer is cached until the cli is installed again', async () => {
    doesNotKnowFlag();
    const h = harness();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false);
    knowsFlag(); // an update replaced the binary in place
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), false, 'should still be cached');
    h.forgetCliFlagSupport();
    assert.strictEqual(await h.cliSupportsFlag(cli, FLAG), true);
  });

  test('the cache is cleared once the cli install or update finishes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'wakatime.ts'), 'utf8');
    assert.match(src, /checkAndInstallCli\(\(\) => \{\s*this\.forgetCliFlagSupport\(\);/);
  });
});

suite('"Hackatime: AI Transcript Sync" command', () => {
  const vscode = require('vscode');
  let original, picked, shownItems, placeHolder, updates, current;

  setup(() => {
    original = {
      pick: vscode.window.showQuickPick,
      info: vscode.window.showInformationMessage,
      config: vscode.workspace.getConfiguration,
    };
    updates = [];
    current = undefined; // unset, like a fresh install
    vscode.window.showQuickPick = async (items, opts) => {
      shownItems = items;
      placeHolder = opts.placeHolder;
      return items.find((i) => i.label === picked);
    };
    vscode.window.showInformationMessage = async () => undefined;
    vscode.workspace.getConfiguration = () => ({
      get: (key) => (key === 'hackatime.aiTranscriptSync.enabled' ? current : undefined),
      update: async (key, value) => {
        updates.push([key, value]);
        current = value;
      },
    });
  });

  teardown(() => {
    vscode.window.showQuickPick = original.pick;
    vscode.window.showInformationMessage = original.info;
    vscode.workspace.getConfiguration = original.config;
  });

  const harness = () => Object.create(Hackatime.prototype);

  test('shows the current state and enabling flips the setting', async () => {
    picked = 'Enable';
    await harness().promptAiTranscriptSync();
    assert.ok(placeHolder.includes('currently disabled'), placeHolder);
    assert.strictEqual(shownItems.find((i) => i.label === 'Disable').description, '(current)');
    assert.deepStrictEqual(updates, [['hackatime.aiTranscriptSync.enabled', true]]);
  });

  test('disabling turns it back off', async () => {
    current = true;
    picked = 'Disable';
    await harness().promptAiTranscriptSync();
    assert.ok(placeHolder.includes('currently enabled'), placeHolder);
    assert.deepStrictEqual(updates, [['hackatime.aiTranscriptSync.enabled', false]]);
  });

  test('picking the current state or closing the picker changes nothing', async () => {
    picked = 'Disable';
    await harness().promptAiTranscriptSync();
    picked = undefined;
    await harness().promptAiTranscriptSync();
    assert.deepStrictEqual(updates, []);
  });

  test('the manifest lists the command, hides it on web and defaults the setting to off', () => {
    const pkg = require('../package.json');
    const command = pkg.contributes.commands.find(
      (c) => c.command === 'hackatime.ai_transcript_sync',
    );
    assert.strictEqual(command.title, 'Hackatime: AI Transcript Sync');
    const palette = pkg.contributes.menus.commandPalette.find(
      (m) => m.command === 'hackatime.ai_transcript_sync',
    );
    assert.strictEqual(palette.when, '!isWeb');
    assert.strictEqual(
      pkg.contributes.configuration.properties['hackatime.aiTranscriptSync.enabled'].default,
      false,
    );
  });
});
