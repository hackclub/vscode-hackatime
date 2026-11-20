import adm_zip = require('adm-zip');
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Options, Setting } from './options';

import { getCliLocation, getCliLocationGlobal } from './cli-location';
import { Desktop } from './desktop';
import { downloadToFile, getJson } from './http-get';
import { Logger } from './logger';

export class Dependencies {
  private options: Options;
  private logger: Logger;
  private resourcesLocation: string;
  private cliLocation?: string = undefined;
  private cliLocationGlobal?: string = undefined;
  private cliInstalled: boolean = false;
  private githubDownloadUrl = 'https://github.com/hackclub/hackatime-cli/releases/latest/download';
  private githubReleasesUrl = 'https://api.github.com/repos/hackclub/hackatime-cli/releases/latest';

  constructor(options: Options, logger: Logger, resourcesLocation: string) {
    this.options = options;
    this.logger = logger;
    this.resourcesLocation = resourcesLocation;
  }

  public getCliLocation(): string {
    if (this.cliLocation) return this.cliLocation;
    this.cliLocation = getCliLocation(this.resourcesLocation, this.logger);
    return this.cliLocation;
  }

  public getCliLocationGlobal(): string | undefined {
    if (this.cliLocationGlobal) return this.cliLocationGlobal;
    this.cliLocationGlobal = getCliLocationGlobal(this.logger);
    return this.cliLocationGlobal;
  }

  public isCliInstalled(): boolean {
    if (this.cliInstalled) return true;
    this.cliInstalled = fs.existsSync(this.getCliLocation());
    return this.cliInstalled;
  }

  public checkAndInstallCli(callback: () => void): void {
    if (!this.isCliInstalled()) {
      this.installCli(callback);
    } else {
      this.isCliLatest((isLatest) => {
        if (!isLatest) {
          this.installCli(callback);
        } else {
          callback();
        }
      });
    }
  }

  private isCliLatest(callback: (arg0: boolean) => void): void {
    if (this.getCliLocationGlobal()) {
      callback(true);
      return;
    }

    let args = ['--version'];
    const options = Desktop.buildOptions();
    try {
      child_process.execFile(this.getCliLocation(), args, options, (error, _stdout, stderr) => {
        if (!(error != null)) {
          let currentVersion = _stdout.toString().trim() + stderr.toString().trim();
          this.logger.debug(`Current hackatime-cli version is ${currentVersion}`);

          if (currentVersion === '<local-build>') {
            callback(true);
            return;
          }

          this.options.getSetting(
            'internal',
            'cli_version_last_accessed',
            true,
            (accessed: Setting) => {
              const now = Math.round(Date.now() / 1000);
              const lastAccessed = parseInt(accessed.value);
              const fourHours = 4 * 3600;
              if (lastAccessed && lastAccessed + fourHours > now) {
                this.logger.debug(
                  `Skip checking for hackatime-cli updates because recently checked ${
                    now - lastAccessed
                  } seconds ago.`,
                );
                callback(true);
                return;
              }

              this.logger.debug('Checking for updates to hackatime-cli...');
              this.getLatestCliVersion((latestVersion) => {
                if (currentVersion === latestVersion) {
                  this.logger.debug('hackatime-cli is up to date');
                  callback(true);
                } else if (latestVersion) {
                  this.logger.debug(`Found an updated hackatime-cli ${latestVersion}`);
                  callback(false);
                } else {
                  this.logger.debug('Unable to find latest hackatime-cli version');
                  callback(true);
                }
              });
            },
          );
        } else {
          callback(false);
        }
      });
    } catch (e) {
      callback(false);
    }
  }

