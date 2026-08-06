import { ChangedFile, DiffStat, Snapshot } from "./git";
import { Repo } from "./repos";
import { foreignPaths } from "./review";

/** One file in the net change of a set of snapshots, with the snapshots that touched it.
 * A snapshot's own file rows say what that snapshot did; this says what a review of
 * several snapshots is a review of. */
export class FileRow {
  constructor(
    readonly repo: Repo,
    readonly file: ChangedFile,
    /** The scoped snapshots that touched it, in order. Their ends are the span its
     * diff covers, and the last of them is the snapshot "viewed" is recorded at. */
    readonly snapshots: Snapshot[],
    readonly stat: DiffStat,
    readonly reviewed: boolean,
    /** Every snapshot that touched this file got it from a HEAD move rather than
     * from the agent — a pull, a merge, a reset. One snapshot's own edit anywhere
     * in the span is enough to make it the agent's again. */
    readonly foreign: boolean,
  ) {}
}

/** The net change of one repository's snapshots, one row per file.
 *
 * Taking the snapshots as an argument is what lets a review tab keep its own scope
 * after the tree's selection has moved on. */
export async function rowsFor(repo: Repo, snapshots: Snapshot[]): Promise<FileRow[]> {
  const rows: FileRow[] = [];
  // Which of the snapshots touched each file. Built from the per-snapshot diffs rather
  // than from one diff across the whole span, because a gap in the selection
  // would otherwise pull in a file only an unselected snapshot changed.
  const perSnapshot = await Promise.all(
    snapshots.map((snapshot) => repo.git.changedFiles(snapshot.parent, snapshot.sha)),
  );
  const touching = new Map<string, Snapshot[]>();
  perSnapshot.forEach((files, i) => {
    for (const file of files) {
      touching.set(file.path, [...(touching.get(file.path) ?? []), snapshots[i]]);
    }
  });
  // Each file's status is its own net one: from before the first snapshot that
  // touched it to after the last. Files sharing a span — every file, when the
  // selection is contiguous — share the one diff, which is already cached.
  const spans = new Map<string, { from: string; to: string; paths: Set<string> }>();
  for (const [file, list] of touching) {
    const from = list[0].parent;
    const to = list[list.length - 1].sha;
    const span = spans.get(`${from}..${to}`) ?? { from, to, paths: new Set<string>() };
    span.paths.add(file);
    spans.set(`${from}..${to}`, span);
  }
  const net = new Map<string, ChangedFile>();
  const counts = new Map<string, DiffStat>();
  for (const span of spans.values()) {
    for (const file of await repo.git.changedFiles(span.from, span.to)) {
      if (span.paths.has(file.path)) {
        net.set(file.path, file);
      }
    }
    for (const [file, stat] of await repo.git.diffStat(span.from, span.to)) {
      if (span.paths.has(file)) {
        counts.set(file, stat);
      }
    }
  }
  const all = repo.store.data.snapshots;
  const brought = new Map(
    await Promise.all(
      snapshots.map(
        async (snapshot) =>
          [snapshot.n, await foreignPaths(repo.git, all, snapshot)] as [number, Set<string>],
      ),
    ),
  );
  for (const [file, list] of touching) {
    const status = net.get(file);
    // Absent from its own span's diff: the snapshots put it back where they found
    // it, so there is nothing left to review.
    if (status === undefined) {
      continue;
    }
    rows.push(
      new FileRow(
        repo,
        status,
        list,
        counts.get(file) ?? { added: 0, deleted: 0 },
        repo.store.isReviewed(file, list[list.length - 1].n),
        list.every((snapshot) => brought.get(snapshot.n)?.has(file) ?? false),
      ),
    );
  }
  return rows.sort((a, b) => a.file.path.localeCompare(b.file.path));
}
