'use strict';

const assert = require('assert');
const fs = require('fs');
const vscode = require('vscode');
const { ALLOWED_SCHEMES } = require('../out/src/constants');
const { Utils } = require('../out/src/utils');
const { Hackatime } = require('../out/src/wakatime');

suite('Live Share URI support (extension host)', () => {
  const registrations = [];

  suiteSetup(() => {
    for (const scheme of ['vsls', 'vsls-scc']) {
      try {
        registrations.push(
          vscode.workspace.registerTextDocumentContentProvider(scheme, {
            provideTextDocumentContent: (uri) => `virtual content for ${uri.toString(true)}\n`,
          }),
        );
      } catch (error) {
        // vs code 1.137 reserves `vsls` as a text provider even without live share installed.
        if (!String(error).includes(`scheme '${scheme}' already registered`)) throw error;
        const changes = new vscode.EventEmitter();
        registrations.push(changes);
        registrations.push(
          vscode.workspace.registerFileSystemProvider(
            scheme,
            {
              onDidChangeFile: changes.event,
              watch: () => new vscode.Disposable(() => {}),
              stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 16 }),
              readDirectory: () => [],
              createDirectory: () => {},
              readFile: (uri) => Buffer.from(`virtual content for ${uri.toString(true)}\n`),
              writeFile: () => {},
              delete: () => {},
              rename: () => {},
            },
            { isReadonly: true },
          ),
        );
      }
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    registrations.forEach((registration) => registration.dispose());
  });

  async function openLiveShareDocument(scheme) {
    const uri = vscode.Uri.parse(`${scheme}://session-id/project/src/index.ts?ref=guest#selection`);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    return document;
  }

  for (const scheme of ['vsls', 'vsls-scc']) {
    test(`${scheme} uses an absolute virtual file identity without query or fragment`, async () => {
      const document = await openLiveShareDocument(scheme);

      assert.ok(ALLOWED_SCHEMES.includes(scheme), `${scheme} is missing from ALLOWED_SCHEMES`);
      assert.strictEqual(Utils.isLiveShareUri(document.uri), true);
      const entity = vscode.Uri.file('/__liveshare__/session-id/project/src/index.ts').fsPath;
      assert.strictEqual(Utils.getFocusedFile(document), entity);
      assert.strictEqual(Utils.getFocusedFile(), entity);
    });
  }

  test('only explicit guest keyboard/mouse selections trigger activity', async () => {
    const document = await openLiveShareDocument('vsls');
    const harness = Object.create(Hackatime.prototype);
    let activity = 0;
    Object.assign(harness, {
      syncAIHeartbeatsDebounced: () => {},
      updateLineNumbers: () => {},
      logger: { debug: () => {} },
      onEvent: () => {
        activity++;
      },
    });
    const textEditor = vscode.window.activeTextEditor;
    for (const kind of [undefined, vscode.TextEditorSelectionChangeKind.Command]) {
      harness.onChangeSelection({ textEditor, kind });
    }
    harness.onChangeTextDocument({ document, contentChanges: [{ text: 'x' }] });
    harness.onSave(document);
    harness.onChangeTab(textEditor);
    assert.strictEqual(activity, 0);
    for (const kind of [
      vscode.TextEditorSelectionChangeKind.Keyboard,
      vscode.TextEditorSelectionChangeKind.Mouse,
    ]) {
      harness.onChangeSelection({ textEditor, kind });
    }
    assert.strictEqual(activity, 2);
  });

  test('Live Share paths without an authority do not gain duplicate separators', async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('vsls:/src/shared.ts'),
    );
    assert.strictEqual(
      Utils.getFocusedFile(document),
      vscode.Uri.file('/__liveshare__/src/shared.ts').fsPath,
    );
  });

  test('background saves do not credit the active shared document', async () => {
    const localDocument = await vscode.workspace.openTextDocument({ content: 'local config' });
    const sharedDocument = await openLiveShareDocument('vsls');
    const harness = Object.create(Hackatime.prototype);
    const recorded = [];
    Object.assign(harness, {
      logger: { debug: () => {} },
      syncAIHeartbeatsDebounced: () => {},
      sendHeartbeatsIfNecessary: () => {},
      updateLineNumbers: () => {},
      filesWithHumanTyping: {},
      currentlyFocusedFile: Utils.getFocusedFile(sharedDocument),
      debounceMs: 1,
      lastHeartbeat: 0,
      appendHeartbeat: (document) => recorded.push(document),
    });
    harness.onSave(localDocument);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(recorded.length, 0);

    harness.onChangeSelection({
      textEditor: vscode.window.activeTextEditor,
      kind: vscode.TextEditorSelectionChangeKind.Keyboard,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(recorded, [sharedDocument]);
  });

  test('local and remote documents retain their existing entity handling', async () => {
    const document = await vscode.workspace.openTextDocument({ content: 'local text' });
    assert.strictEqual(Utils.isLiveShareUri(document.uri), false);
    assert.strictEqual(Utils.getFocusedFile(document), document.fileName);
    assert.strictEqual(
      Utils.isRemoteUri(vscode.Uri.parse('vscode-remote://ssh-remote+host/a.ts')),
      true,
    );
  });

  test('Live Share heartbeat uses a temporary local file and no local project folder', async () => {
    const document = await openLiveShareDocument('vsls');
    const harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      dependencies: { isCliInstalled: () => true },
      logger: {
        debug: () => {},
        debugException: (error) => {
          throw error;
        },
      },
      heartbeats: [],
      lineChanges: { ai: {}, human: {} },
      filesWithHumanTyping: {},
      dedupe: {},
      lastSent: Date.now(),
      lastCodeReviewing: false,
      getProjectName: () => 'Live Share project',
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
    const heartbeat = harness.heartbeats[0];
    assert.strictEqual(
      heartbeat.entity,
      vscode.Uri.file('/__liveshare__/session-id/project/src/index.ts').fsPath,
    );
    assert.ok(
      !heartbeat.project_folder,
      `unexpected local project_folder: ${heartbeat.project_folder}`,
    );
    assert.ok(heartbeat.local_file, 'Live Share document content was not copied to local_file');
    assert.strictEqual(fs.readFileSync(heartbeat.local_file, 'utf8'), document.getText());
    fs.unlinkSync(heartbeat.local_file);
  });
});
