import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { ChangedFile, Git, Hunk, Snapshot, baseRef, snapshotRef } from "./git";
import { Lane, laneOrigin, resolveLane } from "./lanes";
import { Anchor, State, Store, Thread } from "./state";

export interface SnapshotOptions {
  label?: string;
  /** The agent's closing message in full, when the host gives one. */
  message?: string;
  described?: Snapshot["described"];
  /** claude | codex | copilot | manual. */
  agent: string;
  session?: string;
}

/** Not every call takes a snapshot, and the two reasons are different facts.
 * `unchanged` is idempotence working — the tree is identical to the previous
 * snapshot's, so no snapshot, no ref, exit clean (PRD §5.2). `mid-operation` is a
 * refusal: git is part-way through something and the worktree is nobody's work
 * yet. */
export type SnapshotResult =
  | { created: false; reason: "unchanged" }
  | { created: false; reason: "mid-operation"; operation: string }
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

/** The anchor for a comment written against `from`, expressed at `to`.
 *
 * `carryForward` walks every other anchor to the newest snapshot as each one
 * lands. A comment written on an older diff missed those trips, so it makes them
 * all at once here — otherwise it keeps coordinates nothing else reads, and
 * `review open` sends the agent to the wrong line by number. Lines that are gone
 * by `to` come back `outdated`. */
export async function anchorForward(
  git: Git,
  file: string,
  startLine: number,
  endLine: number,
  documentLines: string[],
  from: string | undefined,
  to: string | undefined,
): Promise<{ anchor: Anchor; outdated: boolean }> {
  const anchor = await makeAnchor(git, from, file, startLine, endLine, documentLines);
  if (from === undefined || to === undefined || from === to) {
    return { anchor, outdated: false };
  }
  const record = (await git.changedFiles(from, to)).find(
    (f) => f.path === file || f.oldPath === file,
  );
  // Nothing between the two revisions touched the file, so the coordinates still
  // hold and the blob under them is the same object either way.
  if (record === undefined) {
    return { anchor, outdated: false };
  }
  if (record.status === "D") {
    return { anchor, outdated: true };
  }
  const block = documentLines.slice(startLine, endLine + 1);
  const found =
    block.length === 0
      ? undefined
      : locate((await git.fileAt(to, record.path)).split("\n"), block, startLine);
  if (found === undefined) {
    return { anchor, outdated: true };
  }
  return {
    anchor: {
      ...anchor,
      file: record.path,
      startLine: found,
      endLine: found + block.length - 1,
      blobSha: (await git.blobAt(to, record.path)) ?? "",
    },
    outdated: false,
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
  // Conflict markers and half-applied commits belong to the operation, not to the
  // agent, and a snapshot cannot say which is which. Refused rather than captured:
  // a snapshot nobody can attribute is worse than no snapshot.
  const operation = await git.operationInProgress();
  if (operation !== undefined) {
    return { created: false, reason: "mid-operation", operation };
  }
  return store.withLock(async (state) => {
    const previous = state.snapshots[state.snapshots.length - 1];
    const empty = await git.emptyTree();
    const head = await git.head();
    // A cleared lane starts from the tree the reviewer cleared at, not from HEAD:
    // otherwise the first snapshot afterwards claims every uncommitted change
    // that was already sitting there.
    const parent = previous?.sha ?? state.base ?? head ?? empty;
    const seeded = parent === empty ? undefined : parent;
    const tree = await git.writeSnapshotTree(store.indexFile, seeded);
    const parentTree = seeded === undefined ? empty : await git.treeOf(seeded);
    if (tree === parentTree) {
      return { created: false, reason: "unchanged" };
    }
    const n = (previous?.n ?? 0) + 1;
    const label = opts.label !== undefined && opts.label !== "" ? opts.label : `snapshot ${n}`;
    const sha = await git.commitTree(tree, `debrief snapshot ${n}: ${label}`, seeded);
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
      head,
      stash: await git.stashTip(),
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
      state.base = source.data.base;
    });
  }
  for (const snapshot of source.data.snapshots) {
    await git.updateRef(snapshotRef(lane.name, snapshot.n), snapshot.sha);
    if (origin.kind === "renamed") {
      await git.deleteRef(snapshotRef(origin.from, snapshot.n));
    }
  }
  // A lane cleared and then branched from starts where it was cleared, on the new
  // branch as much as on the old: without the ref the commit is unreachable, and
  // without carrying it the new lane falls back to HEAD and claims the tree.
  if (source.data.base !== undefined) {
    await git.updateRef(baseRef(lane.name), source.data.base);
    if (origin.kind === "renamed") {
      await git.deleteRef(baseRef(origin.from));
    }
  }
}

