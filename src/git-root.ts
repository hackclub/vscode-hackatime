import * as fs from 'fs';
import * as path from 'path';

// folders people often run `git init` in by accident, which then swallow every project below
const BROAD_FOLDER_NAMES = ['desktop', 'documents', 'downloads'];

// returns the nearest folder at or above `folder` containing a .git entry (a directory, or a
// file for worktrees and submodules), the same way wakatime-cli picks a project. '' if none.
export function findGitRoot(folder: string, maxDepth = 500): string {
  let current = path.resolve(folder);
  for (let depth = 0; depth < maxDepth; depth++) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return '';
    current = parent;
  }
  return '';
}

// true when a repo at `root` is too broad to be a single project: the home folder, anything
// above it, a drive/filesystem root, or Desktop/Documents/Downloads (including the OneDrive
// copies Windows redirects them to, like "OneDrive - School Name\Desktop").
export function isTooBroadGitRoot(root: string, home: string, isWindows: boolean): boolean {
  const p = isWindows ? path.win32 : path.posix;
  const normalize = (s: string) => {
    const resolved = p.resolve(s);
    return isWindows ? resolved.toLowerCase() : resolved;
  };

  const r = normalize(root);
  const h = normalize(home);

  if (p.parse(r).root === r) return true;
  if (r === h) return true;
  if (h.startsWith(r.endsWith(p.sep) ? r : r + p.sep)) return true;

  const name = p.basename(r).toLowerCase();
  if (!BROAD_FOLDER_NAMES.includes(name)) return false;
  const parent = p.dirname(r);
  if (parent === h) return true;
  return p.dirname(parent) === h && p.basename(parent).toLowerCase().startsWith('onedrive');
}
