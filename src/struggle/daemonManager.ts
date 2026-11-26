// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2026 Hackatime Contributors

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DaemonIpcClient } from './ipcClient';

function platformSubdir(): string {
  const plat = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${plat}-${arch}`;
}

function stableDaemonDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'hackatime-ai');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'hackatime-ai');
}

function stableDaemonBinDir(): string {
  return path.join(stableDaemonDataDir(), 'bin');
}

function wakatimeCfgPath(): string {
  const wakaHome = process.env.WAKATIME_HOME;
  return wakaHome && wakaHome.trim().length > 0
    ? path.join(wakaHome.trim(), '.wakatime.cfg')
    : path.join(os.homedir(), '.wakatime.cfg');
}

function readWakatimeCfgKey(keyName: string): string {
  try {
    const cfgPath = wakatimeCfgPath();
    if (!fs.existsSync(cfgPath)) {
      return '';
    }
    const content = fs.readFileSync(cfgPath, 'utf8');
    const re = new RegExp(`^\\s*${keyName}\\s*=\\s*(.+)\\s*$`, 'im');
    const match = content.match(re);
    if (match && match[1].trim().length > 0) {
      return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Ignore read errors
  }
  return '';
}

export function normalizeHackatimeApiUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }
  const schemeIdx = trimmed.indexOf('://');
  if (schemeIdx === -1) {
    return trimmed;
  }
  if (trimmed.indexOf('/', schemeIdx + 3) === -1) {
    return `${trimmed}/api/hackatime/v1`;
  }
  return trimmed;
}

export function resolveHackatimeApiUrl(): string {
  const hackatimeCfg = vscode.workspace.getConfiguration('hackatime');
  const officialUrl = hackatimeCfg.get<string>('apiUrl', '').trim();
  if (officialUrl.length > 0) {
    return normalizeHackatimeApiUrl(officialUrl);
  }

  // Fallback to ~/.wakatime.cfg api_url (shared with hackatime-cli & Hackatime: Login)
  const cfgUrl = readWakatimeCfgKey('api_url');
  if (cfgUrl.length > 0) {
    return normalizeHackatimeApiUrl(cfgUrl);
  }

  return 'https://hackatime.hackclub.com/api/hackatime/v1';
}

/**
 * Default standalone StruggleTrack (Hackatime ST) backend override.
 * Empty by default in official Hackatime so StruggleTrack syncs directly to `hackatime.apiUrl`.
 */
export const DEFAULT_STRUGGLE_API_URL = '';

/**
 * Resolves the StruggleTrack (Hackatime ST) server URL independently from official Hackatime.
 * - Explicit user setting (`hackatimeAi.struggleApiUrl`) or `~/.wakatime.cfg` `struggle_api_url` wins.
 * - Otherwise, official Hack Club users automatically route Hackatime(ST) to `DEFAULT_STRUGGLE_API_URL`
 *   with zero manual setup while normal Hackatime heartbeats stay on Hack Club.
 * - Custom self-hosted/local dev `hackatime.apiUrl` setups fall back to that same custom server.
 */
export function resolveStruggleApiUrl(): string {
  const aiCfg = vscode.workspace.getConfiguration('hackatimeAi');
  const inspected = aiCfg.inspect<string>('struggleApiUrl');
  const explicit =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;

  if (typeof explicit === 'string') {
    const trimmed = explicit.trim();
    if (trimmed.length > 0) {
      return normalizeHackatimeApiUrl(trimmed);
    }
    return resolveHackatimeApiUrl();
  }

  const cfgStruggle = readWakatimeCfgKey('struggle_api_url');
  if (cfgStruggle.length > 0) {
    return normalizeHackatimeApiUrl(cfgStruggle);
  }

  const upstream = resolveHackatimeApiUrl();
  if (
    DEFAULT_STRUGGLE_API_URL.length > 0 &&
    upstream.toLowerCase().startsWith('https://hackatime.hackclub.com')
  ) {
    return DEFAULT_STRUGGLE_API_URL;
  }

  return upstream;
}

/**
 * Fallback API key lookup when the user configured `hackatime.apiKey` in VS Code Settings
 * rather than `~/.wakatime.cfg`. Returned ONLY to pass via process env (`HACKATIME_API_KEY`),
 * never via CLI arguments.
 */
export function resolveFallbackApiKeyEnv(): Record<string, string> {
  const cfgKey = readWakatimeCfgKey('api_key');
  if (cfgKey.length > 0) {
    return {};
  }
  const settingsKey = vscode.workspace.getConfiguration('hackatime').get<string>('apiKey', '').trim();
  if (settingsKey.length > 0) {
    return { HACKATIME_API_KEY: settingsKey };
  }
  return {};
}

export function deriveDashboardBaseUrl(apiUrl: string): string {
  return apiUrl.replace(/\/api\/hackatime\/v1\/?$/i, '').replace(/\/+$/, '');
}

export class DaemonManager {
  private startingPromise: Promise<boolean> | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ipc: DaemonIpcClient,
    private readonly output: vscode.OutputChannel
  ) {}

  private expectedExtensionVersion(): string {
    const pkg = this.context.extension?.packageJSON as { version?: string } | undefined;
    return typeof pkg?.version === 'string' && pkg.version.length > 0 ? pkg.version : '30.2.2007';
  }

  /**
   * Persists explicit `hackatimeAi.struggleApiUrl` overrides into `<data_dir>/struggle.cfg` so
   * OS login autostart matches VS Code even when VS Code is closed.
   */
  public syncStruggleOverrideConfig(): void {
    const dataDir = stableDaemonDataDir();
    const overrideFile = path.join(dataDir, 'struggle.cfg');
    const aiCfg = vscode.workspace.getConfiguration('hackatimeAi');
    const inspected = aiCfg.inspect<string>('struggleApiUrl');
    const explicit =
      inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
    const configured = typeof explicit === 'string' ? explicit.trim() : '';

    try {
      if (configured.length > 0) {
        const normalized = normalizeHackatimeApiUrl(configured);
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(
          overrideFile,
          `# Managed by Hackatime VS Code setting hackatimeAi.struggleApiUrl\n[settings]\nstruggle_api_url = ${normalized}\n`,
          'utf8'
        );
      } else if (fs.existsSync(overrideFile)) {
        fs.unlinkSync(overrideFile);
      }
    } catch (err) {
      this.output.appendLine(`[hackatime-ai] struggle.cfg sync skipped: ${String(err)}`);
    }
  }

  /**
   * Locates the bundled or custom hackatime-d binary.
   */
  public resolveBundledDaemonBinary(): string {
    const cfg = vscode.workspace.getConfiguration('hackatimeAi');
    const configured = cfg.get<string>('daemonPath', '').trim();
    if (configured.length > 0 && fs.existsSync(configured)) {
      return configured;
    }

    const exeName = process.platform === 'win32' ? 'hackatime-d.exe' : 'hackatime-d';
    const bundled = path.join(this.context.extensionPath, 'bin', platformSubdir(), exeName);
    if (fs.existsSync(bundled)) {
      return bundled;
    }

    const flatBundled = path.join(this.context.extensionPath, 'bin', exeName);
    if (fs.existsSync(flatBundled)) {
      return flatBundled;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      const devBin = path.join(f.uri.fsPath, 'build', 'linux-release', 'daemon', exeName);
      if (fs.existsSync(devBin)) {
        return devBin;
      }
    }

    return exeName;
  }

  /**
   * Returns the permanent stable binary path if staged, else the bundled binary path.
   */
  public resolveDaemonBinary(): string {
    const cfg = vscode.workspace.getConfiguration('hackatimeAi');
    const configured = cfg.get<string>('daemonPath', '').trim();
    if (configured.length > 0 && fs.existsSync(configured)) {
      return configured;
    }
    const exeName = process.platform === 'win32' ? 'hackatime-d.exe' : 'hackatime-d';
    const stableBin = path.join(stableDaemonBinDir(), exeName);
    if (fs.existsSync(stableBin)) {
      return stableBin;
    }
    return this.resolveBundledDaemonBinary();
  }

  /**
   * Copies the bundled hackatime-d binary to a permanent non-versioned OS path
   * (`%LOCALAPPDATA%\hackatime-ai\bin\hackatime-d.exe` on Windows,
   * `~/.local/share/hackatime-ai/bin/hackatime-d` on Linux/macOS) so OS login autostart
   * continues working seamlessly across extension upgrades and even when VS Code is closed.
   */
  private async stageStableBinary(sourceBin: string, stopRunningBeforeCopy: boolean): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('hackatimeAi');
    if (cfg.get<string>('daemonPath', '').trim().length > 0) {
      return sourceBin;
    }
    if (!path.isAbsolute(sourceBin) || !fs.existsSync(sourceBin)) {
      return sourceBin;
    }

    const binDir = stableDaemonBinDir();
    const exeName = process.platform === 'win32' ? 'hackatime-d.exe' : 'hackatime-d';
    const stableBin = path.join(binDir, exeName);
    const versionFile = path.join(binDir, 'version.txt');
    const targetVersion = this.expectedExtensionVersion();

    try {
      const srcStat = fs.statSync(sourceBin);
      const currentVersion = fs.existsSync(versionFile)
        ? fs.readFileSync(versionFile, 'utf8').trim()
        : '';
      if (
        fs.existsSync(stableBin) &&
        currentVersion === targetVersion &&
        fs.statSync(stableBin).size === srcStat.size
      ) {
        return stableBin;
      }

      if (stopRunningBeforeCopy) {
        await this.stopRunningDaemon();
      }

      fs.mkdirSync(binDir, { recursive: true });
      if (process.platform === 'win32') {
        fs.copyFileSync(sourceBin, stableBin);
      } else {
        const tmpBin = `${stableBin}.tmp-${process.pid}`;
        fs.copyFileSync(sourceBin, tmpBin);
        fs.chmodSync(tmpBin, 0o755);
        fs.renameSync(tmpBin, stableBin);
      }
      fs.writeFileSync(versionFile, `${targetVersion}\n`, 'utf8');
      this.output.appendLine(
        `[hackatime-ai] staged hackatime-d v${targetVersion} to ${stableBin}`
      );
      return stableBin;
    } catch (err) {
      this.output.appendLine(
        `[hackatime-ai] stable binary staging skipped (${String(err)}); using ${sourceBin}`
      );
      return fs.existsSync(stableBin) ? stableBin : sourceBin;
    }
  }

  /**
   * Automatically registers or removes OS login autostart according to
   * `hackatimeAi.autoStartOnLogin` (enabled by default so zero manual commands are needed).
   */
  public syncAutostartPolicy(binPath?: string): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration('hackatimeAi')
      .get<boolean>('autoStartOnLogin', true);
    const targetBin = binPath || this.resolveDaemonBinary();
    const action = enabled ? 'install' : 'uninstall';

    return new Promise((resolve) => {
      execFile(targetBin, ['autostart', action], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) {
          this.output.appendLine(
            `[hackatime-ai] autostart ${action} skipped: ${err.message}`
          );
        } else if (stdout.trim().length > 0) {
          this.output.appendLine(`[hackatime-ai] autostart: ${stdout.trim()}`);
        }
        resolve();
      });
    });
  }

  private async stopRunningDaemon(): Promise<void> {
    const existing = await this.ipc.getSessionStatus();
    if (!existing) {
      return;
    }
    await this.ipc.requestShutdown();
    for (const waitMs of [120, 200, 300, 400, 500]) {
      await new Promise((r) => setTimeout(r, waitMs));
      const stillUp = await this.ipc.getSessionStatus();
      if (!stillUp) {
        break;
      }
    }
  }

  /**
   * Ensures ONE up-to-date shared hackatime-d instance is staged, autostart-registered,
   * and running in the background for all IDEs, standalone agentic apps, and CLI agents.
   */
  public async ensureRunning(): Promise<boolean> {
    if (this.startingPromise) {
      return this.startingPromise;
    }
    this.startingPromise = this.ensureRunningInternal().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  private hasBundledUpgrade(sourceBin: string): boolean {
    const cfg = vscode.workspace.getConfiguration('hackatimeAi');
    if (cfg.get<string>('daemonPath', '').trim().length > 0) {
      return false;
    }
    if (!path.isAbsolute(sourceBin) || !fs.existsSync(sourceBin)) {
      return false;
    }
    const binDir = stableDaemonBinDir();
    const exeName = process.platform === 'win32' ? 'hackatime-d.exe' : 'hackatime-d';
    const stableBin = path.join(binDir, exeName);
    const versionFile = path.join(binDir, 'version.txt');
    const targetVersion = this.expectedExtensionVersion();
    try {
      if (!fs.existsSync(stableBin)) {
        return true;
      }
      const currentVersion = fs.existsSync(versionFile)
        ? fs.readFileSync(versionFile, 'utf8').trim()
        : '';
      return (
        currentVersion !== targetVersion ||
        fs.statSync(stableBin).size !== fs.statSync(sourceBin).size
      );
    } catch {
      return false;
    }
  }

  private async ensureRunningInternal(): Promise<boolean> {
    const bundledBin = this.resolveBundledDaemonBinary();
    const existing = await this.ipc.getSessionStatus();
    const needsUpgradeStop = Boolean(existing && this.hasBundledUpgrade(bundledBin));

    if (existing && !needsUpgradeStop) {
      this.output.appendLine(`[hackatime-st] connected to shared hackatime-d v${existing.version}`);
      this.syncStruggleOverrideConfig();
      const stableBin = await this.stageStableBinary(bundledBin, false);
      if (path.isAbsolute(stableBin) && fs.existsSync(stableBin)) {
        void this.syncAutostartPolicy(stableBin);
      }
      return true;
    }

    if (needsUpgradeStop && existing) {
      this.output.appendLine(
        `[hackatime-st] upgrading staged hackatime-d from bundled binary (running v${existing.version})...`
      );
    }

    const binPath = await this.stageStableBinary(bundledBin, needsUpgradeStop);
    if (process.platform !== 'win32' && path.isAbsolute(binPath) && fs.existsSync(binPath)) {
      try {
        fs.chmodSync(binPath, 0o755);
      } catch {
        // Ignore read-only filesystem errors
      }
    }

    // Persist struggle.cfg and register login autostart when binary is available
    this.syncStruggleOverrideConfig();
    if (path.isAbsolute(binPath) && fs.existsSync(binPath)) {
      await this.syncAutostartPolicy(binPath);
    }

    const cfg = vscode.workspace.getConfiguration('hackatimeAi');
    const proxyPort = cfg.get<number>('wakatimeProxyPort', 48290);
    const upstreamUrl = resolveHackatimeApiUrl();
    const struggleUrl = resolveStruggleApiUrl();
    const extraEnv = resolveFallbackApiKeyEnv();

    this.output.appendLine(
      `[hackatime-st] spawning shared detached daemon: ${binPath} (upstream=${upstreamUrl}, struggle=${struggleUrl})`
    );
    try {
      let spawnFailed = false;
      const child = spawn(
        binPath,
        [
          'run',
          '--proxy-port',
          String(proxyPort),
          '--upstream',
          upstreamUrl,
          '--struggle-upstream',
          struggleUrl,
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, ...extraEnv },
        }
      );
      child.on('error', (err) => {
        spawnFailed = true;
        this.output.appendLine(
          `[hackatime-st] hackatime-d not available (${err.message}); normal Hackatime continues running.`
        );
      });
      child.unref();

      // Poll IPC socket for readiness up to ~2 seconds (short-circuit if spawn ENOENT)
      for (const waitMs of [80, 150, 250, 400, 600, 600]) {
        await new Promise((r) => setTimeout(r, waitMs));
        if (spawnFailed) {
          return false;
        }
        const status = await this.ipc.getSessionStatus();
        if (status) {
          this.output.appendLine(`[hackatime-st] hackatime-d ready on ${this.ipc.getEndpoint()}`);
          return true;
        }
      }
    } catch (err) {
      this.output.appendLine(`[hackatime-st] failed to spawn hackatime-d: ${String(err)}`);
      return false;
    }

    this.output.appendLine('[hackatime-st] timed out waiting for hackatime-d IPC socket');
    return false;
  }

  /**
   * Gracefully asks the running shared hackatime-d to flush & exit, waits for it to release
   * its IPC endpoint, and spawns a fresh instance with the latest settings and ~/.wakatime.cfg.
   */
  public async restartDaemon(): Promise<boolean> {
    this.output.appendLine('[hackatime-ai] requesting clean hackatime-d restart...');
    await this.stopRunningDaemon();
    return this.ensureRunning();
  }
}
