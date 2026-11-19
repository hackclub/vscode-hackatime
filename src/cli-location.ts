import * as os from 'os';
import * as path from 'path';
import * as which from 'which';

import { Desktop } from './desktop';
import { Logger } from './logger';

let cliLocationGlobal: string | undefined = undefined;

function architecture(): string {
  const arch = os.arch();
  if (arch.indexOf('32') > -1) return '386';
  if (arch.indexOf('x64') > -1) return 'amd64';
  return arch;
}

function osName(): string {
  let name = os.platform() as string;
  if (name == 'win32') name = 'windows';
  return name;
}

export function getCliLocationGlobal(logger?: Logger): string | undefined {
  if (cliLocationGlobal) return cliLocationGlobal;

  const binaryName = `wakatime-cli${Desktop.isWindows() ? '.exe' : ''}`;
  const found = which.sync(binaryName, { nothrow: true });
  if (found) {
    cliLocationGlobal = found;
    logger?.debug(`Using global wakatime-cli location: ${found}`);
  }

  return cliLocationGlobal;
}

export function getCliLocation(resourcesFolder: string, logger?: Logger): string {
  const global = getCliLocationGlobal(logger);
  if (global) return global;

  const ext = Desktop.isWindows() ? '.exe' : '';
  const binary = `wakatime-cli-${osName()}-${architecture()}${ext}`;
  return path.join(resourcesFolder, binary);
}
