// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2026 Hackatime Contributors

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Hackatime } from '../wakatime';
import { MultiFactorAttributionEngine } from './attributionEngine';
import {
  DaemonManager,
  deriveDashboardBaseUrl,
  normalizeHackatimeApiUrl,
  resolveFallbackApiKeyEnv,
  resolveHackatimeApiUrl,
  resolveStruggleApiUrl,
} from './daemonManager';
import { detectHostIde } from './ideDetector';
import { DaemonIpcClient, SessionStatusResult } from './ipcClient';
import { showCliHooksSetup } from './onboarding';

function wakatimeConfigPath(): string {
  const wakaHome = process.env.WAKATIME_HOME;
  if (wakaHome && wakaHome.trim().length > 0) {
    return path.join(wakaHome.trim(), '.wakatime.cfg');
  }
  return path.join(os.homedir(), '.wakatime.cfg');
}

function getFileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

function activeProjectInfo(): { root: string; name: string } {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (wf) {
      return { root: wf.uri.fsPath, name: wf.name };
    }
  }
  const first = vscode.workspace.workspaceFolders?.[0];
  return first ? { root: first.uri.fsPath, name: first.name } : { root: '', name: '' };
}

function activeProjectRoot(): string {
  return activeProjectInfo().root;
}

function buildStruggleTooltip(status: SessionStatusResult): string {
  const openApps =
    status.open_agentic_apps && status.open_agentic_apps.length > 0
      ? status.open_agentic_apps.join(', ')
      : 'none';
  const multStr = `${status.preview_multiplier.toFixed(2)}x`;
  const pendingSp = (status.pending_struggle_points ?? 0).toFixed(1);
  const lines = [
    `Hackatime — Hackatime(ST) (AI StruggleTrack)`,
    `Project: ${status.active_project || 'none'} (${status.primary_language || 'n/a'})`,
    `Active AI Tool: ${status.ai_harness} | Running Agentic Apps: ${openApps}`,
    `Current 5m Window: ${formatDuration(status.active_seconds)} · ${status.preview_struggle_points.toFixed(1)} SP · ${multStr}`,
  ];
  if (status.pending_windows > 0) {
    lines.push(
      `Pending Sync: ${status.pending_windows} window(s) (${pendingSp} SP · syncs every 5 min when online)`
    );
  }
  lines.push(`Click for Dashboard, Convert SP, or Sync`);
  return lines.join('\n');
}

/**
 * Coordinates StruggleTrack (Hackatime(ST)) alongside normal Hackatime:
 * - Normal manual coding runs through Hackatime as usual
 * - Whenever any agentic app (Antigravity, Cursor, Windsurf, Claude Code, Codex, Gemini CLI,
 *   Aider, OpenCode, Cline, etc.) or AI code generation becomes active, pauses normal
 *   Hackatime heartbeats (zero double-counting) and switches the status bar to Hackatime(ST).
 */
