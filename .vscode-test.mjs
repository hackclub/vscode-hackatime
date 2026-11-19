import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// the extension activates inside the test instance, so give it a throwaway home
// instead of the real ~/.wakatime.cfg (and its api key)
const wakatimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hackatime-test-'));

export default defineConfig({
  files: 'out/test/**/*.test.js',
  env: { WAKATIME_HOME: wakatimeHome },
  mocha: {
    ui: 'tdd',
    timeout: 20000,
  },
});
