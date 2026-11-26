// SPDX-License-Identifier: BSD-3-Clause
'use strict';

const assert = require('assert');
const { COMMAND_DASHBOARD } = require('../out/src/constants');
const { Hackatime } = require('../out/src/wakatime');
const {
  DEFAULT_STRUGGLE_API_URL,
  deriveDashboardBaseUrl,
  normalizeHackatimeApiUrl,
} = require('../out/src/struggle/daemonManager');

suite('Hackatime(ST) StruggleTrack integration', () => {
  test('pauses normal Hackatime heartbeats while StruggleTrack owns the session', async () => {
    let cliChecked = false;
    const harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      struggleTrackActive: false,
      dependencies: {
        isCliInstalled: () => {
          cliChecked = true;
          return false;
        },
      },
    });

    harness.setStruggleTrackState(true, 'Hackatime(ST) active');
    assert.strictEqual(harness.isStruggleTrackActive(), true);
    await harness.appendHeartbeat({}, 1795000000, {}, false, false, false, true);
    assert.strictEqual(cliChecked, false, 'normal heartbeat must pause while StruggleTrack is active');

    harness.setStruggleTrackState(false);
    assert.strictEqual(harness.isStruggleTrackActive(), false);
    await harness.appendHeartbeat({}, 1795000005, {}, false, false, false, false);
    assert.strictEqual(cliChecked, true, 'normal heartbeat must resume once StruggleTrack is inactive');
  });

  test('switches status bar between normal Hackatime and Hackatime(ST) cleanly', () => {
    const statusBar = { text: '', tooltip: '', command: COMMAND_DASHBOARD };
    const harness = Object.create(Hackatime.prototype);
    Object.assign(harness, {
      statusBar,
      struggleTrackActive: false,
      struggleTrackTooltip: 'Hackatime — Hackatime(ST)',
      lastNormalStatusText: undefined,
      lastNormalStatusTooltip: 'Hackatime: Initialized',
    });

    harness.updateStatusBarText('1 hr 20 mins');
    harness.updateStatusBarTooltip('Hackatime: 1 hr 20 mins today');
    assert.strictEqual(statusBar.text, '$(clockface) 1 hr 20 mins');
    assert.strictEqual(statusBar.command, COMMAND_DASHBOARD);

    harness.setStruggleTrackState(true, 'Hackatime(ST) · 12.0 SP');
    assert.strictEqual(statusBar.text, '$(pulse) Hackatime(ST)');
    assert.strictEqual(statusBar.tooltip, 'Hackatime(ST) · 12.0 SP');
    assert.strictEqual(statusBar.command, 'hackatime-ai.showStatus');

    // Normal text updates received while StruggleTrack is active must not overwrite Hackatime(ST)
    harness.updateStatusBarText('1 hr 25 mins');
    assert.strictEqual(statusBar.text, '$(pulse) Hackatime(ST)');

    // Restoring normal mode restores the latest normal Hackatime status bar text & command
    harness.setStruggleTrackState(false);
    assert.strictEqual(statusBar.text, '$(clockface) 1 hr 25 mins');
    assert.strictEqual(statusBar.tooltip, 'Hackatime: 1 hr 20 mins today');
    assert.strictEqual(statusBar.command, COMMAND_DASHBOARD);
  });

  test('defaults StruggleTrack URL to official hackatime.apiUrl with no third-party hardcoding', () => {
    assert.strictEqual(DEFAULT_STRUGGLE_API_URL, '');
    assert.strictEqual(
      normalizeHackatimeApiUrl('https://hackatime.hackclub.com/'),
      'https://hackatime.hackclub.com/api/hackatime/v1',
    );
    assert.strictEqual(
      normalizeHackatimeApiUrl('https://hackatime.hackclub.com/api/hackatime/v1/'),
      'https://hackatime.hackclub.com/api/hackatime/v1',
    );
    assert.strictEqual(
      deriveDashboardBaseUrl('https://hackatime.hackclub.com/api/hackatime/v1'),
      'https://hackatime.hackclub.com',
    );
  });

  test('manifest hides desktop-only StruggleTrack commands on web and keeps official defaults', () => {
    const pkg = require('../package.json');
    assert.strictEqual(pkg.name, 'hackatime-time-tracker');
    assert.strictEqual(pkg.publisher, 'hackatime');
    assert.strictEqual(pkg.license, 'BSD-3-Clause');
    assert.strictEqual(pkg.contributes.configuration.properties['hackatimeAi.struggleApiUrl'].default, '');

    const paletteEntries = new Map(
      pkg.contributes.menus.commandPalette.map((entry) => [entry.command, entry.when]),
    );
    for (const cmd of pkg.contributes.commands) {
      if (cmd.command.startsWith('hackatime-ai.')) {
        assert.strictEqual(
          paletteEntries.get(cmd.command),
          '!isWeb',
          `${cmd.command} must be gated with !isWeb in commandPalette`,
        );
      }
    }
  });
});
