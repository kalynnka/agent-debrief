import * as path from "path";

import { Git } from "./git";

/** A line of work, keyed by the checked-out branch (PRD §4.2). Turn numbering,
 * review state and comments are all per-lane, and everything shared across a
 * clone's worktrees — turn refs, state files — hangs off the git common dir,
 * because `.git` is a file in a linked worktree and refs are shared. */
export interface Lane {
  /** Top of this worktree, as git reports it (symlinks resolved). */
  root: string;
  /** The `.git` shared by every worktree of the clone. */
  commonDir: string;
  /** The branch, or the worktree's directory name when HEAD is detached. */
  name: string;
  /** This lane's state directory: `<commonDir>/octoview/<name>`. */
  dir: string;
}

export async function resolveLane(repo: string, lane?: string): Promise<Lane> {
  const root = await Git.discoverRoot(repo);
  if (root === undefined) {
    throw new Error(`not a git repository: ${repo}`);
  }
  const git = new Git(root);
  const commonDir = path.resolve(
    root,
    (await git.run(["rev-parse", "--git-common-dir"])).trim(),
  );
  const name = lane ?? (await currentBranch(git)) ?? path.basename(root);
  // Lane names become ref segments and directory segments; a branch name is safe
  // by git's own refname rules, but an explicit --lane is arbitrary input.
  const segments = name.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`invalid lane name: '${name}'`);
  }
  return { root, commonDir, name, dir: path.join(commonDir, "octoview", ...segments) };
}

/** The checked-out branch, or undefined on a detached HEAD.
 *
 * `symbolic-ref` still answers on an unborn HEAD (a fresh `git init`), so a repo
 * with no commits resolves to its init branch rather than falling back. */
async function currentBranch(git: Git): Promise<string | undefined> {
  try {
    return (await git.run(["symbolic-ref", "--short", "-q", "HEAD"])).trim();
  } catch (error) {
    // With -q, exit 1 is symbolic-ref's answer for "not a symbolic ref".
    if ((error as { code?: number }).code === 1) {
      return undefined;
    }
    throw error;
  }
}
