import * as vscode from "vscode";

/** Snapshot rows hang off their own scheme so a row can be decorated with the status
 * the *snapshot* gave the file, rather than whatever git says about the working tree
 * right now. The path is the file's absolute path — which is what the icon theme
 * reads and what diagnostics are keyed by — and the query is the status letter,
 * so the decoration provider needs no lookup table to answer. */
export const SNAPSHOT_SCHEME = "debrief-snapshot";

export function snapshotFileUri(absPath: string, status: string, spent = false): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: absPath,
    query: status,
    fragment: spent ? SPENT : "",
  });
}

/** The queries that mark a snapshot row rather than a file row. A status letter is
 * never one of these words, so the two cannot collide. */
const FROZEN = "frozen";
const ABANDONED = "abandoned";

/** A file row with nothing outstanding on it. In the fragment rather than the
 * query, because it says nothing about *what* the snapshot did to the file — the
 * status letter is still the answer to that, and still the badge. */
const SPENT = "spent";

/** A repo row holding lanes whose branches are gone. Warning-coloured and badged
 * with the count, because letting go of them is the one action in this view that
 * hands work to git's collector — and unlike everything else here, what git then
 * takes does not come back. */
export function abandonedRepoUri(repoRoot: string, count: number): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: `${repoRoot}/abandoned/${count}`,
    query: ABANDONED,
  });
}

/** The row of a snapshot every one of whose files is spent — put back, or already
 * on the branch. The rows under it grey out one by one, and this greys when the last
 * of them does. Its path names no file — it only has to be unique
 * per snapshot, so the decoration is cached per row. This is what greys the label:
 * `TreeItem.label` carries no colour of its own, and the row's icon slot belongs
 * to the agent. Being committed needs no such mark — those snapshots sit under their
 * commit, and position says it. */
export function frozenSnapshotUri(repoRoot: string, n: number): vscode.Uri {
  return vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: `${repoRoot}/snapshot/${n}`,
    query: FROZEN,
  });
}

/** `git diff --name-status` letters, coloured as git's own decorations colour
 * them so a snapshot row and a Changes row read the same. */
const COLORS: Record<string, string> = {
  A: "gitDecoration.addedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  C: "gitDecoration.renamedResourceForeground",
  T: "gitDecoration.modifiedResourceForeground",
};

const NAMES: Record<string, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
};

/** Colour and badge for a snapshot's file row: the status letter, or — when the
 * language server has something to say about the file — the problem count in
 * the list's warning/error colour, which is the louder fact of the two. */
export class SnapshotDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private changed = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly listener: vscode.Disposable;
  /** Snapshot URIs already asked about, by the file they point at, one per status
   * letter and spent state. A row's URI carries that letter, so it is never the URI
   * a diagnostics event names — this is the way back from the file to the rows
   * showing it. */
  private readonly rows = new Map<string, Map<string, vscode.Uri>>();

  constructor() {
    // Firing `undefined` here would be correct and ruinous: it invalidates every
    // decoration in the window — Explorer, Source Control, tabs — and the
    // TypeScript server emits diagnostics on every keystroke. Only the rows whose
    // file actually changed are re-asked.
    this.listener = vscode.languages.onDidChangeDiagnostics((event) => {
      const stale = event.uris.flatMap((uri) => [...(this.rows.get(uri.fsPath)?.values() ?? [])]);
      if (stale.length > 0) {
        this.changed.fire(stale);
      }
    });
  }

  dispose(): void {
    this.listener.dispose();
    this.changed.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SNAPSHOT_SCHEME) {
      return undefined;
    }
    if (uri.query === FROZEN) {
      // Colour only. No badge: the greyed-out rows underneath already say what this
      // is, and a badge would just cost width the label needs.
      return new vscode.FileDecoration(
        undefined,
        "Nothing of this snapshot is outstanding",
        new vscode.ThemeColor("disabledForeground"),
      );
    }
    if (uri.query === ABANDONED) {
      const count = uri.path.split("/").pop() ?? "";
      return new vscode.FileDecoration(
        count.length > 2 ? "9+" : count,
        `${count} lane(s) whose branch no longer exists`,
        new vscode.ThemeColor("list.warningForeground"),
      );
    }
    const file = vscode.Uri.file(uri.path);
    const seen = this.rows.get(file.fsPath) ?? new Map<string, vscode.Uri>();
    seen.set(`${uri.query}#${uri.fragment}`, uri);
    this.rows.set(file.fsPath, seen);
    const diagnostics = vscode.languages.getDiagnostics(file);
    const errors = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error,
    ).length;
    const warnings = diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Warning,
    ).length;
    if (errors + warnings > 0) {
      const total = errors + warnings;
      return new vscode.FileDecoration(
        total > 9 ? "9+" : String(total),
        `${total} problem${total === 1 ? "" : "s"}`,
        new vscode.ThemeColor(errors > 0 ? "list.errorForeground" : "list.warningForeground"),
      );
    }
    // A spent row keeps its letter and gives up its colour: what the snapshot did
    // to the file is still true, and the grey — the same grey a frozen snapshot
    // takes — is what says there is nothing left of it to act on.
    const spent = uri.fragment === SPENT;
    return new vscode.FileDecoration(
      uri.query,
      spent ? `${NAMES[uri.query]}, nothing outstanding` : NAMES[uri.query],
      new vscode.ThemeColor(spent ? "disabledForeground" : COLORS[uri.query]),
    );
  }
}
