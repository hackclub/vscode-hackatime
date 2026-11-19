'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { findGitRoot, isTooBroadGitRoot } = require('../out/src/git-root');
const { Hackatime } = require('../out/src/wakatime');

suite('isTooBroadGitRoot', () => {
  const winHome = 'C:\\Users\\hridd';
  const posixHome = '/home/hridd';

  test('home folder, its parents and drive roots are too broad', () => {
    assert.strictEqual(isTooBroadGitRoot('C:\\Users\\hridd', winHome, true), true);
    assert.strictEqual(isTooBroadGitRoot('c:\\users\\HRIDD\\', winHome, true), true);
    assert.strictEqual(isTooBroadGitRoot('C:\\Users', winHome, true), true);
    assert.strictEqual(isTooBroadGitRoot('C:\\', winHome, true), true);
    assert.strictEqual(isTooBroadGitRoot('D:\\', winHome, true), true);
    assert.strictEqual(isTooBroadGitRoot('/home/hridd', posixHome, false), true);
    assert.strictEqual(isTooBroadGitRoot('/home', posixHome, false), true);
    assert.strictEqual(isTooBroadGitRoot('/', posixHome, false), true);
  });

  test('Desktop, Documents and Downloads are too broad, including OneDrive copies', () => {
    assert.strictEqual(isTooBroadGitRoot('C:\\Users\\hridd\\Desktop', winHome, true), true);
    assert.strictEqual(isTooBroadGitRoot('C:\\Users\\hridd\\documents', winHome, true), true);
    assert.strictEqual(
      isTooBroadGitRoot('C:\\Users\\hridd\\OneDrive\\Desktop', winHome, true),
      true,
    );
    assert.strictEqual(
      isTooBroadGitRoot('C:\\Users\\hridd\\OneDrive - Burlington School\\Documents', winHome, true),
      true,
    );
    assert.strictEqual(isTooBroadGitRoot('/home/hridd/Downloads', posixHome, false), true);
  });

  test('real project folders are fine', () => {
    assert.strictEqual(
      isTooBroadGitRoot('C:\\Users\\hridd\\Desktop\\Code\\almond', winHome, true),
      false,
    );
    assert.strictEqual(isTooBroadGitRoot('C:\\Users\\hridd\\Desktop\\Code', winHome, true), false);
    assert.strictEqual(isTooBroadGitRoot('C:\\Users\\hriddhi', winHome, true), false);
    assert.strictEqual(isTooBroadGitRoot('D:\\projects\\almond', winHome, true), false);
    assert.strictEqual(isTooBroadGitRoot('/home/hridd/code/almond', posixHome, false), false);
    assert.strictEqual(isTooBroadGitRoot('/home/hridd/Desktop/almond', posixHome, false), false);
    assert.strictEqual(isTooBroadGitRoot('/home/hridd/stuff/Desktop', posixHome, false), false);
  });

  test('posix paths compare case-sensitively', () => {
    assert.strictEqual(isTooBroadGitRoot('/home/Hridd', posixHome, false), false);
  });
});

