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
  /** What the agent said when it finished, in full — the label is its first
   * line. Absent on turns taken before this was kept, and on any turn snapshotted
   * without a transcript to read it from. */
  message?: string;
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

export interface DiffStat {
  added: number;
  deleted: number;
}

export interface TreeEntry {
  /** The mode git records for the path — 100644, 100755, 120000. Planting a blob
   * into another tree needs it; dropping it would turn an executable or a symlink
   * into a plain file. */
  mode: string;
  blob: string;
}

export interface Hunk {
  /** 1-based first replaced line in the old file; the line *after* which to
   * insert when `oldCount` is 0 (unified-diff convention, 0 = at the top). */
  oldStart: number;
  oldCount: number;
  newLines: string[];
}

export class Git {
  /** `<sha>:<path>` → its tree entry, or undefined for "not in that revision".
   * Both halves of the key are immutable, so an answer never goes stale. */
  private readonly entries = new Map<string, TreeEntry | undefined>();
  /** `<from>..<to>` → the diff between two commits, likewise fixed for good. */
  private readonly diffs = new Map<string, ChangedFile[]>();
  /** The same pairs, counted rather than named. */
  private readonly stats = new Map<string, Map<string, DiffStat>>();
  /** `<rev>` → its tree, for the revisions whose trees get compared repeatedly. */
  private readonly trees = new Map<string, string>();

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

