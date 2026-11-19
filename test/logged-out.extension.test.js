'use strict';

const assert = require('assert');
const child_process = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const {
  describeSavedActivity,
  savedActivityPrompt,
  SAVED_ACTIVITY_ADD,
  SAVED_ACTIVITY_DISCARD,
} = require('../out/src/saved-activity');
const {
  discardOfflineQueue,
  getOfflineCount,
  getOfflineQueueFile,
  getOfflineTimes,
} = require('../out/src/offline-queue');
const { Hackatime } = require('../out/src/wakatime');
const { Options } = require('../out/src/options');
const { Dependencies } = require('../out/src/dependencies');
const { Hackatime: WebHackatime } = require('../out/src/web/wakatime');

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime() / 1000;

// swaps vscode.window message functions for the length of a test
function stubMessages(choices = {}) {
  const shown = [];
  const original = {
    warn: vscode.window.showWarningMessage,
    info: vscode.window.showInformationMessage,
    error: vscode.window.showErrorMessage,
  };
  vscode.window.showWarningMessage = async (message, ...rest) => {
    shown.push({ kind: 'warning', message, rest });
    return choices.warning;
  };
  vscode.window.showInformationMessage = async (message, ...rest) => {
    shown.push({ kind: 'info', message, rest });
    return choices.info;
  };
  vscode.window.showErrorMessage = async (message, ...rest) => {
    shown.push({ kind: 'error', message, rest });
    return undefined;
  };
  shown.restore = () => {
    vscode.window.showWarningMessage = original.warn;
    vscode.window.showInformationMessage = original.info;
    vscode.window.showErrorMessage = original.error;
  };
  return shown;
}

suite('saved activity wording', () => {
  const now = new Date(2026, 10, 19, 18, 0);

  test('same day shows a time range', () => {
    const text = describeSavedActivity([at(2026, 10, 19, 14, 10), at(2026, 10, 19, 16, 30)], now);
    assert.ok(text.startsWith('today from '), text);
    assert.ok(text.includes(' to '), text);
  });

  test('a single moment uses "at"', () => {
    assert.ok(describeSavedActivity([at(2026, 10, 18, 9, 5)], now).startsWith('yesterday at '));
  });

  test('ranges across days name both days', () => {
    const text = describeSavedActivity([at(2026, 10, 17, 14, 10), at(2026, 10, 19, 16, 30)], now);
    assert.ok(text.startsWith('from '), text);
    assert.ok(text.includes('today'), text);
  });

  test('no usable times falls back to plain wording', () => {
    assert.strictEqual(describeSavedActivity([], now), 'from before you logged in');
    assert.strictEqual(describeSavedActivity([NaN, 0], now), 'from before you logged in');
  });

  test('the prompt mentions the count and the shared computer case', () => {
    const one = savedActivityPrompt(1, [at(2026, 10, 19, 14, 10)], now);
    assert.ok(one.message.startsWith('Add coding activity saved today at '), one.message);
    assert.ok(one.detail.includes('1 heartbeat '), one.detail);
    const many = savedActivityPrompt(12, [], now);
    assert.ok(many.detail.includes('12 heartbeats'), many.detail);
    assert.ok(many.detail.includes(SAVED_ACTIVITY_DISCARD), many.detail);
  });
});

