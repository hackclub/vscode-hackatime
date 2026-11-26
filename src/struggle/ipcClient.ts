// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2026 Hackatime Contributors

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export interface SessionStatusResult {
  version: string;
  tracking_mode?: 'normal' | 'struggle' | string;
  uptime_seconds: number;
  active_projects: number;
  pending_windows: number;
  synced_windows?: number;
  pending_raw_seconds?: number;
  pending_credited_seconds?: number;
  pending_struggle_points?: number;
  total_local_windows?: number;
  total_local_raw_seconds?: number;
  total_local_credited_seconds?: number;
  total_local_struggle_points?: number;
  pending_legacy_heartbeats: number;
  active_project: string;
  primary_language: string;
  ai_harness: string;
  active_seconds: number;
  preview_struggle_points: number;
  preview_multiplier: number;
  builder_state: 'idle' | 'deep_focus' | 'diff_surgery' | 'error_loop' | 'unverified_ai_burst' | string;
  os_focus?: string;
  os_focus_app?: string;
  open_agentic_apps?: string[];
}

export interface LocalWindowItem {
  window_start_unix: number;
  raw_seconds: number;
  credited_seconds: number;
  struggle_points: number;
  effective_multiplier: number;
  persisted_diff_lines: number;
  primary_language: string;
  ai_harness: string;
  signal_counts: Record<string, number>;
  synced: boolean;
}

export interface LocalReportResult {
  status: SessionStatusResult;
  recent_windows: LocalWindowItem[];
}

/**
 * Resolves the exact local owner-only IPC endpoint used by hackatime-d:
 * - Windows:     \\.\pipe\hackatime-d
 * - Linux/macOS: $XDG_RUNTIME_DIR/hackatime-d.sock (fallback /tmp/hackatime-d-<uid>.sock)
 */
export function resolveIpcEndpoint(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\hackatime-d';
  }
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, 'hackatime-d.sock');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  return `/tmp/hackatime-d-${uid}.sock`;
}

export class DaemonIpcClient {
  private readonly endpoint: string;

  constructor(endpoint: string = resolveIpcEndpoint()) {
    this.endpoint = endpoint;
  }

  public getEndpoint(): string {
    return this.endpoint;
  }

  /**
   * Sends a single newline-delimited JSON-RPC 2.0 frame to hackatime-d.
   * Fail-safe: returns null on timeout or disconnect so the IDE never stalls.
   */
  public send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 1500
  ): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (val: T | null): void => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };

      const socket = net.createConnection(this.endpoint);
      let buffer = '';

      const timer = setTimeout(() => {
        socket.destroy();
        done(null);
      }, timeoutMs);

      socket.on('connect', () => {
        const frame = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
        socket.write(frame);
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl !== -1) {
          clearTimeout(timer);
          const line = buffer.slice(0, nl).trim();
          socket.end();
          try {
            const parsed = JSON.parse(line) as { result?: T; error?: unknown };
            done(parsed.result ?? null);
          } catch {
            done(null);
          }
        }
      });

      socket.on('error', () => {
        clearTimeout(timer);
        done(null);
      });

      socket.on('close', () => {
        clearTimeout(timer);
        done(null);
      });
    });
  }

  public getSessionStatus(projectRoot?: string): Promise<SessionStatusResult | null> {
    const params: Record<string, unknown> = projectRoot ? { project_root: projectRoot } : {};
    return this.send<SessionStatusResult>('session.status', params, 2000);
  }

  public getLocalReport(projectRoot?: string): Promise<LocalReportResult | null> {
    const params: Record<string, unknown> = projectRoot ? { project_root: projectRoot } : {};
    return this.send<LocalReportResult>('struggle.local_report', params, 2000);
  }

  public async requestShutdown(): Promise<boolean> {
    const res = await this.send<{ shutting_down?: boolean }>('daemon.shutdown', {}, 400);
    return Boolean(res?.shutting_down);
  }
}
