import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const BRANCH_REVIEW_DIR = '.branchReview';
const REMOTE = 'origin';

export type Logger = (message: string) => void;

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
  } catch {
    return undefined;
  }
}

export function folderNameForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function branchReviewRoot(repoRoot: string): string {
  return path.join(repoRoot, BRANCH_REVIEW_DIR);
}

/** Deletes the .branchReview folder. Returns false if it did not exist. */
export async function clearBranchReview(repoRoot: string): Promise<boolean> {
  const root = branchReviewRoot(repoRoot);
  try {
    await fs.stat(root);
  } catch {
    return false;
  }
  await fs.rm(root, { recursive: true, force: true });
  return true;
}

/**
 * Fetches the branch from origin (when available), then exports its tree into
 * .branchReview/<branch>. Existing content of that folder is replaced.
 * Uses a temporary index file, so the user's index, HEAD and working tree are not modified.
 * Returns the destination folder path.
 */
export async function downloadBranch(repoRoot: string, branch: string, log: Logger): Promise<string> {
  if (!branch || branch.startsWith('-')) {
    throw new Error(`Invalid branch name: "${branch}"`);
  }
  try {
    await runGit(repoRoot, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`Invalid branch name: "${branch}"`);
  }

  const remotes = (await runGit(repoRoot, ['remote'])).split('\n').map(r => r.trim());
  if (remotes.includes(REMOTE)) {
    log(`Fetching ${REMOTE}/${branch}...`);
    try {
      await runGit(repoRoot, [
        'fetch', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`
      ]);
    } catch (err) {
      log(`Fetch failed, using local data if available: ${(err as Error).message}`);
    }
  } else {
    log(`No "${REMOTE}" remote configured; using local data.`);
  }

  const commit =
    (await resolveCommit(repoRoot, `refs/remotes/${REMOTE}/${branch}`)) ??
    (await resolveCommit(repoRoot, `refs/heads/${branch}`));
  if (!commit) {
    throw new Error(`Branch "${branch}" was not found locally or on ${REMOTE}.`);
  }

  const destDir = path.join(branchReviewRoot(repoRoot), folderNameForBranch(branch));
  const indexFile = path.join(os.tmpdir(), `branch-review-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: indexFile };

  try {
    log(`Exporting ${branch} (${commit.slice(0, 8)}) to ${path.relative(repoRoot, destDir)}...`);
    await runGit(repoRoot, ['read-tree', commit], env);
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.mkdir(destDir, { recursive: true });
    await runGit(repoRoot, ['checkout-index', '-a', '-f', `--prefix=${destDir}${path.sep}`], env);
  } finally {
    await fs.rm(indexFile, { force: true });
  }

  return destDir;
}

export async function getCurrentBranchName(repoRoot: string): Promise<string | undefined> {
  try {
    const name = (await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name && name !== 'HEAD' ? name : undefined;
  } catch {
    return undefined;
  }
}