suite('desktop: logged out heartbeats (extension host)', function () {
  const cliPath = process.env.WAKATIME_CLI_PATH;
  let home, oldEnv, cliOptions;

  // makes keyless heartbeats the same way the extension does, so they land in the queue
  const queueKeyless = (times) => {
    const file = path.join(home, 'a.ts');
    fs.writeFileSync(file, 'const a = 1;\n');
    for (const t of times) {
      child_process.spawnSync(
        cliPath,
        ['--entity', file, '--time', String(t), '--plugin', 'vscode/1.0 vscode-hackatime/test'],
        cliOptions,
      );
    }
  };

  setup(function () {
    if (!cliPath) {
      // CI downloads a pinned cli, so a missing path there is a broken setup, not a skip
      if (process.env.CI) throw new Error('WAKATIME_CLI_PATH must be set in CI');
      this.skip();
    }
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-loggedout-')));
    // nothing can leave the machine: there's no key, and the api url is a dead local port
    fs.writeFileSync(
      path.join(home, '.wakatime.cfg'),
      '[settings]\napi_url = http://127.0.0.1:9/api\n',
    );
    oldEnv = { HOME: process.env.HOME, WAKATIME_HOME: process.env.WAKATIME_HOME };
    process.env.HOME = home;
    process.env.WAKATIME_HOME = home;
    cliOptions = { env: { ...process.env } };
  });

  teardown(() => {
    if (!oldEnv) return;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    oldEnv = undefined;
  });

  test('the queue helpers read, locate and clear the cli queue', async () => {
    queueKeyless([1795003600, 1795000000]);
    assert.strictEqual(await getOfflineCount(cliPath, cliOptions), 2);
    assert.deepStrictEqual(await getOfflineTimes(cliPath, 2, cliOptions), [1795000000, 1795003600]);
    assert.strictEqual(
      getOfflineQueueFile(cliOptions.env),
      path.join(home, 'offline_heartbeats.bdb'),
    );
    assert.ok(fs.existsSync(getOfflineQueueFile(cliOptions.env)));

    await discardOfflineQueue(cliPath, cliOptions);
    assert.strictEqual(await getOfflineCount(cliPath, cliOptions), 0);
  });

  test('sending without a key queues heartbeats instead of prompting', async () => {
    const shown = stubMessages();
    try {
      const logger = {
        debug: () => {},
        debugException: () => {},
        warnException: () => {},
        error: () => {},
        warn: () => {},
      };
      const options = new Options(logger, home);
      const dependencies = new Dependencies(options, logger, home);
      dependencies.cliLocation = cliPath;
      const harness = Object.create(Hackatime.prototype);
      Object.assign(harness, {
        dependencies,
        options,
        logger,
        editorName: 'Visual Studio Code',
        extension: { version: 'test' },
        heartbeats: [{ entity: path.join(home, 'a.ts'), time: 1795000000, is_write: false }],
        lastSent: 0,
        showStatusBar: false,
        isMetricsEnabled: false,
      });
      fs.writeFileSync(path.join(home, 'a.ts'), 'const a = 1;\n');

      await harness.sendHeartbeats();
      const deadline = Date.now() + 10_000;
      while ((await getOfflineCount(cliPath, cliOptions)) === 0) {
        if (Date.now() > deadline) throw new Error('heartbeat never reached the offline queue');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.strictEqual(shown.length, 0, `unexpected prompt: ${JSON.stringify(shown)}`);
    } finally {
      shown.restore();
    }
  });

  const loginHarness = (apiKey = '') => {
    const harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      options: { getApiKey: async () => apiKey },
      dependencies: { isCliInstalled: () => true, getCliLocation: () => cliPath },
      logger: { debug: () => {}, warnException: () => {} },
    });
    return harness;
  };

  test('"Add to my account" keeps the saved activity for the new login', async () => {
    queueKeyless([1795000000, 1795000600]);
    const shown = stubMessages({ warning: SAVED_ACTIVITY_ADD });
    try {
      assert.strictEqual(await loginHarness().confirmSavedActivityBeforeLogin(), true);
      assert.strictEqual(shown[0].kind, 'warning');
      assert.strictEqual(shown[0].rest[0].modal, true);
      assert.ok(shown[0].rest[0].detail.includes('2 heartbeats'), shown[0].rest[0].detail);
      assert.strictEqual(await getOfflineCount(cliPath, cliOptions), 2);
    } finally {
      shown.restore();
    }
  });

  test('"Discard" clears the saved activity before logging in', async () => {
    queueKeyless([1795000000]);
    const shown = stubMessages({ warning: SAVED_ACTIVITY_DISCARD });
    try {
      assert.strictEqual(await loginHarness().confirmSavedActivityBeforeLogin(), true);
      assert.strictEqual(await getOfflineCount(cliPath, cliOptions), 0);
    } finally {
      shown.restore();
    }
  });

  test('closing the question cancels the login and keeps the activity', async () => {
    queueKeyless([1795000000]);
    const shown = stubMessages({ warning: undefined });
    try {
      assert.strictEqual(await loginHarness().confirmSavedActivityBeforeLogin(), false);
      assert.strictEqual(await getOfflineCount(cliPath, cliOptions), 1);
    } finally {
      shown.restore();
    }
  });

  test('no question when the queue is empty or someone is already logged in', async () => {
    const shown = stubMessages();
    try {
      assert.strictEqual(await loginHarness().confirmSavedActivityBeforeLogin(), true);
      queueKeyless([1795000000]);
      const key = '00000000-0000-4000-8000-000000000000';
      assert.strictEqual(await loginHarness(key).confirmSavedActivityBeforeLogin(), true);
      assert.strictEqual(shown.length, 0);
    } finally {
      shown.restore();
    }
  });
});

