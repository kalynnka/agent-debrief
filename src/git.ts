import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";

const exec = promisify(execFile);

/** How many `git` processes octoview will have running at once, across every
 * repository in the workspace.
 *
 * The work is fanned out with `Promise.all` — one call per snapshot, per repo —
 * so without a limit the peak is however much work happens to be waiting: a lane
 * of 60 uncommitted snapshots measured 120 processes at once, and a workspace of
 * five such lanes would be five times that. Nothing in git minds, but the machine
 * does: file descriptors, memory, and on Windows a process is far dearer to start
 * than it is here.
 *
 * This caps the peak, not the total. The total is what it is — the view needs
 * every answer it asks for, and refusing to ask would mean drawing something
 * untrue. Queueing costs nothing when the queue is empty, which is the common
 * case: a working-tree redraw peaks at one. */
const MAX_CONCURRENT = 32;

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Where snapshot refs live: outside refs/heads, so `git branch` never lists a
 * snapshot — and lane-scoped, because refs are shared across a clone's worktrees
 * and unscoped snapshot numbers collide between two worktrees of one clone. */
export function snapshotRef(lane: string, n: number): string {
  return `refs/octoview/snapshots/${lane}/${n}`;
}

/** What keeps a cleared lane's starting point alive. One per lane, replaced on
 * each clear, and a GC root exactly as a snapshot ref is. */
export function baseRef(lane: string): string {
  return `refs/octoview/base/${lane}`;
}

export interface Snapshot {
  n: number;
  sha: string;
  /** The revision this snapshot is diffed against — the previous snapshot's sha,
   * HEAD at capture time for the first one, or the empty tree when HEAD was
   * unborn. */
  parent: string;
  label: string;
  /** What the agent said when it finished, in full — the label is its first
   * line. Absent on snapshots taken before this was kept, and on any snapshot
   * captured without a transcript to read it from. */
  message?: string;
  /** Who that message came from. `agent` means the agent described the snapshot
   * itself and had therefore finished its turn; `transcript` means the hook
   * answered for it, scraping whatever was last said — which is what an
   * interrupted turn leaves behind, so the snapshot may be work in the middle of
   * being done. Absent when neither happened: a snapshot from before this was
   * kept, or one taken by hand. */
  described?: "agent" | "transcript";
  at: string;
  /** Which agent produced the snapshot: claude | codex | copilot | manual. */
  agent: string;
  /** That agent's session id, when the host exposes one — what makes the
   * feedback round-trip's `--resume` possible later. */
  session?: string;
  /** HEAD when the snapshot was taken.
   *
   * A snapshot diffs against the snapshot before it, never against HEAD, so
   * anything that moved HEAD in between — a commit, a pull, a reset — is invisible
   * in the diff and shows up only here. When it differs from the previous
   * snapshot's, some of what this snapshot appears to have done was not the
   * agent's doing. Absent on snapshots taken before this was recorded. */
  head?: string;
  /** `refs/stash` when the snapshot was taken, or `""` when there was no stash.
   *
   * A stash puts the working tree back where the snapshot started, which is
   * exactly what a reviewer reverting the snapshot looks like — so without this
   * the rows report work as thrown away when it is sitting safely in the stash.
   * Absent on snapshots taken before this was recorded, which is not the same as
   * `""` and must not be read as one. */
  stash?: string;
}

export interface ChangedFile {
  path: string;
  /** One letter: A, M, D, R, C, T — rename/copy similarity scores are stripped. */
  status: string;
  /** The pre-rename path; present only on R and C records. */
  oldPath?: string;
}

/** One commit of a chain: what it changed, and what it left there. */
export interface ChainCommit {
  sha: string;
  files: { path: string; blob: string | undefined }[];
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
  /** `<rev>..<base>|<renames>` → the walk between them. Two commits never change
   * what lies between them, so this is sound for the life of the process — and it
   * is what keeps a second structural redraw from re-reading a whole lane. */
  private readonly chains = new Map<string, ChainCommit[]>();

  constructor(readonly root: string) {}

