import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getCliLocation } from './cli-location';
import { Desktop } from './desktop';
import { Logger } from './logger';
import { Utils } from './utils';

export interface Setting {
  key: string;
  value: string;
  error?: string;
}

export class Options {
  private configFile: string;
  private internalConfigFile: string;
  private logFile: string;
  private logger: Logger;
  private resourcesFolder: string;
  private cache: any = {};

  constructor(logger: Logger, resourcesFolder: string) {
    this.logger = logger;
    this.resourcesFolder = resourcesFolder;
    this.configFile = path.join(Desktop.getHomeDirectory(), '.wakatime.cfg');
    this.internalConfigFile = path.join(resourcesFolder, 'wakatime-internal.cfg');
    this.logFile = path.join(resourcesFolder, 'wakatime.log');
  }

  public async getSettingAsync<T = any>(section: string, key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.getSetting(section, key, false, (setting) => {
        setting.error ? reject(setting.error) : resolve(setting.value);
      });
    });
  }

  public getSetting(
    section: string,
    key: string,
    internal: boolean,
    callback: (Setting) => void,
  ): void {
    const configFile = this.getConfigFile(internal);
    const binary = getCliLocation(this.resourcesFolder, this.logger);
    if (!fs.existsSync(binary)) {
      // hackatime-cli isn't installed yet (fresh install, or resourcesFolder was wiped), so
      // there's nothing to shell out to. Reading proxy/no_ssl_verify is itself needed to
      // download the cli, so fall back to a plain read of the ini file for this one case.
      this.getSettingFallback(configFile, section, key, callback);
      return;
    }

    const args = ['--config-read', key, '--config-section', section, '--config', configFile];
    const options = Desktop.buildOptions();
    try {
      child_process.execFile(binary, args, options, (error, stdout, stderr) => {
        // exit code 110 means the key/section/file wasn't found, not a real error
        if (error && (error as any).code !== 110) {
          callback({
            error: new Error(
              `could not read ${key} from ${configFile}: ${this.firstLine(stderr) || error}`,
            ),
            key: key,
            value: null,
          });
          return;
        }
        const value = this.removeNulls(stdout.toString().trim());
        callback({ key: key, value: value || null });
      });
    } catch (e) {
      callback({ error: e, key: key, value: null });
    }
  }

  private getSettingFallback(
    configFile: string,
    section: string,
    key: string,
    callback: (Setting) => void,
  ): void {
    fs.readFile(configFile, 'utf-8', (err: NodeJS.ErrnoException | null, content: string) => {
      if (err) {
        callback({ error: new Error(`could not read ${configFile}`), key: key, value: null });
        return;
      }
      let currentSection = '';
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('[') && line.endsWith(']')) {
          currentSection = line.substring(1, line.length - 1).toLowerCase();
          continue;
        }
        if (currentSection !== section) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        if (line.substring(0, eq).trim() === key) {
          callback({ key: key, value: this.removeNulls(line.substring(eq + 1).trim()) });
          return;
        }
      }
      callback({ key: key, value: null });
    });
  }

  public setSetting(section: string, key: string, val: string, internal: boolean): void {
    this.setSettings(section, [{ key, value: val }], internal);
  }

  // quote each pair as a single CSV field so commas/equals signs inside the value
  // survive hackatime-cli's pflag stringToString parsing of --config-write
  private quoteConfigWritePair(key: string, val: string): string {
    const pair = `${key}=${this.removeNulls(val)}`.replace(/"/g, '""');
    return `"${pair}"`;
  }

  public setSettings(section: string, settings: Setting[], internal: boolean): void {
    const configFile = this.getConfigFile(internal);
    const binary = getCliLocation(this.resourcesFolder, this.logger);
    if (!fs.existsSync(binary)) {
      // same bootstrap gap as getSetting: nothing to shell out to yet, most importantly
      // this is the path an OAuth login uses to persist a fresh api_key, so it can't be
      // silently skipped
      this.setSettingsFallback(configFile, section, settings);
      return;
    }

    const args: string[] = [];
    settings.forEach((setting) => {
      args.push('--config-write', this.quoteConfigWritePair(setting.key, setting.value));
    });
    args.push('--config-section', section, '--config', configFile);
    const options = Desktop.buildOptions();
    try {
      child_process.execFile(binary, args, options, (error, _stdout, stderr) => {
        if (error) {
          this.logger.debug(
            `could not write settings to ${configFile}: ${this.firstLine(stderr) || error}`,
          );
        }
      });
    } catch (e) {
      this.logger.debugException(e);
    }
  }

  private setSettingsFallback(configFile: string, section: string, settings: Setting[]): void {
    fs.readFile(configFile, 'utf-8', (err: NodeJS.ErrnoException | null, content: string) => {
      // ignore errors because the config file might not exist yet
      if (err) content = '';

      const contents: string[] = [];
      let currentSection = '';
      const found: Record<string, boolean> = {};

      const writeMissing = () => {
        settings.forEach((setting) => {
          if (!found[setting.key]) {
            contents.push(this.removeNulls(`${setting.key} = ${setting.value}`));
            found[setting.key] = true;
          }
        });
      };

      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('[') && line.endsWith(']')) {
          if (currentSection === section) writeMissing();
          currentSection = line.substring(1, line.length - 1).toLowerCase();
          contents.push(this.removeNulls(rawLine));
          continue;
        }
        if (currentSection !== section) {
          contents.push(this.removeNulls(rawLine));
          continue;
        }
        const eq = line.indexOf('=');
        const currentKey = eq === -1 ? line : line.substring(0, eq).trim();
        const setting = settings.find((s) => s.key === currentKey);
        if (!setting) {
          contents.push(this.removeNulls(rawLine));
        } else if (!found[setting.key]) {
          contents.push(this.removeNulls(`${setting.key} = ${setting.value}`));
          found[setting.key] = true;
        }
      }

      const remaining = settings.filter((setting) => !found[setting.key]);
      if (remaining.length) {
        if (currentSection !== section) contents.push(`[${section}]`);
        remaining.forEach((setting) => {
          contents.push(this.removeNulls(`${setting.key} = ${setting.value}`));
          found[setting.key] = true;
        });
      }

      fs.writeFile(configFile, contents.join('\n'), (writeErr) => {
        if (writeErr) this.logger.debugException(writeErr);
      });
    });
  }

  public getConfigFile(internal: boolean): string {
    return internal ? this.internalConfigFile : this.configFile;
  }

  public getLogFile(): string {
    return this.logFile;
  }

  public async getApiKey(): Promise<string> {
    if (!Utils.apiKeyInvalid(this.cache.api_key)) {
      return this.cache.api_key;
    }

    let from = '';

    const keyFromSettings = this.getApiKeyFromEditor();
    if (!Utils.apiKeyInvalid(keyFromSettings)) {
      this.cache.api_key = keyFromSettings;
      from = 'settings.json editor';
    }

    const keyFromEnv = this.getApiKeyFromEnv();
    if (!Utils.apiKeyInvalid(keyFromEnv)) {
      if (this.cache.api_key && this.cache.api_key !== keyFromEnv) {
        vscode.window.showErrorMessage(
          `Hackatime API Key conflict. Your env key doesn't match your ${from} key.`,
        );
        return this.cache.api_key;
      }
      this.cache.api_key = keyFromEnv;
      from = 'env var';
    }

    try {
      const apiKeyFromVault = await this.getApiKeyFromVaultCmd();
      if (!Utils.apiKeyInvalid(apiKeyFromVault)) {
        if (this.cache.api_key && this.cache.api_key !== apiKeyFromVault) {
          vscode.window.showErrorMessage(
            `Hackatime API Key conflict. Your vault command key doesn't match your ${from} key.`,
          );
          return this.cache.api_key;
        }
        this.cache.api_key = apiKeyFromVault;
        from = 'vault command';
      }
    } catch (err) {}

    try {
      const apiKey = await this.getSettingAsync<string>('settings', 'api_key');
      if (!Utils.apiKeyInvalid(apiKey)) {
        if (this.cache.api_key && this.cache.api_key !== apiKey) {
          vscode.window.showErrorMessage(
            `Hackatime API Key conflict. Your ~/.wakatime.cfg key doesn't match your ${from} key.`,
          );
        }
        this.cache.api_key = apiKey;
      }
    } catch (err) {
      this.logger.debug(`Exception while reading API Key from config file: ${err}`);
      if (!this.cache.api_key && `${err}`.includes('spawn EPERM')) {
        vscode.window.showErrorMessage(
          'Microsoft Defender is blocking Hackatime. Please allow Hackatime to run so it can upload code stats to your dashboard.',
        );
      }
    }

    return this.cache.api_key ?? '';
  }

  public async getApiKeyFromVaultCmd(): Promise<string> {
    try {
      // Use basically the same logic as hackatime-cli to interpret cmdStr
      // https://github.com/hackclub/hackatime-cli/blob/2e53df6/pkg/params/params.go#L1068
      const cmdStr = await this.getSettingAsync<string>('settings', 'api_key_vault_cmd');
      if (!cmdStr?.trim()) return '';

      const cmdParts = cmdStr.trim().split(' ');
      if (cmdParts.length === 0) return '';

      const [cmdName, ...cmdArgs] = cmdParts;

      const options = Desktop.buildOptions();
      const proc = child_process.spawn(cmdName, cmdArgs, options);

      let stdout = '';
      for await (const chunk of proc.stdout) {
        stdout += chunk;
      }
      let stderr = '';
      for await (const chunk of proc.stderr) {
        stderr += chunk;
      }
      const exitCode = await new Promise((resolve) => {
        proc.on('close', resolve);
      });

      if (exitCode) this.logger.warn(`api key vault command error (${exitCode}): ${stderr}`);
      else if (stderr && stderr.trim()) this.logger.warn(stderr.trim());

      const apiKey = stdout.toString().trim();
      return apiKey;
    } catch (err) {
      this.logger.debug(`Exception while reading API Key Vault Cmd from config file: ${err}`);
      return '';
    }
  }

  public getApiKeyFromEditor(): string {
    return vscode.workspace.getConfiguration().get('hackatime.apiKey') || '';
  }

  private getApiUrlFromEditor(): string {
    return vscode.workspace.getConfiguration().get('hackatime.apiUrl') || '';
  }

  public getStatusBarAlignment(): vscode.StatusBarAlignment {
    const align: string = vscode.workspace.getConfiguration().get('hackatime.align') ?? '';
    switch (align) {
      case 'left':
        return vscode.StatusBarAlignment.Left;
      case 'right':
        return vscode.StatusBarAlignment.Right;
      default:
        return vscode.StatusBarAlignment.Left;
    }
  }

  public getStatusBarPriority(): number {
    const priority = vscode.workspace.getConfiguration().get('hackatime.alignPriority');
    return typeof priority === 'number' ? priority : 1;
  }

  // Support for gitpod.io https://github.com/hackatime/vscode-hackatime/pull/220
  public getApiKeyFromEnv(): string {
    if (this.cache.api_key_from_env !== undefined) return this.cache.api_key_from_env;

    this.cache.api_key_from_env = process.env.HACKATIME_API_KEY || '';

    return this.cache.api_key_from_env;
  }

  public async getApiUrl(): Promise<string> {
    let apiUrl = this.getApiUrlFromEditor();

    if (!apiUrl) {
      apiUrl = this.getApiUrlFromEnv();
    }

    // people often accidentally enter their API Key into the API Url settings input
    if (!Utils.validateApiUrl(apiUrl)) apiUrl = '';

    if (!apiUrl) {
      try {
        apiUrl = await this.getSettingAsync<string>('settings', 'api_url');
      } catch (err) {
        this.logger.debug(`Exception while reading API Url from config file: ${err}`);
      }
    }

    if (!apiUrl) apiUrl = 'https://hackatime.hackclub.com/api/hackatime/v1';

    const suffixes = ['/', '.bulk', '/users/current/heartbeats', '/heartbeats', '/heartbeat'];
    for (const suffix of suffixes) {
      if (apiUrl.endsWith(suffix)) {
        apiUrl = apiUrl.slice(0, -suffix.length);
      }
    }

    return apiUrl;
  }

  private getApiUrlFromEnv(): string {
    if (this.cache.api_url_from_env !== undefined) return this.cache.api_url_from_env;

    this.cache.api_url_from_env = process.env.WAKATIME_API_URL || '';

    return this.cache.api_url_from_env;
  }

  public hasApiKey(callback: (valid: boolean) => void): void {
    this.getApiKey()
      .then((apiKey) => callback(!Utils.apiKeyInvalid(apiKey)))
      .catch((err) => {
        this.logger.warn(`Unable to check for api key: ${err}`);
        callback(false);
      });
  }

  private firstLine(s: string): string {
    return (s || '').toString().split('\n')[0].trim();
  }

  private removeNulls(s: string): string {
    return s.replace(/\0/g, '');
  }
}
