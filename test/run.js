'use strict';

const path = require('path');
const { runTests } = require('@vscode/test-electron');

runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  extensionDevelopmentPath: path.resolve(__dirname, 'fixture'),
  extensionTestsPath: path.resolve(__dirname, 'index.js'),
  launchArgs: ['--no-sandbox', '--disable-gpu', '--disable-extensions'],
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
