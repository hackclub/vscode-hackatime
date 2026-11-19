import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tests load the compiled plugin from out/ themselves, so the instance runs a stub
// extension and never activates a real tracker. any plugin code a test does call still
// gets a throwaway home instead of the real ~/.wakatime.cfg (and its api key).
const wakatimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-test-'));
// a fresh VS Code profile every run, so local runs start from the same blank window CI
// gets instead of reopening whatever workspace an earlier run left behind
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-test-profile-'));
// open a multi-root workspace: in an empty or single-folder window, changing the folders
// makes VS Code reload instead of firing onDidChangeWorkspaceFolders, which the cli test
// relies on. a .code-workspace file can change folders in place.
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-test-workspace-'));
const workspaceFolder = path.join(workspaceDir, 'tests.code-workspace');
fs.writeFileSync(workspaceFolder, JSON.stringify({ folders: [{ path: '.' }] }));

export default defineConfig({
  files: ['out/test/**/*.test.js', 'test/**/*.extension.test.js'],
  extensionDevelopmentPath: './test/fixture',
  workspaceFolder,
  launchArgs: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-extensions',
    `--user-data-dir=${userDataDir}`,
  ],
  env: { WAKATIME_HOME: wakatimeHome },
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