export class StruggleController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly ipc = new DaemonIpcClient();
  private readonly output: vscode.OutputChannel;
  private readonly daemonManager: DaemonManager;
  private lastWakatimeCfgMtimeMs: number = getFileMtimeMs(wakatimeConfigPath());
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private diagTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly hackatime: Hackatime
  ) {
    this.output = vscode.window.createOutputChannel('Hackatime(ST)');
    this.daemonManager = new DaemonManager(context, this.ipc, this.output);
    this.disposables.push(this.output);
  }

  public async start(): Promise<void> {
    const ide = detectHostIde();
    this.output.appendLine(
      `[hackatime(st)] activating inside ${ide.appName} (family=${ide.family}, agenticIde=${String(ide.isAgenticIde)})`
    );

    // Ensure shared detached hackatime-d daemon is running
    await this.daemonManager.ensureRunning();

    // Multi-factor AI vs human attribution engine
    const attribution = new MultiFactorAttributionEngine(this.ipc, ide);
    this.disposables.push(attribution);

    // Event-driven focus pulse
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        const proj = activeProjectInfo();
        if (!proj.root) {
          return;
        }
        void this.ipc.send('focus.update', {
          project_root: proj.root,
          project_name: proj.name,
          focused: state.focused,
          focus_context: 'code',
          language: vscode.window.activeTextEditor?.document.languageId ?? '',
          ai_harness: ide.aiHarness,
          timestamp_ms: Date.now(),
        });
      })
    );

    // Debounced diagnostics lifecycle with Human-in-the-Loop autonomous AI gate
    let lastErrorCount = 0;
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        if (this.diagTimer) {
          clearTimeout(this.diagTimer);
        }
        this.diagTimer = setTimeout(() => {
          this.diagTimer = undefined;
          const root = activeProjectRoot();
          if (!root) {
            return;
          }
          let errors = 0;
          for (const [uri, diags] of vscode.languages.getDiagnostics()) {
            if (uri.scheme !== 'file') {
              continue;
            }
            for (const d of diags) {
              if (d.severity === vscode.DiagnosticSeverity.Error) {
                errors += 1;
              }
            }
          }
          if (errors !== lastErrorCount) {
            const now = Date.now();
            lastErrorCount = errors;
            attribution.setHasActiveErrors(errors > 0);
            void this.ipc.send('struggle.emit', {
              source: 'vscode',
              project_root: root,
              error_count: errors,
              autonomous_agent: attribution.wasLastEditAutonomousAi(now),
              ai_harness: ide.aiHarness,
              timestamp_ms: now,
            });
          }
        }, 2500);
      })
    );

    // IDE build / test task execution lifecycle (Tier A)
    this.disposables.push(
      vscode.tasks.onDidEndTaskProcess((ev) => {
        const root = activeProjectRoot();
        if (!root || ev.exitCode === undefined) {
          return;
        }
        void this.ipc.send('struggle.emit', {
          source: 'ide-task',
          project_root: root,
          exit_code: ev.exitCode,
          ai_harness: ide.aiHarness,
          timestamp_ms: Date.now(),
        });
      })
    );

    // Integrated terminal shell command lifecycle (VS Code 1.93+)
    const winAny = vscode.window as unknown as {
      onDidEndTerminalShellExecution?: (
        listener: (e: { exitCode?: number }) => void
      ) => vscode.Disposable;
    };
    if (typeof winAny.onDidEndTerminalShellExecution === 'function') {
      this.disposables.push(
        winAny.onDidEndTerminalShellExecution((ev) => {
          const root = activeProjectRoot();
          if (!root || ev.exitCode === undefined) {
            return;
          }
          void this.ipc.send('struggle.emit', {
            source: 'shell',
            project_root: root,
            exit_code: ev.exitCode,
            ai_harness: ide.aiHarness,
            timestamp_ms: Date.now(),
          });
        })
      );
    }

    // Keep hackatime-d synced whenever official Hackatime or autostart settings change
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((ev) => {
        if (ev.affectsConfiguration('hackatimeAi.autoStartOnLogin')) {
          void this.daemonManager.syncAutostartPolicy();
        }
        if (
          ev.affectsConfiguration('hackatime.apiUrl') ||
          ev.affectsConfiguration('hackatime.apiKey') ||
          ev.affectsConfiguration('hackatimeAi.struggleApiUrl') ||
          ev.affectsConfiguration('hackatimeAi.wakatimeProxyPort') ||
          ev.affectsConfiguration('hackatimeAi.daemonPath')
        ) {
          void (async () => {
            this.daemonManager.syncStruggleOverrideConfig();
            await this.daemonManager.restartDaemon();
            await this.pollDaemonStatus();
          })();
        }
      })
    );

    this.registerCommands();

    // Send initial focus & poll every 5s so Hackatime <-> Hackatime(ST) switches smoothly
    const initialProj = activeProjectInfo();
    if (initialProj.root) {
      void this.ipc.send('focus.update', {
        project_root: initialProj.root,
        project_name: initialProj.name,
        focused: vscode.window.state.focused,
        focus_context: 'code',
        language: vscode.window.activeTextEditor?.document.languageId ?? '',
        ai_harness: ide.aiHarness,
        timestamp_ms: Date.now(),
      });
    }

    await this.pollDaemonStatus();
    this.pollTimer = setInterval(() => {
      void this.pollDaemonStatus();
    }, 5000);
  }

  private async pollDaemonStatus(): Promise<SessionStatusResult | null> {
    // If Hackatime: Login / Api Key / Api Url modified ~/.wakatime.cfg, reload hackatime-d cleanly
    const cfgMtime = getFileMtimeMs(wakatimeConfigPath());
    if (cfgMtime > 0 && cfgMtime !== this.lastWakatimeCfgMtimeMs) {
      this.lastWakatimeCfgMtimeMs = cfgMtime;
      this.output.appendLine('[hackatime(st)] ~/.wakatime.cfg updated — reloading hackatime-d...');
      await this.daemonManager.restartDaemon();
    }

    const st = await this.ipc.getSessionStatus(activeProjectRoot() || undefined);
    if (!st) {
      this.hackatime.setStruggleTrackState(false);
      return null;
    }
    const isStruggle = st.tracking_mode === 'struggle';
    this.hackatime.setStruggleTrackState(
      isStruggle,
      isStruggle ? buildStruggleTooltip(st) : undefined
    );
    return st;
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('hackatime-ai.showStatus', async () => {
        const st = await this.pollDaemonStatus();
        if (!st) {
          const retry = await vscode.window.showWarningMessage(
            'Hackatime(ST) background service is starting or offline. Normal Hackatime continues running.',
            'Start Service',
            'Open Dashboard'
          );
          if (retry === 'Start Service') {
            await this.daemonManager.ensureRunning();
            await this.pollDaemonStatus();
          } else if (retry === 'Open Dashboard') {
            await vscode.commands.executeCommand('hackatime.dashboard');
          }
          return;
        }

        const isStruggle = st.tracking_mode === 'struggle';
        const pendingCount = st.pending_windows;
        const pendingNote =
          pendingCount > 0
            ? ` · ${pendingCount} window(s) queued (syncs every 5 min)`
            : ' · All synced';
        const summaryMsg = isStruggle
          ? `Hackatime(ST): ${formatDuration(st.active_seconds)} active · ${st.preview_struggle_points.toFixed(1)} SP · ${st.preview_multiplier.toFixed(2)}x${pendingNote}`
          : `Hackatime (Normal Coding): tracking via Hackatime${pendingNote}`;

        const buttons =
          pendingCount > 0
            ? ['Open Dashboard', 'Convert SP', 'Sync Now']
            : ['Open Dashboard', 'Convert SP'];

        const action = await vscode.window.showInformationMessage(summaryMsg, ...buttons);
        if (action === 'Open Dashboard') {
          const base = deriveDashboardBaseUrl(resolveHackatimeApiUrl());
          await vscode.env.openExternal(vscode.Uri.parse(base));
        } else if (action === 'Convert SP') {
          await vscode.commands.executeCommand('hackatime-ai.openStruggleConverter');
        } else if (action === 'Sync Now') {
          await vscode.commands.executeCommand('hackatime-ai.syncNow');
        }
      }),

      vscode.commands.registerCommand('hackatime-ai.openStruggleConverter', async () => {
        const base = deriveDashboardBaseUrl(resolveStruggleApiUrl());
        await vscode.env.openExternal(vscode.Uri.parse(`${base}/my/struggle`));
      }),

      vscode.commands.registerCommand('hackatime-ai.syncNow', async () => {
        const bin = this.daemonManager.resolveDaemonBinary();
        const upstream = resolveHackatimeApiUrl();
        const struggleUpstream = resolveStruggleApiUrl();
        const extraEnv = resolveFallbackApiKeyEnv();
        execFile(
          bin,
          ['sync', '--upstream', upstream, '--struggle-upstream', struggleUpstream],
          { timeout: 25000, env: { ...process.env, ...extraEnv } },
          (err, stdout, stderr) => {
            if (err) {
              void vscode.window.showWarningMessage(
                `Hackatime(ST) sync skipped: ${(stderr || err.message).trim()}`
              );
              return;
            }
            void vscode.window.showInformationMessage(stdout.trim() || 'Hackatime(ST) synced.');
            void this.pollDaemonStatus();
          }
        );
      }),

      vscode.commands.registerCommand('hackatime-ai.installCliHooks', async () => {
        await showCliHooksSetup(this.daemonManager.resolveDaemonBinary());
      }),

      vscode.commands.registerCommand('hackatime-ai.toggleAutostart', async () => {
        const cfg = vscode.workspace.getConfiguration('hackatimeAi');
        const currentlyEnabled = cfg.get<boolean>('autoStartOnLogin', true);
        const choice = await vscode.window.showQuickPick(
          [
            {
              label: currentlyEnabled
                ? '$(circle-slash) Disable Background Autostart on Login'
                : '$(play) Enable Background Autostart on Login (Track Standalone Agents Without VS Code)',
              nextValue: !currentlyEnabled,
            },
          ],
          {
            placeHolder: currentlyEnabled
              ? 'Background login autostart is currently ENABLED (automatic by default)'
              : 'Background login autostart is currently DISABLED',
          }
        );
        if (!choice) {
          return;
        }
        await cfg.update('autoStartOnLogin', choice.nextValue, vscode.ConfigurationTarget.Global);
        await this.daemonManager.syncAutostartPolicy();
        void vscode.window.showInformationMessage(
          choice.nextValue
            ? 'Hackatime(ST) background autostart enabled — Antigravity & CLI agents will be tracked even when VS Code is closed.'
            : 'Hackatime(ST) background autostart disabled.'
        );
      }),

      vscode.commands.registerCommand('hackatime-ai.setStruggleServerUrl', async () => {
        const cfg = vscode.workspace.getConfiguration('hackatimeAi');
        const current = cfg.get<string>('struggleApiUrl', '').trim();
        const entered = await vscode.window.showInputBox({
          title: 'Hackatime(ST) — StruggleTrack Server URL',
          prompt:
            'Enter your standalone StruggleTrack Nest URL (e.g. https://yourname.hackclub.app) to route ONLY Hackatime(ST) there while keeping normal Hackatime on Hack Club. Leave blank to use hackatime.apiUrl.',
          value: current,
          placeHolder: 'https://yourname.hackclub.app (or leave empty for official Hackatime)',
          ignoreFocusOut: true,
        });
        if (entered === undefined) {
          return;
        }
        const trimmed = entered.trim();
        const normalized = trimmed.length > 0 ? normalizeHackatimeApiUrl(trimmed) : '';
        await cfg.update('struggleApiUrl', normalized, vscode.ConfigurationTarget.Global);
        this.daemonManager.syncStruggleOverrideConfig();
        await this.daemonManager.restartDaemon();
        await this.pollDaemonStatus();
        void vscode.window.showInformationMessage(
          normalized.length > 0
            ? `Hackatime(ST) StruggleTrack routed to ${normalized} (normal Hackatime stays on ${resolveHackatimeApiUrl()}).`
            : `Hackatime(ST) StruggleTrack reset to match Hackatime (${resolveHackatimeApiUrl()}).`
        );
      }),

      vscode.commands.registerCommand('hackatime-ai.restartDaemon', async () => {
        const ok = await this.daemonManager.restartDaemon();
        await this.pollDaemonStatus();
        if (ok) {
          void vscode.window.showInformationMessage('Hackatime(ST) tracking service restarted.');
        } else {
          void vscode.window.showWarningMessage(
            'Could not restart Hackatime(ST) tracking service.'
          );
        }
      })
    );
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.diagTimer) {
      clearTimeout(this.diagTimer);
      this.diagTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    void this.context;
  }
}
