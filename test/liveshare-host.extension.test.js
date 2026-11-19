'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { Role } = require('vsls/vscode');
const { Hackatime } = require('../out/src/wakatime');
const { Utils } = require('../out/src/utils');

suite('Live Share host isolation', () => {
  let root, document, harness, recorded, subscriptions, peerNumber;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-host-'));
    const file = path.join(root, 'host.ts');
    fs.writeFileSync(file, 'const host = 1;\n');
    document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    await settle();
    recorded = [];
    subscriptions = [];
    peerNumber = 2;
    harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      liveShare: {
        session: { id: 'session', role: Role.Host, peerNumber: 1 },
        getPeerForTextDocumentChangeEvent: async () => ({ peerNumber }),
      },
      logger: { debug: () => {}, debugException: () => {} },
      syncAIHeartbeatsDebounced: () => {},
      sendHeartbeatsIfNecessary: () => {},
      currentlyFocusedFile: Utils.getFocusedFile(document),
      filesWithHumanTyping: {},
      AIrecentPastes: [],
      isAICodeGenerating: false,
      lineChanges: { ai: {}, human: {} },
      linesInFiles: {},
      debounceMs: 1,
      lastHeartbeat: 0,
      appendHeartbeat: (doc, time, selection, isWrite) => recorded.push({ doc, isWrite }),
    });
  });

  teardown(async () => {
    subscriptions.forEach((s) => s.dispose());
    clearTimeout(harness.debounceId);
    clearTimeout(harness.AIDebounceId);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('remote-style edit, cursor shift and save do not credit an idle host', async () => {
    const pending = [];
    subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document) pending.push(harness.onChangeTextDocument(e));
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => harness.onChangeSelection(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => harness.onSave(doc)),
    );
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'x\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await document.save());
    await settle();
    await Promise.all(pending);
    assert.strictEqual(recorded.length, 0);
    assert.deepStrictEqual(harness.lineChanges, { ai: {}, human: {} });
    assert.deepStrictEqual(harness.filesWithHumanTyping, {});
    assert.ok(fs.readFileSync(document.fileName, 'utf8').startsWith('x\n'));
  });

  test('host keyboard and mouse activity still count, background events do not', async () => {
    const textEditor = vscode.window.activeTextEditor;
    harness.onChangeTab(textEditor);
    harness.onChangeSelection({ textEditor, kind: undefined });
    harness.onChangeSelection({ textEditor, kind: vscode.TextEditorSelectionChangeKind.Command });
    harness.onEvent(true);
    await settle();
    assert.strictEqual(recorded.length, 0);
    for (const kind of [
      vscode.TextEditorSelectionChangeKind.Keyboard,
      vscode.TextEditorSelectionChangeKind.Mouse,
    ]) {
      harness.lastHeartbeat = 0;
      harness.onChangeSelection({ textEditor, kind });
      await settle();
    }
    assert.strictEqual(recorded.length, 2);
    assert.ok(recorded.every((h) => h.doc === document));
  });

  test('only locally attributed changes contribute line counts', async () => {
    const event = {
      document,
      contentChanges: [{ text: 'new line\n', range: new vscode.Range(0, 0, 0, 0) }],
    };
    await harness.onChangeTextDocument(event);
    assert.deepStrictEqual(harness.lineChanges.human, {});
    peerNumber = 1;
    await harness.onChangeTextDocument(event);
    assert.strictEqual(harness.lineChanges.human[document.fileName], 1);
    harness.updateLineNumbers();
    assert.strictEqual(harness.lineChanges.human[document.fileName], 1);
    assert.strictEqual(recorded.length, 0);
  });

  test('attribution failure and results from an ended session are ignored', async () => {
    const event = {
      document,
      contentChanges: [{ text: 'x\n', range: new vscode.Range(0, 0, 0, 0) }],
    };
    harness.liveShare.getPeerForTextDocumentChangeEvent = async () => {
      throw new Error('unavailable');
    };
    await harness.onChangeTextDocument(event);
    let resolvePeer;
    harness.liveShare.getPeerForTextDocumentChangeEvent = () =>
      new Promise((resolve) => {
        resolvePeer = resolve;
      });
    const pending = harness.onChangeTextDocument(event);
    harness.liveShare.session = { id: '', role: Role.None, peerNumber: 1 };
    resolvePeer({ peerNumber: 1 });
    await pending;
    assert.deepStrictEqual(harness.lineChanges.human, {});
  });

  test('Live Share receives the extension ID supplied by VS Code', async () => {
    const vsls = require('vsls/vscode.js');
    const originalGetApi = vsls.getApi;
    const sessionChanges = new vscode.EventEmitter();
    let callerId;
    harness.context = { extension: { id: 'test.renamed-tracker' } };
    harness.eventListenerVersion = 0;
    harness.liveShare.onDidChangeSession = sessionChanges.event;
    vsls.getApi = async (id) => {
      callerId = id;
      return harness.liveShare;
    };
    try {
      await harness.setupEventListeners();
      assert.strictEqual(callerId, harness.context.extension.id);
      assert.ok(harness.disposable);
    } finally {
      harness.disposable?.dispose();
      sessionChanges.dispose();
      vsls.getApi = originalGetApi;
    }
  });

  test('ending the session restores ordinary local save tracking', async () => {
    harness.liveShare.session = { id: '', role: Role.None, peerNumber: 1 };
    harness.onSave(document);
    await settle();
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].isWrite, true);
    harness.liveShare = undefined;
    assert.strictEqual(harness.requiresLocalActivity(document), false);
  });
});