/** Whether the stash has moved since the newest snapshot was taken.
 *
 * `git stash` is the one thing that makes every snapshot look reverted without
 * anything being reverted: the working tree goes back to where the snapshot
 * started, which is the same shape as a reviewer undoing it file by file. Debrief
 * cannot tell those apart from the tree alone, and the cost of guessing wrong is
 * a reviewer dropping the last record of work that is sitting safely in a stash.
 *
 * So it asks the one question it can answer: did the stash move? A heuristic, and
 * the only one in this file — everything else here is derived. It errs toward
 * saying no: a snapshot from before the field existed says nothing rather than
 * guessing, because a false alarm on every old lane would teach people to ignore
 * it. */
export async function stashedSince(git: Git, store: Store): Promise<boolean> {
  const latest = store.latestSnapshot;
  if (latest?.stash === undefined) {
    return false;
  }
  return (await git.stashTip()) !== latest.stash;
}

/** The paths a snapshot shows that were not the agent's doing.
 *
 * A snapshot diffs against the snapshot before it, never against HEAD, so a pull
 * or a merge in between lands inside the diff looking exactly like work the agent
 * did. HEAD is on the record, so the move is knowable: whatever `diff(H0, H1)`
 * touched arrived with it.
 *
 * A path counts as the move's only while the snapshot still holds it exactly as
 * the move left it. Where the two differ the agent wrote over it afterwards, and
 * the top layer is theirs — attributing it elsewhere would hide a real edit,
 * which is the failure worth avoiding here. False negatives are safe; false
 * positives are not.
 *
 * Empty when either revision is gone — a rebase can strand one — because a claim
 * about what a move brought needs the move to still be there to read. */
export async function foreignPaths(
  git: Git,
  all: Snapshot[],
  snapshot: Snapshot,
): Promise<Set<string>> {
  const from = all[all.indexOf(snapshot) - 1]?.head;
  const to = snapshot.head;
  if (from === undefined || to === undefined || from === to) {
    return new Set();
  }
  if (!(await git.has(from)) || !(await git.has(to))) {
    return new Set();
  }
  const paths = (await git.changedFiles(from, to)).map((file) => file.path);
  const [atMove, atSnapshot] = await Promise.all([
    git.blobsAt(to, paths),
    git.blobsAt(snapshot.sha, paths),
  ]);
  return new Set(paths.filter((file) => atMove.get(file) === atSnapshot.get(file)));
}

/** What a sweep found, whether or not it was allowed to act. */
export interface LaneSweep {
  /** Lanes whose branch is gone. Dropping their refs is the whole of what
   * debrief does to them. */
  closed: string[];
  /** Lanes git has already collected the snapshots of — nothing left to review,
   * so the record goes with them. */
  collected: string[];
  /** Refs under `refs/debrief/` that no lane claims — the pre-lane POC scheme's
   * unscoped `refs/debrief/turns/<n>`, and anything a half-finished operation
   * left behind. Nothing can read them, and they pin their objects exactly as a
   * live snapshot's ref does. */
  stray: string[];
}

