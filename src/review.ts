import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { ChangedFile, Git, Hunk, Snapshot, snapshotRef } from "./git";
import { Lane, laneOrigin, resolveLane } from "./lanes";
import { Anchor, State, Store } from "./state";

export interface SnapshotOptions {
  label?: string;
  /** The agent's closing message in full, when the host gives one. */
  message?: string;
  described?: Snapshot["described"];
  /** claude | codex | copilot | manual. */
  agent: string;
  session?: string;
}

/** `created: false` when the tree is identical to the previous snapshot's —
 * snapshotting is idempotent: no snapshot, no ref, exit clean (PRD §5.2). */
export type SnapshotResult =
  | { created: false }
  | { created: true; snapshot: Snapshot; files: ChangedFile[] };

export function hashLines(lines: string[]): string {
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Anchor a thread to lines of a file as they exist at a revision. `rev` is the
 * snapshot the reviewer was reading (undefined when no snapshot exists yet); the lines
 * come from the document in front of the reviewer, which is what they anchored. */
export async function makeAnchor(
  git: Git,
  rev: string | undefined,
  file: string,
  startLine: number,
  endLine: number,
  documentLines: string[],
): Promise<Anchor> {
  const blobSha = rev === undefined ? undefined : await git.blobAt(rev, file);
  return {
    file,
    startLine,
    endLine,
    blobSha: blobSha ?? "",
    contentHash: hashLines(documentLines.slice(startLine, endLine + 1)),
  };
}

/** Capture one snapshot: allocate the lane's next number, write the working tree
 * through the lane's private index, record it, and carry open comment
 * threads forward into it. The whole read-modify-write runs under the lane's
 * lock, so a Stop-hook CLI process and the extension cannot lose each other's
 * updates — and cannot interleave on the shared private index file. */
export async function takeSnapshot(
  git: Git,
  store: Store,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  return store.withLock(async (state) => {
    const previous = state.snapshots[state.snapshots.length - 1];
    const empty = await git.emptyTree();
    const parent = previous?.sha ?? (await git.head()) ?? empty;
    const seeded = parent === empty ? undefined : parent;
    const tree = await git.writeSnapshotTree(store.indexFile, seeded);
    const parentTree = seeded === undefined ? empty : await git.treeOf(seeded);
    if (tree === parentTree) {
      return { created: false };
    }
    const n = (previous?.n ?? 0) + 1;
    const label = opts.label !== undefined && opts.label !== "" ? opts.label : `snapshot ${n}`;
    const sha = await git.commitTree(tree, `octoview snapshot ${n}: ${label}`, seeded);
    await git.updateRef(snapshotRef(store.lane.name, n), sha);
    const files = await git.changedFiles(parent, sha);
    const snapshot: Snapshot = {
      n,
      sha,
      parent,
      label,
      message: opts.message,
      described: opts.described,
      at: new Date().toISOString(),
      agent: opts.agent,
      session: opts.session,
    };
    state.snapshots.push(snapshot);
    await carryForward(git, state, sha, files);
    return { created: true, snapshot, files };
  });
}

/** Carry a lane's review onto a branch that was just cut from another, or
 * renamed.
 *
 * A branch cut mid-review is the same work under a new name: the snapshots, what
 * has been read and the open threads all still describe the code in front of you,
 * and leaving them on the branch you came from abandons the review at the moment
 * it is being organised. A rename leaves nothing behind at all, so that one moves
 * the lane — old refs and directory included — rather than copying it.
 *
 * Only ever runs into a lane that has never been written, so it cannot overwrite
 * a review; `laneOrigin` decides whether there is anything to carry, and answers
 * only while the new branch still stands exactly where it was created.
 *
 * The refs are re-pointed at the same commits rather than rebuilt: a ref is a
 * pointer, so a lane of fifty snapshots costs fifty `update-ref` calls and not one
 * new object. */
export async function adoptLane(git: Git, lane: Lane): Promise<void> {
  const store = new Store(lane);
  if (await store.exists()) {
    return;
  }
  const origin = await laneOrigin(git, lane.name);
  if (origin === undefined) {
    return;
  }
  const source = new Store(await resolveLane(lane.root, origin.from));
  if (!(await source.exists())) {
    return;
  }
  await source.load();
  if (origin.kind === "renamed") {
    await fs.mkdir(path.dirname(lane.dir), { recursive: true });
    await fs.rename(source.dir, lane.dir);
  } else {
    await store.withLock((state) => {
      state.schemaVersion = source.data.schemaVersion;
      state.snapshots = source.data.snapshots;
      state.reviewed = source.data.reviewed;
      state.threads = source.data.threads;
    });
  }
  for (const snapshot of source.data.snapshots) {
    await git.updateRef(snapshotRef(lane.name, snapshot.n), snapshot.sha);
    if (origin.kind === "renamed") {
      await git.deleteRef(snapshotRef(origin.from, snapshot.n));
    }
  }
}

/** How far a commit can reach: the unbroken run of reviewed snapshots from the
 * start of the lane, and the reviewed snapshots beyond it that it cannot take.
 *
 * A commit is a prefix of the lane's history — snapshot 12's content sits on top
 * of snapshot 11's, so there is no way to land one without the other. Reviewing
 * out of order is still allowed; it just leaves snapshots stranded until the gap
 * is read.
 *
 * Adjacency is in the list, not in the numbering. Dropping a snapshot leaves a
 * hole in the numbers for good, and a numeric rule would let one dropped snapshot
 * block committing for the rest of the lane's life. */
export function committableRun(snapshots: { n: number; reviewed: boolean }[]): {
  through: number | undefined;
  blocked: number[];
} {
  let end = 0;
  while (end < snapshots.length && snapshots[end].reviewed) {
    end++;
  }
  return {
    through: end === 0 ? undefined : snapshots[end - 1].n,
    blocked: snapshots
      .slice(end)
      .filter((snapshot) => snapshot.reviewed)
      .map((snapshot) => snapshot.n),
  };
}

/** A commit that landed some snapshots, and which ones. */
export interface LandedCommit {
  sha: string;
  message: string;
  /** The snapshot numbers it took, ascending. Not necessarily a run: a reviewer
   * who commits a staged subset lands part of the lane and leaves the rest. */
  snapshots: number[];
}

/** What each path the lane touched held at each snapshot that changed it —
 * everything landing is decided from, gathered in one pass.
 *
 * A blob of `undefined` is a real answer: the snapshot deleted the path. */
interface LaneContent {
  /** Paths each snapshot changed, index-aligned with the snapshots. */
  paths: string[][];
  /** path → snapshot index → the blob that snapshot left there. */
  held: Map<string, Map<number, string | undefined>>;
}

async function laneContent(git: Git, snapshots: Snapshot[]): Promise<LaneContent> {
  const changed = await Promise.all(
    snapshots.map((snapshot) => git.changedFiles(snapshot.parent, snapshot.sha)),
  );
  const paths = changed.map((files) => files.map((file) => file.path));
  const held = new Map<string, Map<number, string | undefined>>();
  await Promise.all(
    snapshots.map(async (snapshot, i) => {
      const blobs = await git.blobsAt(snapshot.sha, paths[i]);
      for (const file of paths[i]) {
        const versions = held.get(file) ?? new Map<number, string | undefined>();
        versions.set(i, blobs.get(file));
        held.set(file, versions);
      }
    }),
  );
  return { paths, held };
}

/** Whether every change a snapshot made is present at a revision.
 *
 * A snapshot's change to a path is present when the revision holds the blob that
 * snapshot left there — or the blob a *later* snapshot left, since a change
 * written over by later work still reached the branch through it. Without the
 * "or later" a lane of fifty snapshots could only ever land in its last commit.
 *
 * Quantified over every path the snapshot changed, never over the ones it still
 * owns. A snapshot whose files a later one all rewrote owns nothing, and "every
 * file it owns matches" is then vacuously true — which once marked 28 of 36
 * snapshots committed in a repo that had never been committed to. A snapshot with
 * no changed paths does not exist, so this can never be vacuous. */
function present(content: LaneContent, index: number, at: Map<string, string>): boolean {
  return content.paths[index].every((file) => {
    for (const [i, blob] of content.held.get(file) ?? []) {
      if (i >= index && blob === at.get(file)) {
        return true;
      }
    }
    return false;
  });
}

/** The commits that have landed snapshots of this lane, oldest first.
 *
 * Recognised by content, not by tree equality. A commit octoview makes holds a
 * snapshot's tree exactly, but a reviewer who stages what they have read and
 * commits that produces a tree matching nothing — and that is the normal way to
 * work, not the exception. So a commit takes every snapshot whose changes it
 * completes, and a snapshot is credited to the earliest commit that completed it.
 *
 * Nothing is recorded: amending, rebasing or resetting simply changes the answer.
 *
 * The walk stops where the lane started — snapshot 1's parent — with a numeric
 * bound as the backstop, since a rebase can leave that parent off the branch. */
export async function landedCommits(
  git: Git,
  snapshots: Snapshot[],
  head: string | undefined,
): Promise<LandedCommit[]> {
  if (head === undefined || snapshots.length === 0) {
    return [];
  }
  const history = await git.commitsFrom(head, snapshots.length + 20);
  const base = history.findIndex((commit) => commit.sha === snapshots[0].parent);
  const walk = (base < 0 ? history : history.slice(0, base)).reverse();
  const content = await laneContent(git, snapshots);
  const files = [...new Set(content.paths.flat())];
  const pending = new Set(snapshots.map((_, i) => i));
  const grouped: LandedCommit[] = [];
  for (const commit of walk) {
    if (pending.size === 0) {
      break;
    }
    const at = await git.blobsAt(commit.sha, files);
    // Insertion order is ascending index, so the numbers come out in order.
    const took = [...pending].filter((i) => present(content, i, at));
    if (took.length === 0) {
      continue;
    }
    took.forEach((i) => pending.delete(i));
    grouped.push({
      sha: commit.sha,
      message: commit.message,
      snapshots: took.map((i) => snapshots[i].n),
    });
  }
  return grouped;
}

/** Which snapshots have reached a commit — the same answer as `landedCommits`,
 * without which commit did it, and the same by construction rather than by two
 * rules that have to be kept in step.
 *
 * `head` is undefined on an unborn HEAD, where nothing is committed. */
export async function landedSnapshots(
  git: Git,
  snapshots: Snapshot[],
  head: string | undefined,
): Promise<Set<number>> {
  const commits = await landedCommits(git, snapshots, head);
  return new Set(commits.flatMap((commit) => commit.snapshots));
}

/** Take paths back out of a snapshot and out of every snapshot after it, so none
 * of them still claims a change the reviewer has undone.
 *
 * A snapshot is the working tree measured against the one before it, which means
 * anything that happens between two of them lands on the next. Restoring a file
 * without this would leave the newest snapshot disagreeing with disk, and the
 * agent's next snapshot would open by recording the reviewer's revert as its own
 * work — a deletion nobody made.
 *
 * Every snapshot after `from` holds the same content for these paths, which is the
 * condition the revert is offered under, so planting the version from before
 * `from` into all of them leaves each of their own diffs exactly as it was. Only
 * the first snapshot's diff changes, by losing the paths — and the newest snapshot
 * ends up matching disk again, which is the point.
 *
 * The snapshot shas change, so the refs and the recorded parents move with them —
 * and the old sha of every rewritten snapshot is returned against its new one,
 * since anything already pointing at a snapshot (an open diff) has to be told. */
export async function revertPaths(
  git: Git,
  store: Store,
  from: number,
  paths: string[],
): Promise<Map<string, string>> {
  const moved = new Map<string, string>();
  if (paths.length === 0) {
    return moved;
  }
  await store.withLock(async (state) => {
    const start = state.snapshots.findIndex((snapshot) => snapshot.n === from);
    if (start < 0) {
      throw new Error(`octoview: no snapshot ${from} to revert from`);
    }
    const rewriting = state.snapshots.slice(start);
    const mine = await git.entriesAt(rewriting[0].sha, paths);
    for (const snapshot of rewriting.slice(1)) {
      const theirs = await git.entriesAt(snapshot.sha, paths);
      for (const file of paths) {
        if (theirs.get(file)?.blob !== mine.get(file)?.blob) {
          throw new Error(
            `octoview: snapshot ${snapshot.n} changed ${file} after snapshot ${from} — ` +
              `revert that snapshot first`,
          );
        }
      }
    }
    const base = await git.entriesAt(rewriting[0].parent, paths);
    const planted = new Map(paths.map((file) => [file, base.get(file)]));
    const empty = await git.emptyTree();
    let parent = rewriting[0].parent;
    for (const snapshot of rewriting) {
      const sha = await git.rewriteCommit(
        store.indexFile,
        snapshot.sha,
        parent === empty ? undefined : parent,
        `octoview snapshot ${snapshot.n}: ${snapshot.label}`,
        planted,
      );
      await git.updateRef(snapshotRef(store.lane.name, snapshot.n), sha);
      moved.set(snapshot.sha, sha);
      snapshot.parent = parent;
      snapshot.sha = sha;
      parent = sha;
    }
  });
  return moved;
}

/** Take a snapshot out of the history: its ref, its record, and everything that
 * described only it — the review mark made at that snapshot, and every thread
 * opened against it, submitted ones included. A comment about a change that no
 * longer exists is not a comment about anything.
 *
 * Any snapshot, not only the newest. Deleting its ref does not strand its commit:
 * the snapshot after it was committed with it as the git parent, so that later
 * ref keeps the whole chain reachable and its `parent` sha resolving.
 *
 * `thread.snapshot` is the snapshot the thread was opened under and stays that
 * way: `carryForward` moves a thread's anchor into later snapshots but never
 * re-stamps its number, so this filter takes exactly the threads that were about
 * snapshot `n`.
 *
 * The caller restores the files first. Together the two put the lane back where it
 * was before the snapshot — and when it was the newest, that includes its number:
 * `takeSnapshot` reads the last snapshot's number, so the next one takes it back.
 * Dropping from the middle leaves a gap, which is honest. */
export async function dropSnapshot(git: Git, store: Store, n: number): Promise<void> {
  await store.withLock(async (state) => {
    state.snapshots = state.snapshots.filter((snapshot) => snapshot.n !== n);
    // Exactly this snapshot's mark. A file marked reviewed at a *later* snapshot was
    // reviewed against a change this one has nothing to do with.
    for (const file of Object.keys(state.reviewed)) {
      if (state.reviewed[file] === n) {
        delete state.reviewed[file];
      }
    }
    state.threads = state.threads.filter((thread) => thread.snapshot !== n);
    await git.deleteRef(snapshotRef(store.lane.name, n));
  });
}

/** Carry open threads into the new snapshot (§4.5): a thread whose file the
 * snapshot changed is re-anchored where its exact lines now live — following a
 * rename — and marked outdated when those lines no longer exist. Untouched files
 * keep their anchors, which still match the new snapshot bit for bit. */
async function carryForward(
  git: Git,
  state: State,
  sha: string,
  files: ChangedFile[],
): Promise<void> {
  const changed = new Map(files.map((f) => [f.path, f]));
  const renamed = new Map(
    files
      .filter((f): f is ChangedFile & { oldPath: string } => f.oldPath !== undefined)
      .map((f) => [f.oldPath, f]),
  );
  for (const thread of state.threads) {
    if (thread.state === "resolved" || thread.outdated) {
      continue;
    }
    const record = changed.get(thread.anchor.file) ?? renamed.get(thread.anchor.file);
    if (record === undefined) {
      continue;
    }
    if (record.status === "D" || thread.anchor.blobSha === "") {
      thread.outdated = true;
      continue;
    }
    const oldLines = (await git.blobContent(thread.anchor.blobSha)).split("\n");
    const block = oldLines.slice(thread.anchor.startLine, thread.anchor.endLine + 1);
    const found =
      block.length === 0
        ? undefined
        : locate((await git.fileAt(sha, record.path)).split("\n"), block, thread.anchor.startLine);
    if (found === undefined) {
      thread.outdated = true;
      continue;
    }
    thread.anchor = {
      file: record.path,
      startLine: found,
      endLine: found + block.length - 1,
      blobSha: (await git.blobAt(sha, record.path)) ?? "",
      contentHash: thread.anchor.contentHash,
    };
  }
}

export interface HistoryLine {
  text: string;
  /** The snapshot that introduced this line; undefined when it predates the
   * selection (present in the base state). */
  born?: number;
  /** The snapshot that superseded or removed this line; undefined while it is
   * still present in the newest selected state. */
  died?: number;
}

/** One file's evolution across the selected snapshots, every version of every line
 * kept in place: base lines, superseded intermediates and survivors, in
 * chronological order, each annotated with the snapshot that introduced it and
 * the one that ended it. Built by replaying `git diff -U0` hunks between each
 * consecutive pair of states. */
export async function stackedHistory(
  git: Git,
  file: string,
  base: string,
  snapshots: Snapshot[],
): Promise<HistoryLine[]> {
  const origin = await git.fileAt(base, file);
  const entries: StackEntry[] = splitLines(origin).map((text) => ({ text, live: true }));
  let previous = base;
  for (const snapshot of snapshots) {
    const hunks = await git.diffHunks(previous, snapshot.sha, file);
    // Hunk positions refer to the pre-state; applying back to front keeps the
    // earlier positions valid while later ones mutate the entry list.
    for (const hunk of [...hunks].reverse()) {
      applyHunk(entries, hunk, snapshot.n);
    }
    previous = snapshot.sha;
  }
  return entries.map(({ text, born, died }) => ({ text, born, died }));
}

/** Render a file's history as unified-diff text, which the editor's `diff`
 * grammar colors natively: a line born in the selection shows `+` on arrival,
 * a line that later died shows `-` at the same spot — so a value edited twice
 * reads `+v1 -v1 +v2 -v2 +v3`, the flow in place. Base lines that survived
 * everything are plain context. */
export function renderHistory(lines: HistoryLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.born !== undefined) {
      out.push(`+${line.text}`);
    }
    if (line.died !== undefined) {
      out.push(`-${line.text}`);
    } else if (line.born === undefined) {
      out.push(` ${line.text}`);
    }
  }
  return out.length === 0 ? "" : out.join("\n") + "\n";
}

