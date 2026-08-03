import * as crypto from "crypto";

import { ChangedFile, Git, Turn, turnRef } from "./git";
import { Anchor, State, Store } from "./state";

export interface SnapshotOptions {
  label?: string;
  /** claude | codex | copilot | manual. */
  agent: string;
  session?: string;
}

/** `created: false` when the tree is identical to the previous turn's —
 * snapshotting is idempotent: no turn, no ref, exit clean (PRD §5.2). */
export type SnapshotResult =
  | { created: false }
  | { created: true; turn: Turn; files: ChangedFile[] };

export function hashLines(lines: string[]): string {
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Anchor a thread to lines of a file as they exist at a revision. `rev` is the
 * turn the reviewer was reading (undefined when no turn exists yet); the lines
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

/** Capture one turn: allocate the lane's next number, snapshot the working tree
 * through the lane's private index, record the turn, and carry open comment
 * threads forward into it. The whole read-modify-write runs under the lane's
 * lock, so a Stop-hook CLI process and the extension cannot lose each other's
 * updates — and cannot interleave on the shared private index file. */
export async function snapshotTurn(
  git: Git,
  store: Store,
  opts: SnapshotOptions,
): Promise<SnapshotResult> {
  return store.withLock(async (state) => {
    const previous = state.turns[state.turns.length - 1];
    const empty = await git.emptyTree();
    const parent = previous?.sha ?? (await git.head()) ?? empty;
    const seeded = parent === empty ? undefined : parent;
    const tree = await git.writeSnapshotTree(store.indexFile, seeded);
    const parentTree = seeded === undefined ? empty : await git.treeOf(seeded);
    if (tree === parentTree) {
      return { created: false };
    }
    const n = (previous?.n ?? 0) + 1;
    const label = opts.label !== undefined && opts.label !== "" ? opts.label : `turn ${n}`;
    const sha = await git.commitTree(tree, `octoview turn ${n}: ${label}`, seeded);
    await git.updateRef(turnRef(store.lane.name, n), sha);
    const files = await git.changedFiles(parent, sha);
    const turn: Turn = {
      n,
      sha,
      parent,
      label,
      at: new Date().toISOString(),
      agent: opts.agent,
      session: opts.session,
    };
    state.turns.push(turn);
    await carryForward(git, state, sha, files);
    return { created: true, turn, files };
  });
}

/** Carry open threads into the new turn (§4.5): a thread whose file the turn
 * changed is re-anchored where its exact lines now live — following a rename —
 * and marked outdated when those lines no longer exist. Untouched files keep
 * their anchors, which still match the new snapshot bit for bit. */
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
