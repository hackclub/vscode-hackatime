import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// tests load the compiled plugin from out/ themselves, so the instance runs a stub
// extension and never activates a real tracker. any plugin code a test does call still
// gets a throwaway home instead of the real ~/.wakatime.cfg (and its api key).
const wakatimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-test-'));

export default defineConfig({
  files: ['out/test/**/*.test.js', 'test/**/*.extension.test.js'],
  extensionDevelopmentPath: './test/fixture',
  launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-extensions'],
  env: { WAKATIME_HOME: wakatimeHome },
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