suite('git repo prompt (extension host)', () => {
  let home, oldHome, oldUserProfile, original, shown, harness, dismissed;

  setup(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-home-')));
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    // os.homedir() reads these, so the prompt sees the fake home
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    shown = [];
    dismissed = [];
    original = {
      warn: vscode.window.showWarningMessage,
      info: vscode.window.showInformationMessage,
    };
    vscode.window.showWarningMessage = async (message, ...items) => {
      shown.push({ kind: 'warning', message, items });
      return harness.nextChoice;
    };
    vscode.window.showInformationMessage = async (message, ...items) => {
      shown.push({ kind: 'info', message, items });
      return undefined;
    };

    harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      logger: { debug: () => {}, debugException: () => {}, error: () => {}, warn: () => {} },
      isGitInstalled: async () => true,
      dismissUnknownProjectPromptForProject: async (key) => dismissed.push(key),
      nextChoice: undefined,
    });
  });

  teardown(() => {
    vscode.window.showWarningMessage = original.warn;
    vscode.window.showInformationMessage = original.info;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const makeProject = (...parts) => {
    const folder = path.join(home, ...parts);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  };

  test('warns when the only repo is in the home folder', async () => {
    fs.mkdirSync(path.join(home, '.git'));
    const project = makeProject('Desktop', 'Code', 'almond');

    await harness.maybePromptForGitRepoIssues(project, 'almond');

    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].kind, 'warning');
    assert.ok(shown[0].message.includes(`"${path.basename(home)}"`), shown[0].message);
    assert.ok(shown[0].message.includes(home), shown[0].message);
    assert.deepStrictEqual(shown[0].items, [
      'Initialize repository here',
      'Ignore for project',
      'Disable alerts',
    ]);
  });

  test('warns when the repo is on the Desktop', async () => {
    fs.mkdirSync(path.join(home, 'Desktop', '.git'), { recursive: true });
    await harness.maybePromptForGitRepoIssues(makeProject('Desktop', 'almond'), 'almond');
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].kind, 'warning');
  });

  test('stays quiet for a project with its own repo inside a broad one', async () => {
    fs.mkdirSync(path.join(home, '.git'));
    const project = makeProject('Desktop', 'Code', 'almond');
    fs.mkdirSync(path.join(project, '.git'));

    await harness.maybePromptForGitRepoIssues(project, 'almond');
    assert.strictEqual(shown.length, 0);
  });

  test('stays quiet when a .wakatime-project pins the project', async () => {
    fs.mkdirSync(path.join(home, '.git'));
    const project = makeProject('Desktop', 'Code', 'almond');
    fs.writeFileSync(path.join(project, '.wakatime-project'), 'almond\n');

    await harness.maybePromptForGitRepoIssues(project, 'almond');
    assert.strictEqual(shown.length, 0);
  });

  test('still shows the plain prompt when there is no repo at all', async () => {
    await harness.maybePromptForGitRepoIssues(makeProject('code', 'almond'), 'almond');
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].kind, 'info');
    assert.strictEqual(shown[0].items[0], 'Initialize repository');
  });

  test('"Initialize repository here" makes the project its own repo', async function () {
    if (!(await Hackatime.prototype.isGitInstalled.call(harness))) this.skip();
    fs.mkdirSync(path.join(home, '.git'));
    const project = makeProject('Desktop', 'Code', 'almond');
    harness.nextChoice = 'Initialize repository here';

    await harness.maybePromptForGitRepoIssues(project, 'almond');

    assert.strictEqual(findGitRoot(project), project);
    assert.strictEqual(dismissed.length, 1);
  });

  test('only one prompt is open at a time', async () => {
    fs.mkdirSync(path.join(home, '.git'));
    let release;
    vscode.window.showWarningMessage = (message, ...items) => {
      shown.push({ kind: 'warning', message, items });
      return new Promise((resolve) => (release = resolve));
    };

    const first = harness.maybePromptForGitRepoIssues(makeProject('a'), 'a');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.maybePromptForGitRepoIssues(makeProject('b'), 'b');
    assert.strictEqual(shown.length, 1);

    release(undefined);
    await first;
    assert.strictEqual(harness.pendingGitRepoPrompt, undefined);
  });
});

suite('heartbeats while a git prompt is open', () => {
  test('appendHeartbeat does not wait for the prompt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-hb-'));
    const file = path.join(root, 'index.ts');
    fs.writeFileSync(file, 'const a = 1;\n');
    const document = await vscode.workspace.openTextDocument(file);

    let promptCalls = 0;
    const harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      dependencies: { isCliInstalled: () => true },
      logger: { debug: () => {}, debugException: () => {} },
      heartbeats: [],
      lineChanges: { ai: {}, human: {} },
      filesWithHumanTyping: {},
      dedupe: {},
      lastSent: Date.now(),
      lastCodeReviewing: false,
      showStatusBar: false,
      isMetricsEnabled: false,
      sendHeartbeatsIfNecessary: async () => {},
      maybePromptForGitRepoIssues: () => {
        promptCalls++;
        return new Promise(() => {}); // a toast nobody ever clicks
      },
    });

    try {
      const appended = harness.appendHeartbeat(
        document,
        Date.now(),
        new vscode.Position(0, 0),
        false,
        false,
        false,
        false,
      );
      await Promise.race([
        appended,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('appendHeartbeat waited on the prompt')), 2_000),
        ),
      ]);
      assert.strictEqual(promptCalls, 1);
      assert.strictEqual(harness.heartbeats.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
