import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// helpers around wakatime-cli's offline queue (offline_heartbeats.bdb). heartbeats sent
// without an api key exit with 104 but still land in this queue, and the cli flushes it to
// whichever account the next successful heartbeat belongs to.

const QUEUE_FILE = 'offline_heartbeats.bdb';
// enough to get an accurate time range without loading an unbounded amount of json
const MAX_PRINTED = 50000;

function run(
  binary: string,
  args: string[],
  options: child_process.ExecFileOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      binary,
      args,
      { ...options, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout.toString());
      },
    );
  });
}

export async function getOfflineCount(
  binary: string,
  options: child_process.ExecFileOptions,
): Promise<number> {
  const out = await run(binary, ['--offline-count'], options);
  const count = parseInt(out.trim(), 10);
  if (!Number.isFinite(count)) throw new Error(`unexpected --offline-count output: ${out}`);
  return count;
}

// unix timestamps (seconds) of queued heartbeats, oldest first
export async function getOfflineTimes(
  binary: string,
  count: number,
  options: child_process.ExecFileOptions,
): Promise<number[]> {
  // --print-offline-heartbeats 0 prints nothing, so ask for the real count
  const limit = Math.min(Math.max(count, 1), MAX_PRINTED);
  const out = await run(binary, ['--print-offline-heartbeats', String(limit)], options);
  const parsed = JSON.parse(out.trim() || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.map((h) => Number(h?.time)).filter((t) => Number.isFinite(t));
}

// where wakatime-cli keeps the queue: straight inside WAKATIME_HOME when that's set,
// otherwise in ~/.wakatime
export function getOfflineQueueFile(env: NodeJS.ProcessEnv = process.env): string {
  const wakatimeHome = env.WAKATIME_HOME?.trim();
  if (wakatimeHome) return path.join(wakatimeHome, QUEUE_FILE);
  return path.join(os.homedir(), '.wakatime', QUEUE_FILE);
}

// deletes the queue, then asks the cli to confirm it's empty. throws if anything is left,
// so callers never go on to save a key that would sync someone else's time.
export async function discardOfflineQueue(
  binary: string,
  options: child_process.ExecFileOptions,
): Promise<void> {
  const file = getOfflineQueueFile(options.env ?? process.env);
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const left = await getOfflineCount(binary, options);
  if (left !== 0) throw new Error(`${left} saved heartbeats are still queued in ${file}`);
}
