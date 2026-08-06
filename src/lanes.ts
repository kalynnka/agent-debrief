import * as path from "path";

import { Git } from "./git";

/** A line of work, keyed by the checked-out branch (PRD §4.2). Snapshot numbering,
 * review state and comments are all per-lane, and everything shared across a
 * clone's worktrees — snapshot refs, state files — hangs off the git common dir,
 * because `.git` is a file in a linked worktree and refs are shared. */
export interface Lane {
  /** Top of this worktree, as git reports it (symlinks resolved). */
  root: string;
  /** The `.git` shared by every worktree of the clone. */
  commonDir: string;
  /** The branch, or `detached/<sha>` when HEAD is detached. */
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
  const name = lane ?? (await currentBranch(git)) ?? `detached/${await shortHead(git)}`;
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

/** What a detached HEAD is called. The commit itself, because that is the only
 * thing distinguishing one detached state from another: the worktree's directory
 * name — what this used to fall back to — is the same for every detached
 * checkout in a clone, so a `git bisect` run appended its steps to one lane, and
 * on a clone whose directory shares a name with a branch it appended them to that
 * branch's lane. */
async function shortHead(git: Git): Promise<string> {
  return (await git.run(["rev-parse", "--short", "HEAD"])).trim();
}

/** Where a branch got its name, when it has no review state of its own.
 *
 * `cut` is a branch created from another and not moved since — still exactly the
 * branch it was cut from, so the review carries over. `renamed` is the same work
 * with nothing left behind, so that one moves rather than copies.
 *
 * Read from the branch's own reflog, which records both. Undefined once the
 * branch has moved on: from then on it is a line of work of its own, and
 * inheriting someone else's snapshots would be a claim about code they never
 * saw. */
export interface LaneOrigin {
  kind: "cut" | "renamed";
  from: string;
}

export async function laneOrigin(git: Git, name: string): Promise<LaneOrigin | undefined> {
  let log: string[];
  try {
    log = (await git.run(["reflog", "show", "--format=%gs", `refs/heads/${name}`]))
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    // No reflog for this branch — core.logAllRefUpdates off, or a fresh clone.
    return undefined;
  }
  if (log.length === 0) {
    return undefined;
  }
  const renamed = /^Branch: renamed refs\/heads\/(.+) to refs\/heads\/.+$/.exec(log[0]);
  if (renamed !== null) {
    return { kind: "renamed", from: renamed[1] };
  }
  if (log.length !== 1 || !log[0].startsWith("branch: Created from")) {
    return undefined;
  }
  // The reflog says the branch was created but not from what — `Created from
  // HEAD` is all it records — so the branch we were on last is the answer. It is
  // git's own `@{-1}`, and it is right for the case that matters: the cut we are
  // still standing in.
  try {
    const previous = (await git.run(["rev-parse", "--symbolic-full-name", "@{-1}"])).trim();
    const branch = /^refs\/heads\/(.+)$/.exec(previous);
    return branch === null ? undefined : { kind: "cut", from: branch[1] };
  } catch {
    return undefined;
  }
}
