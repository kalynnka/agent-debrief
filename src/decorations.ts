import * as vscode from "vscode";

/** Turn rows hang off their own scheme so a row can be decorated with the status
 * the *turn* gave the file, rather than whatever git says about the working tree
 * right now. The path is the file's absolute path — which is what the icon theme
 * reads and what diagnostics are keyed by — and the query is the status letter,
 * so the decoration provider needs no lookup table to answer. */
export const TURN_SCHEME = "octoview-turn";

export function turnFileUri(absPath: string, status: string): vscode.Uri {
  return vscode.Uri.from({ scheme: TURN_SCHEME, path: absPath, query: status });
}

/** `git diff --name-status` letters, coloured as git's own decorations colour
 * them so a turn row and a Changes row read the same. */
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

/** Colour and badge for a turn's file row: the status letter, or — when the
 * language server has something to say about the file — the problem count in
 * the list's warning/error colour, which is the louder fact of the two. */
export class TurnDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private changed = new vscode.EventEmitter<undefined | vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly listener: vscode.Disposable;

  constructor() {
    // A row's URI carries its status letter, so the URIs the event reports are
    // not the ones on screen; every row is re-asked instead.
    this.listener = vscode.languages.onDidChangeDiagnostics(() => this.changed.fire(undefined));
  }

  dispose(): void {
    this.listener.dispose();
    this.changed.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== TURN_SCHEME) {
      return undefined;
    }
    const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(uri.path));
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
    return new vscode.FileDecoration(
      uri.query,
      NAMES[uri.query],
      new vscode.ThemeColor(COLORS[uri.query]),
    );
  }
}