/** Every lane the clone holds state for, named by the directory that spells it
 * out. A lane directory is one holding `state.json`; `batches/` sits inside one
 * and is never mistaken for another, because the walk stops as soon as it finds
 * the file. The debrief root itself is skipped — POC-era clones have a
 * `state.json` sitting there from before lanes existed, and it names no lane. */
async function laneDirs(commonDir: string): Promise<{ name: string; dir: string }[]> {
  const found: { name: string; dir: string }[] = [];
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (segments.length > 0 && entries.some((e) => e.isFile() && e.name === "state.json")) {
      found.push({ name: segments.join("/"), dir });
      return;
    }
    for (const entry of entries.filter((e) => e.isDirectory())) {
      await walk(path.join(dir, entry.name), [...segments, entry.name]);
    }
  };
  await walk(path.join(commonDir, "debrief"), []);
  return found;
}

/** Let go of the lanes whose branches are gone, and forget the ones git has
 * already collected.
 *
 * Debrief has no retention policy, deliberately. A snapshot ref is a GC root, so
 * while debrief holds one, `git gc --prune=now` cannot touch the snapshot — which
 * is why a lane left behind by `git branch -d` pins its objects forever. Dropping
 * the ref is the entire act: from that moment the snapshot is an ordinary
 * unreachable object, and *git* decides when it goes. A real cleanup then takes
 * the branch and its snapshots together, which is the point.
 *
 * It is not quite the grace a deleted branch gets. A branch's commits stay named
 * in HEAD's reflog for `gc.reflogExpireUnreachable` — 90 days by default — while a
 * snapshot commit was never on a branch and `core.logAllRefUpdates` does not cover
 * `refs/debrief/`, so nothing names it once the ref is gone. `state.json` is what
 * stands in: it keeps every snapshot's sha, so while the objects last a lane can be
 * put back with `git update-ref`. Widening that window is `gc.pruneExpire`, git's
 * own knob rather than one debrief invents.
 *
 * Nothing here deletes an object, and nothing decides a lane is stale on its own
 * authority: a lane is closed because its branch is, and forgotten because git
 * already collected it. */
