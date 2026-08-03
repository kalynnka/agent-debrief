import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const exec = promisify(execFile);

/** Where snapshot refs live: outside refs/heads, so `git branch` never lists a
 * turn — and lane-scoped, because refs are shared across a clone's worktrees and
 * unscoped turn numbers collide between two worktrees of one clone. */
export function turnRef(lane: string, n: number): string {
  return `refs/octoview/turns/${lane}/${n}`;
}

export interface Turn {
  n: number;
  sha: string;
  /** The revision this turn is diffed against — the previous turn's sha, HEAD at
   * snapshot time for the first turn, or the empty tree when HEAD was unborn. */
  parent: string;
  label: string;
  at: string;
  /** Which agent produced the turn: claude | codex | copilot | manual. */
  agent: string;
  /** That agent's session id, when the host exposes one — what makes the
   * feedback round-trip's `--resume` possible later. */
  session?: string;
}

export interface ChangedFile {
  path: string;
  /** One letter: A, M, D, R, C, T — rename/copy similarity scores are stripped. */
  status: string;
  /** The pre-rename path; present only on R and C records. */
  oldPath?: string;
}

export class Git {
  constructor(readonly root: string) {}

  async run(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await exec("git", args, {
      cwd: this.root,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  static async discoverRoot(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  /** HEAD's sha, or undefined when HEAD is unborn (a fresh `git init`). */
  async head(): Promise<string | undefined> {
    try {
      return (await this.run(["rev-parse", "--verify", "-q", "HEAD"])).trim();
    } catch (error) {
      // With -q, exit 1 is rev-parse's quiet answer for "no such revision".
      if ((error as { code?: number }).code === 1) {
        return undefined;
      }
      throw error;
    }
  }

  /** The empty tree's id in this repo's hash algorithm — the diff base for a
   * turn snapshotted on an unborn HEAD, which has no commit to diff against. */
  async emptyTree(): Promise<string> {
    return (await this.run(["hash-object", "-t", "tree", "/dev/null"])).trim();
  }

  async treeOf(rev: string): Promise<string> {
    return (await this.run(["rev-parse", `${rev}^{tree}`])).trim();
  }

  /** Stage the working tree into a private index file and return the resulting
   * tree, touching neither the user's index nor HEAD.
   *
   * The private index is seeded from `seed` first — this is required, not an
   * optimization. Without it `add -A` starts from an empty index, where a file
   * that is tracked but also matched by `.gitignore` looks like a new ignored
   * file rather than a tracked one — so it is skipped, and every turn reports it
   * as deleted. On an unborn HEAD there is nothing to seed from and `--empty`
   * also clears any stale content a previous turn left in the index file. */
  async writeSnapshotTree(indexFile: string, seed: string | undefined): Promise<string> {
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    const env = { GIT_INDEX_FILE: indexFile };
    await this.run(seed === undefined ? ["read-tree", "--empty"] : ["read-tree", seed], env);
    await this.run(["add", "-A"], env);
    return (await this.run(["write-tree"], env)).trim();
  }

  async commitTree(tree: string, message: string, parent?: string): Promise<string> {
    const args = ["commit-tree", tree, "-m", message];
    if (parent !== undefined) {
      args.push("-p", parent);
    }
    return (await this.run(args)).trim();
  }

  async updateRef(ref: string, sha: string): Promise<void> {
    await this.run(["update-ref", ref, sha]);
  }

  async deleteRef(ref: string): Promise<void> {
    await this.run(["update-ref", "-d", ref]);
  }

  /** Changed files between two revisions. Rename detection is forced on (`-M`)
   * so behavior does not depend on the user's diff config, and rename/copy
   * records are parsed as the three fields they carry — status, old path, new
   * path — where pair-wise parsing would silently drop the new path. */
  async changedFiles(from: string, to: string): Promise<ChangedFile[]> {
    const out = await this.run(["diff", "--name-status", "-z", "-M", from, to]);
    const parts = out.split("\0");
    const files: ChangedFile[] = [];
    let i = 0;
    while (i < parts.length && parts[i] !== "") {
      const letter = parts[i][0];
      if (letter === "R" || letter === "C") {
        files.push({ status: letter, oldPath: parts[i + 1], path: parts[i + 2] });
        i += 3;
      } else {
        files.push({ status: letter, path: parts[i + 1] });
        i += 2;
      }
    }
    return files;
  }

  /** File content at a revision, or empty string when the file did not exist
   * there (an added file has no left-hand side). */
  async fileAt(sha: string, filePath: string): Promise<string> {
    try {
      return await this.run(["show", `${sha}:${filePath}`]);
    } catch {
      return "";
    }
  }

  /** The blob id of a file at a revision, or undefined when absent there. */
  async blobAt(rev: string, filePath: string): Promise<string | undefined> {
    try {
      return (await this.run(["rev-parse", "--verify", "-q", `${rev}:${filePath}`])).trim();
    } catch (error) {
      if ((error as { code?: number }).code === 1) {
        return undefined;
      }
      throw error;
    }
  }

  /** Content of a blob object — how a comment anchor's lines are re-read. */
  async blobContent(blobSha: string): Promise<string> {
    return this.run(["cat-file", "blob", blobSha]);
  }
}
