import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { Utils } from '../src/utils';
import { WakaTime } from '../src/wakatime';

const mockEnv = (overrides: Partial<typeof vscode.env>): typeof vscode.env => {
  return {
    appName: 'Visual Studio Code',
    appRoot: '/Applications/Visual Studio Code.app/Contents/Resources/app',
    uriScheme: 'vscode',
    ...overrides,
  } as typeof vscode.env;
};

// Defines a Mocha test suite to group tests of similar kind together
suite("WakaTime Tests", () => {
	// Should be implemented after integration with CI/CD
});

suite('Utils.getEditorName Tests', () => {
  test('detects editor from appName', () => {
    assert.strictEqual(Utils.getEditorName(mockEnv({ appName: 'Cursor' })), 'cursor');
    assert.strictEqual(Utils.getEditorName(mockEnv({ appName: 'Windsurf' })), 'windsurf');
  });

  test('detects Cursor from uriScheme when appName reports vscode', () => {
    const env = mockEnv({ uriScheme: 'cursor' });
    assert.strictEqual(Utils.getEditorName(env), 'cursor');
  });

  test('prefers uriScheme over appName', () => {
    const env = mockEnv({ appName: 'Visual Studio Code', uriScheme: 'windsurf' });
    assert.strictEqual(Utils.getEditorName(env), 'windsurf');
  });

  test('detects Cursor from appRoot when appName and uriScheme report vscode', () => {
    const env = mockEnv({ appRoot: '/Applications/Cursor.app/Contents/Resources/app' });
    assert.strictEqual(Utils.getEditorName(env), 'cursor');
  });

  test('appRoot matching ignores whitespace in editor names', () => {
    const env = mockEnv({ appRoot: 'C:\\Program Files\\Azure Data Studio\\resources\\app' });
    assert.strictEqual(Utils.getEditorName(env), 'azdata');
  });

  test('falls back to vscode for Visual Studio Code', () => {
    assert.strictEqual(Utils.getEditorName(mockEnv({})), 'vscode');
  });

  test('falls back to normalized appName for unknown editors', () => {
    const env = mockEnv({
      appName: 'Some Editor',
      appRoot: '/opt/some-editor/resources/app',
      uriScheme: 'some-editor',
    });
    assert.strictEqual(Utils.getEditorName(env), 'someeditor');
  });
});