suite('desktop: saved activity question without a real cli', () => {
  test('still asks when the queue has heartbeats but their times are unreadable', async function () {
    if (process.platform === 'win32') this.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-fakecli-'));
    // knows how many heartbeats are queued, but fails to print them
    const fakeCli = path.join(dir, 'wakatime-cli');
    fs.writeFileSync(
      fakeCli,
      '#!/bin/sh\n' +
        'if [ "$1" = "--offline-count" ]; then echo 3; exit 0; fi\n' +
        'echo "boom" >&2; exit 1\n',
    );
    fs.chmodSync(fakeCli, 0o755);

    const harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      options: { getApiKey: async () => '' },
      dependencies: { isCliInstalled: () => true, getCliLocation: () => fakeCli },
      logger: { debug: () => {}, warnException: () => {} },
    });
    const shown = stubMessages({ warning: SAVED_ACTIVITY_ADD });
    try {
      assert.strictEqual(await harness.confirmSavedActivityBeforeLogin(), true);
      const question = shown.find((s) => s.kind === 'warning');
      assert.ok(question, 'the saved activity question was skipped');
      assert.ok(question.message.includes('from before you logged in'), question.message);
      assert.ok(question.rest[0].detail.includes('3 heartbeats'), question.rest[0].detail);
    } finally {
      shown.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('web: heartbeat queue', () => {
  const KEY = '00000000-0000-4000-8000-000000000000';
  let requests, statuses, originalFetch, shown;

  const makeWeb = (apiKey) => {
    const store = new Map();
    if (apiKey) store.set('hackatime.apiKey', apiKey);
    const harness = Object.create(WebHackatime.prototype);
    Object.assign(harness, {
      config: {
        get: (key) => store.get(key),
        update: async (key, value) => void store.set(key, value),
      },
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      heartbeats: [],
      lastSent: 0,
      flushing: false,
      savedActivityDeferred: false,
      showStatusBar: false,
      lastApiKeyPrompted: Date.now(),
      getPlugin: () => 'vscode/test vscode-hackatime/test',
      getApiUrl: () => 'http://hackatime.invalid/api',
      getCodingActivity: () => {},
    });
    harness.store = store;
    return harness;
  };

  const hb = (time) => ({ time, entity: `/project/file-${time}.ts`, is_write: false });
  const queue = (web) => web.store.get('hackatime.queuedHeartbeats') || [];

  setup(() => {
    requests = [];
    statuses = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const status = statuses.length ? statuses.shift() : 201;
      if (status === 0) throw new Error('offline');
      return { status, text: async () => '' };
    };
  });

  teardown(() => {
    globalThis.fetch = originalFetch;
    shown?.restore();
    shown = undefined;
  });

  test('without a key, heartbeats are saved instead of sent', async () => {
    shown = stubMessages();
    const web = makeWeb();
    web.heartbeats = [hb(1795000000), hb(1795000060)];

    await web.sendHeartbeats();

    assert.strictEqual(requests.length, 0);
    assert.strictEqual(web.heartbeats.length, 0);
    assert.strictEqual(queue(web).length, 2);
    assert.ok(queue(web).every((e) => e.loggedOut));
    assert.strictEqual(shown.length, 0, 'should not prompt while sending');
  });

  test('after login, "Add to my account" sends the saved activity', async () => {
    shown = stubMessages({ warning: SAVED_ACTIVITY_ADD });
    const web = makeWeb();
    web.heartbeats = [hb(1795000000)];
    await web.sendHeartbeats();

    web.store.set('hackatime.apiKey', KEY); // logged in, or a key synced from elsewhere
    await web.flushQueue();

    assert.strictEqual(shown.filter((s) => s.kind === 'warning').length, 1);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].body[0].time, 1795000000);
    assert.strictEqual(queue(web).length, 0);
  });

  test('"Discard" drops the saved activity without sending it', async () => {
    shown = stubMessages({ warning: SAVED_ACTIVITY_DISCARD });
    const web = makeWeb();
    web.heartbeats = [hb(1795000000)];
    await web.sendHeartbeats();

    web.store.set('hackatime.apiKey', KEY);
    await web.flushQueue();

    assert.strictEqual(requests.length, 0);
    assert.strictEqual(queue(web).length, 0);
  });

  test('closing the question keeps the activity and asks again next session', async () => {
    shown = stubMessages({ warning: undefined });
    const web = makeWeb();
    web.heartbeats = [hb(1795000000)];
    await web.sendHeartbeats();

    web.store.set('hackatime.apiKey', KEY);
    await web.flushQueue();
    await web.flushQueue();

    assert.strictEqual(shown.filter((s) => s.kind === 'warning').length, 1);
    assert.strictEqual(requests.length, 0);
    assert.strictEqual(queue(web).length, 1);
  });

  test('failed requests are queued and sent with the next success', async () => {
    shown = stubMessages();
    const web = makeWeb(KEY);
    statuses = [0, 503];
    web.heartbeats = [hb(1795000000)];
    await web.sendHeartbeats(); // offline
    web.heartbeats = [hb(1795000060)];
    await web.sendHeartbeats(); // server error
    assert.strictEqual(queue(web).length, 2);
    assert.ok(
      queue(web).every((e) => !e.loggedOut),
      'failures with a key need no question',
    );

    web.heartbeats = [hb(1795000120)];
    await web.sendHeartbeats(); // works, then flushes the queue

    assert.strictEqual(queue(web).length, 0);
    const sent = requests.slice(2).flatMap((r) => r.body.map((h) => h.time));
    assert.deepStrictEqual(sent.sort(), [1795000000, 1795000060, 1795000120]);
    assert.strictEqual(shown.length, 0);
  });

  test('heartbeats the server rejects are not retried forever', async () => {
    shown = stubMessages();
    const web = makeWeb(KEY);
    statuses = [400];
    web.heartbeats = [hb(1795000000)];
    await web.sendHeartbeats();
    assert.strictEqual(queue(web).length, 0);
  });

  test('the queue is flushed in batches of 25', async () => {
    shown = stubMessages();
    const web = makeWeb(KEY);
    web.store.set(
      'hackatime.queuedHeartbeats',
      Array.from({ length: 60 }, (_, i) => ({
        id: `q${i}`,
        loggedOut: false,
        heartbeat: hb(i + 1),
      })),
    );

    await web.flushQueue();

    assert.deepStrictEqual(
      requests.map((r) => r.body.length),
      [25, 25, 10],
    );
    assert.strictEqual(queue(web).length, 0);
  });

  test('a failed flush stops and keeps the rest for later', async () => {
    shown = stubMessages();
    const web = makeWeb(KEY);
    web.store.set(
      'hackatime.queuedHeartbeats',
      Array.from({ length: 30 }, (_, i) => ({
        id: `q${i}`,
        loggedOut: false,
        heartbeat: hb(i + 1),
      })),
    );
    statuses = [201, 503];

    await web.flushQueue();

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(queue(web).length, 5);
  });

  test('the queue keeps only the newest 5000 heartbeats', async () => {
    shown = stubMessages();
    const web = makeWeb();
    web.heartbeats = Array.from({ length: 5010 }, (_, i) => hb(i + 1));
    await web.sendHeartbeats();
    assert.strictEqual(queue(web).length, 5000);
    assert.strictEqual(queue(web)[0].heartbeat.time, 11);
  });
});
