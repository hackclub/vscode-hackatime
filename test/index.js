'use strict';

const path = require('path');
const Mocha = require('mocha');

async function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20_000 });
  mocha.addFile(path.resolve(__dirname, 'liveshare.extension.test.js'));
  mocha.addFile(path.resolve(__dirname, 'liveshare-host.extension.test.js'));
  mocha.addFile(path.resolve(__dirname, 'cli.extension.test.js'));

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures) reject(new Error(`${failures} extension-host test(s) failed`));
      else resolve();
    });
  });
}

module.exports = { run };
