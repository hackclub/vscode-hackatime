// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2026 Hackatime Contributors

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const ONBOARDING_PROMPTED_KEY = 'hackatimeAi.onboardingPromptedV1';

function resolveWakaTimeConfigPath(): string {
  const wakaHome = process.env.WAKATIME_HOME?.trim();
  const baseDir = wakaHome && wakaHome.length > 0 ? wakaHome : os.homedir();
  return path.join(baseDir, '.wakatime.cfg');
}

/**
 * Prompts once for the user's Hackatime API key and safely stores it in ~/.wakatime.cfg (0600)
 * without overwriting other settings.
 */
export async function configureHackatimeApiKey(): Promise<boolean> {
  const cfgPath = resolveWakaTimeConfigPath();
  let existingKey = '';
  let content = '[settings]\n';
  if (fs.existsSync(cfgPath)) {
    content = fs.readFileSync(cfgPath, 'utf8');
    const match = content.match(/^\s*api_key\s*=\s*(.+)$/m);
    if (match) {
      existingKey = match[1].trim();
    }
  }

  const entered = await vscode.window.showInputBox({
    title: 'Hackatime AI — Configure Hackatime API Key',
    prompt: 'Paste your API key from https://hackatime.hackclub.com/my/wakatime_setup (saved locally to ~/.wakatime.cfg)',
    value: existingKey,
    password: true,
    ignoreFocusOut: true,
  });

  if (!entered || entered.trim().length === 0) {
    return false;
  }

  const key = entered.trim();
  if (fs.existsSync(cfgPath)) {
    const backupPath = `${cfgPath}.hackatime-ai.bak`;
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, content, { mode: 0o600 });
    }
  }

  if (/^\s*api_key\s*=.*$/m.test(content)) {
    content = content.replace(/^\s*api_key\s*=.*$/m, `api_key = ${key}`);
  } else if (/^\s*\[settings\]\s*$/m.test(content)) {
    content = content.replace(/^\s*\[settings\]\s*$/m, `[settings]\napi_key = ${key}`);
  } else {
    content = `[settings]\napi_key = ${key}\n\n${content}`;
  }

  fs.writeFileSync(cfgPath, content, { mode: 0o600 });
  void vscode.window.showInformationMessage('Saved Hackatime API key to ~/.wakatime.cfg.');
  return true;
}

/**
 * Safely updates ~/.wakatime.cfg to route legacy WakaTime/Hackatime heartbeats
 * through hackatime-d's Mode 1 Transparent Dual-Tee Proxy (127.0.0.1:<port>)
 * while creating a backup and preserving the user's existing api_key untouched.
 */
export async function enableWakaTimeDualTeeProxy(port: number): Promise<void> {
  const cfgPath = resolveWakaTimeConfigPath();
  const proxyUrl = `http://127.0.0.1:${port}/api/hackatime/v1`;

  let content = '[settings]\n';
  if (fs.existsSync(cfgPath)) {
    content = fs.readFileSync(cfgPath, 'utf8');
    const backupPath = `${cfgPath}.hackatime-ai.bak`;
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, content, { mode: 0o600 });
    }
  }

  if (/^\s*api_url\s*=.*$/m.test(content)) {
    content = content.replace(/^\s*api_url\s*=.*$/m, `api_url = ${proxyUrl}`);
  } else if (/^\s*\[settings\]\s*$/m.test(content)) {
    content = content.replace(/^\s*\[settings\]\s*$/m, `[settings]\napi_url = ${proxyUrl}`);
  } else {
    content = `[settings]\napi_url = ${proxyUrl}\n\n${content}`;
  }

  fs.writeFileSync(cfgPath, content, { mode: 0o600 });
  void vscode.window.showInformationMessage(
    `Hackatime AI Dual-Tee Proxy enabled in ~/.wakatime.cfg (${proxyUrl}). Your official Hackatime hours will continue forwarding with zero loss.`
  );
}

/**
 * Generates ready-to-use Git/Shell/Claude Code hook snippet pointing to the exact bundled hackatime-d binary.
 */
export async function showCliHooksSetup(daemonBinPath: string): Promise<void> {
  const snippet = [
    '# Hackatime AI (StruggleTrack) CLI & Git Hooks',
    `# Bundled daemon binary: ${daemonBinPath}`,
    '',
    '# 1. Claude Code (~/.claude/settings.json -> hooks.UserPromptSubmit):',
    `#    "${daemonBinPath}" emit --source claude-code`,
    '',
    '# 2. Git post-commit hook (tracks SIG_GIT_HYGIENE + git_head_sha):',
    `#    "${daemonBinPath}" emit --source git --event SIG_GIT_HYGIENE --project "$(git rev-parse --show-toplevel)" --git-head "$(git rev-parse HEAD)"`,
    '',
    '# 3. Shell build/test exit-code hook (bash/zsh precmd):',
    `#    "${daemonBinPath}" emit --source shell --exit-code $? --project "$PWD"`,
  ].join('\n');

  const doc = await vscode.workspace.openTextDocument({
    language: 'shellscript',
    content: snippet,
  });
  await vscode.window.showTextDocument(doc);
}

/**
 * Single non-intrusive opt-in consent prompt on first activation.
 */
export async function maybePromptOnboarding(
  context: vscode.ExtensionContext,
  daemonBinPath: string,
  proxyPort: number
): Promise<void> {
  if (context.globalState.get<boolean>(ONBOARDING_PROMPTED_KEY, false)) {
    return;
  }
  await context.globalState.update(ONBOARDING_PROMPTED_KEY, true);

  const choice = await vscode.window.showInformationMessage(
    'Hackatime AI is passively tracking productive struggle. Enable zero-loss Hackatime Dual-Tee Proxy (~/.wakatime.cfg) & CLI hooks?',
    'Enable Dual-Tee Proxy',
    'Show CLI/Git Hooks',
    'IDE Only'
  );

  if (choice === 'Enable Dual-Tee Proxy') {
    await enableWakaTimeDualTeeProxy(proxyPort);
  } else if (choice === 'Show CLI/Git Hooks') {
    await showCliHooksSetup(daemonBinPath);
  }
}