export async function sweepLanes(git: Git, commonDir: string, apply: boolean): Promise<LaneSweep> {
  const sweep: LaneSweep = { closed: [], collected: [], stray: [] };
  // One listing rather than a `show-ref` per lane: the tree runs this on every
  // refresh to decide whether to offer the button, and the answer is almost always
  // "nothing", which should cost one git process rather than one per lane.
  const branches = await git.branches();
  // Which refs any lane still speaks for, live or dead — what is left over is what
  // nothing can read.
  const claimed = new Set<string>();
  for (const { name, dir } of await laneDirs(commonDir)) {
    const store = new Store({ root: git.root, commonDir, name, dir });
    await store.load();
    const snapshots = store.data.snapshots;
    // A cleared lane holds no snapshots and still holds a ref: the commit its
    // next snapshot will diff against. It is one of the lane's refs in every way
    // that matters here — claimed while the branch lives, let go with the rest.
    const refs = snapshots.map((snapshot) => snapshotRef(name, snapshot.n));
    const shas = snapshots.map((snapshot) => snapshot.sha);
    if (store.data.base !== undefined) {
      refs.push(baseRef(name));
      shas.push(store.data.base);
    }
    for (const ref of refs) {
      claimed.add(ref);
    }
    if (branches.has(name)) {
      continue;
    }
    const held = await Promise.all(refs.map((ref) => git.refExists(ref)));
    if (held.some((yes) => yes)) {
      sweep.closed.push(name);
      if (apply) {
        for (const [i, ref] of refs.entries()) {
          if (held[i]) {
            await git.deleteRef(ref);
          }
        }
      }
      continue;
    }
    // No refs left and no objects behind them: git has been through. An empty
    // lane on a dead branch reaches the same place with nothing to check.
    const alive = await Promise.all(shas.map((sha) => git.has(sha)));
    if (alive.every((yes) => !yes)) {
      sweep.collected.push(name);
      if (apply) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }
  sweep.stray = (await git.refsUnder("refs/debrief/")).filter((ref) => !claimed.has(ref));
  if (apply) {
    for (const ref of sweep.stray) {
      await git.deleteRef(ref);
    }
  }
  return sweep;
}

/** The threads waiting on the agent: everything written, and not yet answered.
 *
 * A comment counts from the moment it exists, whether or not it has been through
 * a Submit. Batching is still what keeps an agent from being interrupted five
 * times, but it is the *pull* that does that work and never the button: nothing
 * reaches an agent until one asks, and it asks once — when the reviewer sends it
 * a message. On top of that, making them press Submit first bought nothing, and
 * cost them the comment they wrote and forgot to send.
 *
 * Submit still writes the batch, which is the record and the thing that leaves
 * this repository. It is no longer what makes a comment visible. */
export function openThreads(store: Store): Thread[] {
  return store.data.threads.filter((thread) => thread.state !== "resolved");
}

/** One repository's open review as text an agent can act on.
 *
 * One rendering serves all three ways it travels — printed by the CLI, put on
 * the clipboard, typed into a terminal — because those differ only in how the
 * text gets there, not in what it should say. One repository, because every one
 * of those three is scoped to a repository: the CLI runs in one, and the buttons
 * are on its row.
 *
 * References are `path:line`, never `@path#Lline`. The `@` form is Claude Code's
 * own and reads well in its input box, but it opens a file picker part-way
 * through the one route that types character by character, and a reference every
 * agent already understands is worth more than one host's autocomplete. */
export function reviewText(threads: Thread[]): string {
  const out = [
    `Debrief review — ${threads.length} comment${threads.length === 1 ? "" : "s"} still open.`,
    'Fix each one, then say what you did: `debrief review reply <id> -m "…"`.',
    "Leave them open — the reviewer closes a thread once the answer satisfies them.",
    "Only close one yourself, with `debrief review resolve <id>`, if they ask you to.",
    "",
  ];
  const ordered = [...threads].sort(
    (a, b) => a.anchor.file.localeCompare(b.anchor.file) || a.anchor.startLine - b.anchor.startLine,
  );
  for (const thread of ordered) {
    const { file, startLine, endLine } = thread.anchor;
    const where =
      startLine === endLine ? `${file}:${startLine + 1}` : `${file}:${startLine + 1}-${endLine + 1}`;
    const about = [thread.id, `snapshot ${thread.snapshot}`];
    if (thread.outdated) {
      about.push("outdated — the lines it was written against have since changed");
    }
    out.push(`${where}  [${about.join(" · ")}]`);
    for (const comment of thread.comments) {
      const [first, ...rest] = comment.body.split("\n");
      out.push(`  ${comment.author}: ${first}`);
      out.push(...rest.map((line) => `    ${line}`));
    }
    out.push("");
  }
  return out.join("\n");
}

/** The agent's answer to a comment, appended to the thread it answers.
 *
 * Answering is not closing. The thread stays open and stays on the file, because
 * whether the fix is the right one is the reviewer's call and they make it from
 * the widget — this is only the agent saying what it did.
 *
 * Undefined when the id names nothing still open, which the caller should treat
 * as a failure rather than a shrug: the work the message describes has already
 * happened, and a dropped answer leaves the reviewer waiting for one. */
export async function replyToThread(
  store: Store,
  id: string,
  body: string,
  author: string,
): Promise<Thread | undefined> {
  return store.withLock((state) => {
    const thread = state.threads.find((t) => t.id === id && t.state !== "resolved");
    thread?.comments.push({ body, author, at: new Date().toISOString() });
    return thread;
  });
}

/** Close the threads an agent says it has dealt with. Returns the ids it
 * recognised, so a caller can report the ones it did not. */
export async function resolveThreads(store: Store, ids: string[]): Promise<string[]> {
  return store.withLock((state) => {
    const closed: string[] = [];
    for (const thread of state.threads) {
      if (ids.includes(thread.id) && thread.state !== "resolved") {
        thread.state = "resolved";
        closed.push(thread.id);
      }
    }
    return closed;
  });
}

/** Let go of every snapshot on the lane you are standing on.
 *
 * `sweepLanes` waits for a branch to be gone before touching anything, which is
 * the right default and no help at all on the branch in front of you: a review
 * that has served its purpose sits there until the branch dies. This is the same
 * act, asked for rather than inferred — the lane's refs dropped, and its record
 * with them.
 *
 * It goes further than the sweep does, and the difference is the whole of its
 * risk. A closed lane keeps its `state.json`, so while the objects last it can be
 * put back with `git update-ref`; this empties the file, so nothing anywhere
 * remembers the shas. The commits are still on disk until git collects them and
 * no longer reachable by any name — which is what "cannot be undone" means here,
 * and why the only caller asks first.
 *
 * The threads go too. A thread is anchored to a snapshot, so a thread whose
 * snapshot is gone is the state `dropSnapshot` already refuses to leave behind.
 *
 * One thing is kept, and it is not a snapshot: **where the lane now starts.** An
 * empty lane falls back to HEAD, so on a tree with uncommitted work in it the
 * next agent turn would open by claiming all of it. Clearing is the one moment
 * debrief can be sure that work is not the agent's — a human is standing there
 * pressing the button — so the tree is written as a commit and the lane is
 * pointed at it. Nothing to read and nothing to review: one ref, so the next
 * snapshot's diff is the agent's own doing and nothing else. */
export async function clearLane(
  git: Git,
  store: Store,
): Promise<{ dropped: number; based: boolean }> {
  return store.withLock(async (state) => {
    for (const snapshot of state.snapshots) {
      await git.deleteRef(snapshotRef(store.lane.name, snapshot.n));
    }
    const dropped = state.snapshots.length;
    state.snapshots = [];
    state.reviewed = {};
    state.threads = [];
    const head = await git.head();
    const tree = await git.writeSnapshotTree(store.indexFile, head);
    // A clean tree needs no baseline: HEAD already is one, and a commit that
    // says the same thing would be a ref kept for nothing.
    const based = head !== undefined && tree !== (await git.treeOf(head));
    state.base = based
      ? await git.commitTree(tree, `debrief base: ${store.lane.name} cleared here`, head)
      : undefined;
    if (state.base === undefined) {
      await git.deleteRef(baseRef(store.lane.name));
    } else {
      await git.updateRef(baseRef(store.lane.name), state.base);
    }
    return { dropped, based };
  });
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
  // One `git log --raw` over the snapshot chain, rather than a `changedFiles` and
  // a `blobsAt` per snapshot. Same data — a snapshot's git parent is the revision
  // it is diffed against — for one process instead of two per snapshot, which is
  // what stopped a long-lived lane costing seconds to draw.
  //
  // `--no-renames`, matching the branch walk this is compared against. Read as a
  // rename, a rename names only the new path, so nothing ever records the old one
  // being retired: a snapshot that added a path the next snapshot renamed away
  // waits for a blob no commit can hold, and stays open for ever.
  const newest = snapshots[snapshots.length - 1];
  const chain = new Map(
    (await git.chain(newest.sha, snapshots[0].parent, false)).map((commit) => [
      commit.sha,
      commit.files,
    ]),
  );
  const paths: string[][] = [];
  const held = new Map<string, Map<number, string | undefined>>();
  for (const [i, snapshot] of snapshots.entries()) {
    // A snapshot whose commit the walk did not reach is one git has collected, or
    // one a rewrite left off the chain. It changed nothing we can prove, so it
    // claims nothing.
    const files = chain.get(snapshot.sha) ?? [];
    paths.push(files.map((file) => file.path));
    for (const file of files) {
      const versions = held.get(file.path) ?? new Map<number, string | undefined>();
      versions.set(i, file.blob);
      held.set(file.path, versions);
    }
  }
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
function present(
  content: LaneContent,
  index: number,
  /** Blobs at a revision. A missing key and a recorded `undefined` mean the same
   * thing — the path is not there — which is also what a deletion looks like. */
  at: Map<string, string | undefined>,
): boolean {
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
 * Recognised by content, not by tree equality. A commit debrief makes holds a
 * snapshot's tree exactly, but a reviewer who stages what they have read and
 * commits that produces a tree matching nothing — and that is the normal way to
 * work, not the exception. So a commit takes every snapshot whose changes it
 * completes, and a snapshot is credited to the earliest commit that completed it.
 *
 * Earliest, but never earlier than the snapshot. A snapshot that undoes work no
 * commit ever took puts a path back to what the branch already holds, so every
 * commit from there on "holds what it left" — including commits made before the
 * snapshot existed, and earliest would credit one of those. Which reads as the
 * undo never having been recorded at all: it is filed under a commit older than
 * itself instead of standing where it was taken.
 *
 * The bound is each snapshot's own `head`, the commit HEAD was on when it was
 * captured. Everything reachable from there is older than the snapshot, so
 * nothing at or before it in the walk may claim it. A snapshot from before that
 * field existed, or one whose HEAD a rebase took off the branch, is unbounded —
 * the same answer as always, rather than a guess.
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
  const files = new Set(content.paths.flat());
  // What each commit of the walk holds for those paths, replayed rather than
  // asked for. Reading it per commit was a `ls-tree` each — the second place this
  // grew without bound, after the snapshot chain. Start from the lane's base and
  // apply what every commit changed: one `log --raw` for the whole branch, and
  // `--no-renames` so a rename retires the old path instead of leaving a stale
  // blob behind it.
  const at = new Map<string, string | undefined>(
    walk.length === 0 ? [] : await git.blobsAt(walk[0].sha, [...files]),
  );
  const changedBy = new Map(
    (await git.chain(head, snapshots[0].parent, false)).map((commit) => [commit.sha, commit.files]),
  );
  // How far along the walk each snapshot was already standing when it was taken.
  // A commit at or before that point predates it and cannot have taken it. Off
  // the walk — the lane's base, or a HEAD a rebase stranded — reads as -1, which
  // no step is below.
  const step = new Map(walk.map((commit, i) => [commit.sha, i]));
  const takenAfter = snapshots.map((snapshot) =>
    snapshot.head === undefined ? -1 : (step.get(snapshot.head) ?? -1),
  );
  const pending = new Set(snapshots.map((_, i) => i));
  const grouped: LandedCommit[] = [];
  for (const [now, commit] of walk.entries()) {
    for (const file of changedBy.get(commit.sha) ?? []) {
      if (files.has(file.path)) {
        at.set(file.path, file.blob);
      }
    }
    if (pending.size === 0) {
      break;
    }
    // Insertion order is ascending index, so the numbers come out in order.
    const took = [...pending].filter((i) => now > takenAfter[i] && present(content, i, at));
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
      throw new Error(`debrief: no snapshot ${from} to revert from`);
    }
    const rewriting = state.snapshots.slice(start);
    const mine = await git.entriesAt(rewriting[0].sha, paths);
    for (const snapshot of rewriting.slice(1)) {
      const theirs = await git.entriesAt(snapshot.sha, paths);
      for (const file of paths) {
        if (theirs.get(file)?.blob !== mine.get(file)?.blob) {
          throw new Error(
            `debrief: snapshot ${snapshot.n} changed ${file} after snapshot ${from} — ` +
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
        `debrief snapshot ${snapshot.n}: ${snapshot.label}`,
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