interface StackEntry {
  text: string;
  live: boolean;
  born?: number;
  died?: number;
}

function applyHunk(entries: StackEntry[], hunk: Hunk, snapshot: number): void {
  const liveIndex = (nth: number): number => {
    let seen = 0;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].live) {
        seen++;
        if (seen === nth) {
          return i;
        }
      }
    }
    return entries.length;
  };
  let insertAt: number;
  if (hunk.oldCount === 0) {
    insertAt = hunk.oldStart === 0 ? 0 : liveIndex(hunk.oldStart) + 1;
  } else {
    const replaced: number[] = [];
    let i = liveIndex(hunk.oldStart);
    while (replaced.length < hunk.oldCount && i < entries.length) {
      if (entries[i].live) {
        replaced.push(i);
      }
      i++;
    }
    for (const index of replaced) {
      entries[index].live = false;
      entries[index].died = snapshot;
    }
    insertAt = replaced.length === 0 ? entries.length : replaced[replaced.length - 1] + 1;
  }
  entries.splice(
    insertAt,
    0,
    ...hunk.newLines.map((text) => ({ text, live: true, born: snapshot })),
  );
}

function splitLines(content: string): string[] {
  if (content === "") {
    return [];
  }
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** The occurrence of `block` in `lines` nearest to line `near`, so a thread
 * follows its own copy of repeated code rather than the first lookalike. */
function locate(lines: string[], block: string[], near: number): number | undefined {
  let best: number | undefined;
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (block.every((line, j) => lines[i + j] === line)) {
      if (best === undefined || Math.abs(i - near) < Math.abs(best - near)) {
        best = i;
      }
    }
  }
  return best;
}
