import { ChangedFile, DiffStat, Turn } from "./git";
import { Repo } from "./repos";

/** One file in the net change of a set of turns, with the turns that touched it.
 * A turn's own file rows say what that turn did; this says what a review of
 * several turns is a review of. */
export class FileRow {
  constructor(
    readonly repo: Repo,
    readonly file: ChangedFile,
    /** The scoped turns that touched it, in order. Their ends are the span its
     * diff covers, and the last of them is the turn "viewed" is recorded at. */
    readonly turns: Turn[],
    readonly stat: DiffStat,
    readonly reviewed: boolean,
  ) {}
}

/** The net change of one repository's turns, one row per file.
 *
 * Taking the turns as an argument is what lets a review tab keep its own scope
 * after the tree's selection has moved on. */
export async function rowsFor(repo: Repo, turns: Turn[]): Promise<FileRow[]> {
  const rows: FileRow[] = [];
  // Which of the turns touched each file. Built from the per-turn diffs rather
  // than from one diff across the whole span, because a gap in the selection
  // would otherwise pull in a file only an unselected turn changed.
  const perTurn = await Promise.all(
    turns.map((turn) => repo.git.changedFiles(turn.parent, turn.sha)),
  );
  const touching = new Map<string, Turn[]>();
  perTurn.forEach((files, i) => {
    for (const file of files) {
      touching.set(file.path, [...(touching.get(file.path) ?? []), turns[i]]);
    }
  });
  // Each file's status is its own net one: from before the first turn that
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
  for (const [file, list] of touching) {
    const status = net.get(file);
    // Absent from its own span's diff: the turns put it back where they found
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
      ),
    );
  }
  return rows.sort((a, b) => a.file.path.localeCompare(b.file.path));
}