  async run(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    // Only the spawn is inside the slot. Anything that awaited another `run`
    // while holding one could deadlock against itself once the queue filled.
    const { stdout } = await withSlot(() =>
      exec("git", args, {
        cwd: this.root,
        env: env ? { ...process.env, ...env } : process.env,
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
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
   * snapshot taken on an unborn HEAD, which has no commit to diff against. */
  async emptyTree(): Promise<string> {
    return (await this.run(["hash-object", "-t", "tree", "/dev/null"])).trim();
  }

  /** Cached: every caller passes a commit sha, whose tree never changes. Which
   * snapshots a commit has landed is one of these per snapshot per refresh, so
   * uncached this would be a process per snapshot on a lane of any length. */
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
   * file rather than a tracked one — so it is skipped, and every snapshot reports
   * it as deleted. On an unborn HEAD there is nothing to seed from and `--empty`
   * also clears any stale content a previous snapshot left in the index file. */
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
   * how a commit that landed some snapshots is recognised and named. */
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

  /** What the worktree is in the middle of, named for a message, or undefined
   * when it is in the middle of nothing.
   *
   * A snapshot taken now would record conflict markers and half-applied commits
   * as the agent's own work, and a revert would be fighting the operation for the
   * same files. These marker files are git's own answer — the same ones its
   * prompt and `status` read. */
  async operationInProgress(): Promise<string | undefined> {
    const dir = path.resolve(this.root, (await this.run(["rev-parse", "--git-dir"])).trim());
    const markers: [string, string][] = [
      ["MERGE_HEAD", "a merge"],
      ["rebase-merge", "a rebase"],
      ["rebase-apply", "a rebase"],
      ["CHERRY_PICK_HEAD", "a cherry-pick"],
      ["REVERT_HEAD", "a revert"],
      ["BISECT_LOG", "a bisect"],
    ];
    for (const [marker, what] of markers) {
      if (await fs.stat(path.join(dir, marker)).then(() => true, () => false)) {
        return what;
      }
    }
    return undefined;
  }

  /** Every branch in the clone, by short name. One process, so a sweep can ask
   * about every lane at once rather than asking git about each. */
  async branches(): Promise<Set<string>> {
    const out = await this.run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return new Set(out.split("\n").filter((name) => name !== ""));
  }

  /** The stash's tip, or `""` when the repo has none.
   *
   * Empty string rather than undefined, because a snapshot records this and the
   * two answers have to stay apart: `""` is "there was no stash", `undefined` is
   * "this snapshot predates the field and cannot say". */
  async stashTip(): Promise<string> {
    try {
      return (await this.run(["rev-parse", "--verify", "-q", "refs/stash"])).trim();
    } catch (error) {
      if ((error as { code?: number }).code === 1) {
        return "";
      }
      throw error;
    }
  }

  /** Every ref under a prefix, full names. */
  async refsUnder(prefix: string): Promise<string[]> {
    const out = await this.run(["for-each-ref", "--format=%(refname)", prefix]);
    return out.split("\n").filter((ref) => ref !== "");
  }

  /** Whether a ref exists — how a lane learns its branch is gone. */
  async refExists(ref: string): Promise<boolean> {
    try {
      await this.run(["show-ref", "--verify", "--quiet", "--", ref]);
      return true;
    } catch (error) {
      // show-ref reports "no such ref" as exit 1, the way its siblings do.
      if ((error as { code?: number }).code === 1) {
        return false;
      }
      throw error;
    }
  }

  /** Whether a commit is still in the object store.
   *
   * Once octoview lets go of a snapshot's ref the commit is unreachable, and how
   * long it survives after that is git's business — a grace period, then the next
   * `gc`. This is how a lane finds out that decision has been made. */
  async has(sha: string): Promise<boolean> {
    return this.run(["cat-file", "-e", `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
  }

  async deleteRef(ref: string): Promise<void> {
    await this.run(["update-ref", "-d", ref]);
  }

  /** Every commit from `rev` back to (not including) `base`, with the paths each
   * changed and the blob it left there — the whole snapshot chain in one process.
   *
   * The alternative is `changedFiles` plus `blobsAt` per snapshot, which is two
   * processes each and the reason a long lane took seconds to draw: at ~8ms of
   * spawn overhead apiece, a thousand snapshots is two thousand processes for
   * data one `git log` already holds.
   *
   * A snapshot's git parent *is* the revision it is diffed against, so the raw
   * output for a commit is exactly what `changedFiles(parent, sha)` reports —
   * same `-M`, same statuses. An all-zero post-image is git's way of saying the
   * path is gone, and reads back as undefined.
   *
   * Commits the caller does not know about — a dropped snapshot still linking the
   * chain — come back too, and are ignored by not being asked for. */
  async chain(
    rev: string,
    base: string | undefined,
    /** `-M` reports a rename as one record naming only the new path, which is
     * what `changedFiles` does and what a snapshot's own file list should say.
     * A caller replaying commits into a running path→blob map needs the opposite:
     * without renames a rename is a delete and an add, so the old path is
     * correctly forgotten instead of keeping a stale blob for ever. */
    renames = true,
  ): Promise<ChainCommit[]> {
    const key = `${rev}..${base ?? ""}|${String(renames)}`;
    const cached = this.chains.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const args = ["log", "--format=%H", "--raw", "--no-abbrev", renames ? "-M" : "--no-renames", "-z", rev];
    if (base !== undefined && (await this.has(base))) {
      args.push(`^${base}`);
    }
    const parts = (await this.run(args)).split("\0");
    const commits: ChainCommit[] = [];
    let i = 0;
    while (i < parts.length) {
      const token = parts[i].replace(/^\n/, "");
      if (token === "") {
        i++;
        continue;
      }
      if (!token.startsWith(":")) {
        commits.push({ sha: token, files: [] });
        i++;
        continue;
      }
      // `:<oldmode> <newmode> <oldblob> <newblob> <status>` then its path, or two
      // paths when the status is a rename or copy.
      const fields = token.slice(1).split(" ");
      const status = fields[4] ?? "";
      const renamed = status.startsWith("R") || status.startsWith("C");
      const blob = fields[3] ?? "";
      const gone = /^0+$/.test(blob);
      commits[commits.length - 1]?.files.push({
        path: renamed ? parts[i + 2] : parts[i + 1],
        blob: gone ? undefined : blob,
      });
      i += renamed ? 3 : 2;
    }
    this.chains.set(key, commits);
    return commits;
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
   * which is what makes the cache sound, and what keeps the Snapshots view's
   * per-snapshot comparisons off the process table once it is warm. */
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
   * Blob ids, not `git diff <rev>`: a file the snapshot created but nobody has
   * staged is untracked, and `git diff` calls every untracked path deleted, which
   * would report the newest snapshot's own files as drifted. A path absent from
   * both sides counts as unchanged — that is a deletion still holding. */
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
   * This is what "commit through snapshot N" means: the snapshot is the content,
   * so the index is loaded from it and `git commit` records that — the working
   * tree never moves, and everything later snapshots did stays uncommitted on disk.
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
   * which is what "how it was" means for a file the snapshot added. */
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
