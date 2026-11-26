// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2026 Hackatime Contributors

import * as vscode from 'vscode';

export type IdeFamily =
  | 'antigravity'
  | 'cursor'
  | 'windsurf'
  | 'vscodium'
  | 'trae'
  | 'kiro'
  | 'void'
  | 'vscode';

export interface DetectedIde {
  family: IdeFamily;
  appName: string;
  uriScheme: string;
  aiHarness: string;
  isAgenticIde: boolean;
}

/**
 * Auto-detects the host IDE strictly via public vscode.env APIs (zero state.vscdb).
 */
export function detectHostIde(): DetectedIde {
  const appName = vscode.env.appName || 'Visual Studio Code';
  const uriScheme = vscode.env.uriScheme || 'vscode';
  const haystack = `${appName} ${uriScheme}`.toLowerCase();

  if (haystack.includes('antigravity')) {
    return { family: 'antigravity', appName, uriScheme, aiHarness: 'antigravity', isAgenticIde: true };
  }
  if (haystack.includes('cursor')) {
    return { family: 'cursor', appName, uriScheme, aiHarness: 'cursor', isAgenticIde: true };
  }
  if (haystack.includes('windsurf') || haystack.includes('codeium')) {
    return { family: 'windsurf', appName, uriScheme, aiHarness: 'windsurf', isAgenticIde: true };
  }
  if (haystack.includes('trae')) {
    return { family: 'trae', appName, uriScheme, aiHarness: 'trae', isAgenticIde: true };
  }
  if (haystack.includes('kiro')) {
    return { family: 'kiro', appName, uriScheme, aiHarness: 'kiro', isAgenticIde: true };
  }
  if (haystack.includes('void')) {
    return { family: 'void', appName, uriScheme, aiHarness: 'void', isAgenticIde: true };
  }
  if (haystack.includes('vscodium') || haystack.includes('codium')) {
    return { family: 'vscodium', appName, uriScheme, aiHarness: 'none', isAgenticIde: false };
  }

  return { family: 'vscode', appName, uriScheme, aiHarness: 'vscode', isAgenticIde: false };
}