  /** Cached: every caller passes a commit sha, whose tree never changes. Which
   * turns a commit has taken is one of these per turn per refresh, so uncached
   * this would be a process per turn on a lane of any length. */
  async treeOf(rev: string): Promise<string> {
    const known = this.trees.get(rev);
    if (known !== undefined) {
      return known;
    }
    const tree = (await this.run(["rev-parse", `${rev}^{tree}`])).trim();
    this.trees.set(rev, tree);
    return tree;
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

  /** A revision and its ancestors, newest first, with each one's full message —
   * how a commit that landed some turns is recognised and named. */
  async commitsFrom(rev: string, limit: number): Promise<{ sha: string; message: string }[]> {
    const out = await this.run([
      "log",
      `--max-count=${limit}`,
      "--format=%H%x00%B%x00",
      rev,
    ]);
    const parts = out.split("\0");
    const commits: { sha: string; message: string }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].trim();
      if (sha !== "") {
        commits.push({ sha, message: parts[i + 1].trim() });
      }
    }
    return commits;
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
    const cached = this.diffs.get(`${from}..${to}`);
    if (cached !== undefined) {
      return cached;
    }
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
    this.diffs.set(`${from}..${to}`, files);
    return files;
  }

  /** Lines added and deleted per file between two revisions — the numbers a
   * review header counts. Cached like `changedFiles` and for the same reason: two
   * commits never change what lies between them.
   *
   * A binary file reports `-` for both counts, which reads as zero here: it has
   * no lines to have changed, and a header saying so would be a lie either way. */
  async diffStat(from: string, to: string): Promise<Map<string, DiffStat>> {
    const cached = this.stats.get(`${from}..${to}`);
    if (cached !== undefined) {
      return cached;
    }
    const out = await this.run(["diff", "--numstat", "-z", "-M", from, to]);
    const parts = out.split("\0");
    const stat = new Map<string, DiffStat>();
    const count = (text: string): number => (text === "-" ? 0 : Number(text));
    let i = 0;
    while (i < parts.length && parts[i] !== "") {
      const [added, deleted, file] = parts[i].split("\t");
      // A rename leaves the path field empty and puts the old and new paths in
      // the two records after it — the same shape `--name-status -z` uses.
      const at = file === "" ? parts[i + 2] : file;
      stat.set(at, { added: count(added), deleted: count(deleted) });
      i += file === "" ? 3 : 1;
    }
    this.stats.set(`${from}..${to}`, stat);
    return stat;
  }

  /** One change region of a file between two revisions, from `-U0` unified
   * output: which old lines it replaces and the new lines' text. Enough to
   * replay a file's evolution without reimplementing a diff algorithm. */
  async diffHunks(from: string, to: string, filePath: string): Promise<Hunk[]> {
    const out = await this.run(["diff", "-U0", "--no-renames", from, to, "--", filePath]);
    const hunks: Hunk[] = [];
    for (const line of out.split("\n")) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      if (header !== null) {
        hunks.push({
          oldStart: Number(header[1]),
          oldCount: header[2] === undefined ? 1 : Number(header[2]),
          newLines: [],
        });
      } else if (line.startsWith("+") && !line.startsWith("+++") && hunks.length > 0) {
        hunks[hunks.length - 1].newLines.push(line.slice(1));
      }
    }
    return hunks;
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

  /** Tree entries for `paths` at a revision; a path the revision does not have is
   * simply absent from the map.
   *
   * Every caller passes a commit sha, so a (rev, path) answer can never change —
   * which is what makes the cache sound, and what keeps the Turns view's
   * per-turn comparisons off the process table once it is warm. */
  async entriesAt(rev: string, paths: string[]): Promise<Map<string, TreeEntry>> {
    const unseen = paths.filter((file) => !this.entries.has(`${rev}:${file}`));
    if (unseen.length > 0) {
      const found = new Map<string, TreeEntry>();
      const listing = await this.run(["ls-tree", "-r", "-z", rev, "--", ...unseen]);
      for (const entry of listing.split("\0")) {
        if (entry !== "") {
          const [meta, file] = entry.split("\t");
          const parts = meta.split(" ");
          found.set(file, { mode: parts[0], blob: parts[2] });
        }
      }
      for (const file of unseen) {
        this.entries.set(`${rev}:${file}`, found.get(file));
      }
    }
    const at = new Map<string, TreeEntry>();
    for (const file of paths) {
      const entry = this.entries.get(`${rev}:${file}`);
      if (entry !== undefined) {
        at.set(file, entry);
      }
    }
    return at;
  }

  /** Only the blob ids — what comparing one revision against another needs, and
   * what keeps those comparisons readable. */
  async blobsAt(rev: string, paths: string[]): Promise<Map<string, string>> {
    const at = await this.entriesAt(rev, paths);
    return new Map([...at].map(([file, entry]) => [file, entry.blob]));
  }

  /** Rebuild a commit with some paths forced to a given entry — or removed, where
   * the entry is undefined — and commit the result onto `parent`.
   *
   * Everything happens in the lane's private index file, so the reviewer's own
   * index never takes part. */
  async rewriteCommit(
    indexFile: string,
    sha: string,
    parent: string | undefined,
    message: string,
    planted: Map<string, TreeEntry | undefined>,
  ): Promise<string> {
    const env = { GIT_INDEX_FILE: indexFile };
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    await this.run(["read-tree", sha], env);
    for (const [file, entry] of planted) {
      await this.run(
        entry === undefined
          ? ["update-index", "--force-remove", "--", file]
          : ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.blob},${file}`],
        env,
      );
    }
    const tree = (await this.run(["write-tree"], env)).trim();
    return this.commitTree(tree, message, parent);
  }

  /** Blob ids of the working tree's own copies — one `hash-object` for every
   * path that exists, so a whole lane costs one process rather than one each. */
  async blobsOnDisk(paths: string[]): Promise<Map<string, string>> {
    const present: string[] = [];
    for (const file of paths) {
      if (await fs.stat(path.join(this.root, file)).then(() => true, () => false)) {
        present.push(file);
      }
    }
    const onDisk = new Map<string, string>();
    if (present.length > 0) {
      const hashes = (await this.run(["hash-object", "--", ...present])).trim().split("\n");
      present.forEach((file, i) => onDisk.set(file, hashes[i]));
    }
    return onDisk;
  }

  /** Which of `paths` still hold on disk exactly the content they had at `rev`.
   *
   * Blob ids, not `git diff <rev>`: a file the turn created but nobody has staged
   * is untracked, and `git diff` calls every untracked path deleted, which would
   * report the newest turn's own files as drifted. A path absent from both sides
   * counts as unchanged — that is a deletion still holding. */
  async unchangedSince(rev: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) {
      return new Set();
    }
    const [committed, onDisk] = await Promise.all([
      this.blobsAt(rev, paths),
      this.blobsOnDisk(paths),
    ]);
    return new Set(paths.filter((file) => committed.get(file) === onDisk.get(file)));
  }

  /** Whether anything is staged — the index differs from HEAD. What a reviewer
   * who stages as they read would lose if the index were replaced. */
  async staged(): Promise<boolean> {
    try {
      await this.run(["diff-index", "--cached", "--quiet", "HEAD"]);
      return false;
    } catch (error) {
      // diff-index --quiet reports differences as exit 1, the same way `diff` does.
      if ((error as { code?: number }).code === 1) {
        return true;
      }
      throw error;
    }
  }

  /** Commit a revision's tree as its own commit on the current branch, leaving
   * the working tree alone.
   *
   * This is what "commit through turn N" means: the snapshot is the content, so
   * the index is loaded from it and `git commit` records that — the working tree
   * never moves, and everything later turns did stays uncommitted on disk.
   *
   * `git commit` rather than plumbing, so the repo's hooks, signing and reflog
   * behave as they do for any other commit. That is also why the index is put
   * back when the commit does not happen: a rejecting pre-commit hook would
   * otherwise leave the reviewer holding an index they never staged. */
  async commitSnapshot(rev: string, message: string): Promise<string> {
    await this.run(["read-tree", rev]);
    try {
      await this.run(["commit", "-m", message]);
    } catch (error) {
      await this.run(["read-tree", "HEAD"]);
      throw error;
    }
    return (await this.run(["rev-parse", "HEAD"])).trim();
  }

  /** Put one path back to how it was at `rev`, in the working tree only — the
   * index belongs to the reviewer. A path the revision does not have is removed,
   * which is what "how it was" means for a file the turn added. */
  async restoreFile(rev: string, filePath: string): Promise<void> {
    if ((await this.blobAt(rev, filePath)) === undefined) {
      await fs.rm(path.join(this.root, filePath), { force: true });
      return;
    }
    await this.run(["restore", "--source", rev, "--worktree", "--", filePath]);
  }

  /** The same for a set of changed files. A rename needs both of its paths: the
   * new one ceases to exist at `rev`, and the old one comes back. */
  async restoreFiles(rev: string, files: ChangedFile[]): Promise<void> {
    for (const file of files) {
      await this.restoreFile(rev, file.path);
      if (file.oldPath !== undefined) {
        await this.restoreFile(rev, file.oldPath);
      }
    }
  }
}