  private getLatestCliVersion(callback: (arg0: string) => void): void {
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      this.options.getSetting('settings', 'no_ssl_verify', false, (noSSLVerify: Setting) => {
        this.logger.debug(
          `Fetching latest hackatime-cli version from GitHub API: ${this.githubReleasesUrl}`,
        );
        if (proxy.value) this.logger.debug(`Using Proxy: ${proxy.value}`);
        getJson(this.githubReleasesUrl, {
          proxy: proxy.value || undefined,
          strictSSL: noSSLVerify.value !== 'true',
          headers: { 'User-Agent': 'github.com/hackclub/vscode-hackatime' },
        })
          .then(({ status, body }) => {
            if (status == 200 && body?.tag_name) {
              this.logger.debug(`GitHub API Response ${status}`);
              const latestCliVersion = body['tag_name'];
              this.logger.debug(`Latest hackatime-cli version from GitHub: ${latestCliVersion}`);
              this.options.setSetting(
                'internal',
                'cli_version_last_accessed',
                String(Math.round(Date.now() / 1000)),
                true,
              );
              callback(latestCliVersion);
            } else {
              this.logger.warn(`GitHub API Response ${status}`);
              callback('');
            }
          })
          .catch((e) => {
            this.logger.warn(`GitHub API Response Error: ${e}`);
            callback('');
          });
      });
    });
  }

  private installCli(callback: () => void): void {
    this.logger.debug(`Downloading hackatime-cli from GitHub...`);
    const url = this.cliDownloadUrl();
    let zipFile = path.join(this.resourcesLocation, 'hackatime-cli' + this.randStr() + '.zip');
    this.downloadFile(
      url,
      zipFile,
      () => {
        this.extractCli(zipFile, callback);
      },
      callback,
    );
  }

  private isSymlink(file: string): boolean {
    try {
      return fs.lstatSync(file).isSymbolicLink();
    } catch (_) {}
    return false;
  }

  private extractCli(zipFile: string, callback: () => void): void {
    this.logger.debug(`Extracting hackatime-cli into "${this.resourcesLocation}"...`);
    this.backupCli();
    this.unzip(zipFile, this.resourcesLocation, (unzipped) => {
      if (!unzipped) {
        this.restoreCli();
      } else if (!Desktop.isWindows()) {
        this.removeCli();
        const cli = this.getCliLocation();
        try {
          this.logger.debug('Chmod 755 hackatime-cli...');
          fs.chmodSync(cli, 0o755);
        } catch (e) {
          this.logger.warnException(e);
        }
        const ext = Desktop.isWindows() ? '.exe' : '';
        const link = path.join(this.resourcesLocation, `hackatime-cli${ext}`);
        if (!this.isSymlink(link)) {
          try {
            this.logger.debug(`Create symlink from hackatime-cli to ${cli}`);
            fs.symlinkSync(cli, link);
          } catch (e) {
            this.logger.warnException(e);
            try {
              fs.copyFileSync(cli, link);
              fs.chmodSync(link, 0o755);
            } catch (e2) {
              this.logger.warnException(e2);
            }
          }
        }
      }
      callback();
    });
    this.logger.debug('Finished extracting hackatime-cli.');
  }

  private backupCli() {
    if (fs.existsSync(this.getCliLocation())) {
      fs.renameSync(this.getCliLocation(), `${this.getCliLocation()}.backup`);
    }
  }

  private restoreCli() {
    const backup = `${this.getCliLocation()}.backup`;
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, this.getCliLocation());
    }
  }

  private removeCli() {
    const backup = `${this.getCliLocation()}.backup`;
    if (fs.existsSync(backup)) {
      fs.unlinkSync(backup);
    }
  }

  private downloadFile(
    url: string,
    outputFile: string,
    callback: () => void,
    error: () => void,
  ): void {
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      this.options.getSetting('settings', 'no_ssl_verify', false, (noSSLVerify: Setting) => {
        if (proxy.value) this.logger.debug(`Using Proxy: ${proxy.value}`);
        downloadToFile(url, outputFile, {
          proxy: proxy.value || undefined,
          strictSSL: noSSLVerify.value !== 'true',
        })
          .then(() => callback())
          .catch((e) => {
            this.logger.warn(`Failed to download ${url}`);
            this.logger.warn(String(e));
            error();
          });
      });
    });
  }

  private unzip(file: string, outputDir: string, callback: (unzipped: boolean) => void): void {
    if (fs.existsSync(file)) {
      try {
        let zip = new adm_zip(file);
        zip.extractAllTo(outputDir, true);
        fs.unlinkSync(file);
        callback(true);
        return;
      } catch (e) {
        this.logger.warnException(e);
      }
      try {
        fs.unlinkSync(file);
      } catch (e2) {
        this.logger.warnException(e2);
      }
      callback(false);
    }
  }

  private architecture(): string {
    const arch = os.arch();
    if (arch.indexOf('32') > -1) return '386';
    if (arch.indexOf('x64') > -1) return 'amd64';
    return arch;
  }

  private osName(): string {
    let osname = os.platform() as string;
    if (osname == 'win32') osname = 'windows';
    return osname;
  }

  private cliDownloadUrl(): string {
    const osname = this.osName();
    const arch = this.architecture();

    return `${this.githubDownloadUrl}/hackatime-cli-${osname}-${arch}.zip`;
  }

  private randStr(): string {
    return (Math.random() + 1).toString(36).substring(7);
  }
}
