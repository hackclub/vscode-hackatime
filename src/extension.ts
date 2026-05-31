import * as vscode from 'vscode';

import {
  COMMAND_LOGIN,
  COMMAND_API_KEY,
  COMMAND_API_URL,
  COMMAND_CONFIG_FILE,
  COMMAND_DASHBOARD,
  COMMAND_DEBUG,
  COMMAND_DISABLE,
  COMMAND_ENABLE_UNKNOWN_PROJECT_ALERTS,
  COMMAND_LOG_FILE,
  COMMAND_PROXY,
  COMMAND_STATUS_BAR_CODING_ACTIVITY,
  COMMAND_STATUS_BAR_ENABLED,
  LogLevel,
} from './constants';

import { Logger } from './logger';
import { Hackatime } from './wakatime';

var logger = new Logger(LogLevel.INFO);
var hackatime: Hackatime;

export function activate(ctx: vscode.ExtensionContext) {
  hackatime = new Hackatime(logger, ctx);

  ctx.globalState?.setKeysForSync(['hackatime.apiKey']);

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_LOGIN, function () {
      hackatime.loginWithHackatime();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_API_KEY, function () {
      hackatime.promptForApiKey();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_API_URL, function () {
      hackatime.promptForApiUrl();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_PROXY, function () {
      hackatime.promptForProxy();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_DEBUG, function () {
      hackatime.promptForDebug();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_DISABLE, function () {
      hackatime.promptToDisable();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ENABLE_UNKNOWN_PROJECT_ALERTS, function () {
      hackatime.enableUnknownProjectAlerts();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_STATUS_BAR_ENABLED, function () {
      hackatime.promptStatusBarIcon();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_STATUS_BAR_CODING_ACTIVITY, function () {
      hackatime.promptStatusBarCodingActivity();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_DASHBOARD, function () {
      hackatime.openDashboardWebsite();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_CONFIG_FILE, function () {
      hackatime.openConfigFile();
    }),
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_LOG_FILE, function () {
      hackatime.openLogFile();
    }),
  );

  ctx.subscriptions.push(hackatime);

  hackatime.initialize();
}

export function deactivate() {
  hackatime.dispose();
}
