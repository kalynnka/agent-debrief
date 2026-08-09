import * as vscode from "vscode";

/** Every UI element VS Code's comment API can draw, on one scratch document.
 *
 * Its own controller, its own scheme, its own commands, so nothing here can reach
 * a review thread — and every button reports itself and stops. Which of these
 * elements the review should actually spend is a question for the eyes, and this
 * is the thing to point them at. */
export const GALLERY_SCHEME = "debrief-gallery";

/** The controller id the `when` clauses key on, so no menu entry here can appear
 * on a real thread. */
const GALLERY_ID = "debrief-gallery";

const GALLERY_URI = vscode.Uri.from({ scheme: GALLERY_SCHEME, path: "/Comment UI Gallery" });

const HEADER = [
  "Comment UI Gallery",
  "",
  "Nothing here is wired. Every button says its own name and stops, and this",
  "document is virtual — closing the tab leaves nothing behind.",
  "",
  "Buttons live in four places: under the reply box, in a thread's title bar, on a",
  "comment when you hover it, and in that comment's ... menu. Ask Claude is gated on",
  "the thread's contextValue, so it is on 1 and 9 and nowhere else — which is the",
  "catch, because a real thread already spends that one string on its id.",
  "",
];

class Sample implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(
    public body: string | vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    public label?: string,
    public contextValue?: string,
    public timestamp?: Date,
    public reactions?: vscode.CommentReaction[],
  ) {}
}

/** A line of the document and the thread hanging on it. The line says what the
 * thread shows, so reading down the file is reading the list of elements. */
interface Specimen {
  text: string;
  build: (thread: vscode.CommentThread) => void;
}

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

function markdown(text: string, commands: string[] = []): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.supportThemeIcons = true;
  // Not `isTrusted = true`: that enables every command in the window. The list
  // form is what a reply from an agent should carry — the two buttons it meant.
  if (commands.length > 0) {
    md.isTrusted = { enabledCommands: commands };
  }
  return md;
}

function specimens(media: (name: string) => vscode.Uri): Specimen[] {
  const you: vscode.CommentAuthorInformation = { name: "Lu Hui" };
  const agent: vscode.CommentAuthorInformation = {
    name: "Claude",
    iconPath: media("agent-claude.svg"),
  };

  return [
    {
      text: "  1  two voices in one thread — the avatar and the label are the agent's",
      build: (thread) => {
        thread.label = "Open · snapshot 7";
        thread.contextValue = "unanswered";
        thread.comments = [
          new Sample("Why is this relocated before the lock rather than inside it?", you,
            undefined, "reviewer", minutesAgo(9)),
          new Sample("Because the lock is held for the write only — the git reads are slow.",
            agent, "agent", "agent", minutesAgo(2)),
        ];
      },
    },
    {
      text: "  2  a body is markdown — code, a list, a link, and $(sparkle) theme icons",
      build: (thread) => {
        thread.label = "Answered · snapshot 7";
        thread.comments = [
          new Sample(
            markdown(
              "Three things move here:\n\n" +
                "- `anchor` travels forward\n" +
                "- `origin` stays put\n" +
                "- `outdated` is the flag between them\n\n" +
                "```ts\nconst { anchor, outdated } = await anchorForward(...);\n```\n\n" +
                "$(info) See [WORKFLOWS §3.3](https://example.invalid/workflows).",
            ),
            agent,
            "agent",
            "agent",
            minutesAgo(6),
          ),
        ];
      },
    },
    {
      text: "  3  command links in a body — the agent hands you buttons inside its reply",
      build: (thread) => {
        thread.label = "Answered · snapshot 8";
        thread.comments = [
          new Sample(
            markdown(
              "Fixed: the stamp now comes from the tab, not from the latest snapshot.\n\n" +
                "[$(check) Apply](command:debrief.gallery.apply) · " +
                "[$(diff) Show the diff](command:debrief.gallery.showDiff)",
              ["debrief.gallery.apply", "debrief.gallery.showDiff"],
            ),
            agent,
            "agent",
            "agent",
            minutesAgo(4),
          ),
        ];
      },
    },
    {
      text: "  4  reactions — the only interaction the API offers that is not typing",
      build: (thread) => {
        thread.label = "Answered · snapshot 8";
        thread.comments = [
          new Sample("Relocated it to the newest snapshot. Does that answer it?", agent,
            "agent", "agent", minutesAgo(3), [
              { label: "Yes", iconPath: media("reaction-yes.svg"), count: 1, authorHasReacted: true },
              { label: "No", iconPath: media("reaction-no.svg"), count: 0, authorHasReacted: false },
            ]),
        ];
      },
    },
    {
      text: "  5  a thread that takes no reply — canReply = false, and the box is gone",
      build: (thread) => {
        thread.label = "Submitted · snapshot 6";
        thread.canReply = false;
        thread.comments = [new Sample("Sent with the batch; closed to replies.", you,
          undefined, "reviewer", minutesAgo(40))];
      },
    },
    {
      text: "  6  resolved — VS Code's own dot, and its own dimming of the thread",
      build: (thread) => {
        thread.label = "Resolved · snapshot 6";
        thread.state = vscode.CommentThreadState.Resolved;
        thread.comments = [
          new Sample("The badge counted across snapshots.", you, undefined, "reviewer",
            minutesAgo(70)),
          new Sample("Now filtered by `thread.snapshot`.", agent, "agent", "agent",
            minutesAgo(65)),
        ];
      },
    },
    {
      text: "  7  collapsed on open — a dot in the gutter until you click it",
      build: (thread) => {
        thread.label = "Open · snapshot 9";
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        thread.comments = [new Sample("Folded until asked for.", you, undefined, "reviewer",
          minutesAgo(20))];
      },
    },
    {
      text: "  8  a comment open for editing — Save and Cancel come from a menu, not free",
      build: (thread) => {
        thread.label = "Open · snapshot 9";
        const editing = new Sample("Half-written, and still editable.", you, undefined,
          "editing", minutesAgo(1));
        editing.mode = vscode.CommentMode.Editing;
        thread.comments = [editing];
      },
    },
    {
      text: "  9  an empty thread — the placeholder, the prompt, and the buttons below",
      build: (thread) => {
        thread.label = "New comment";
        thread.contextValue = "unanswered";
        // The object form names who the box is speaking as; `true` just allows a reply.
        thread.canReply = { name: "Lu Hui" };
      },
    },
  ];
}

/** Stand the gallery up: a virtual document, a controller of its own, and a
 * command per button that names itself in a toast. Returns what to dispose. */
export function gallery(extensionUri: vscode.Uri): vscode.Disposable[] {
  const media = (name: string): vscode.Uri => vscode.Uri.joinPath(extensionUri, "media", name);
  const rows = specimens(media);
  const text = [...HEADER, ...rows.map((row) => row.text), ""].join("\n");

  const controller = vscode.comments.createCommentController(GALLERY_ID, "Comment UI Gallery");
  controller.options = {
    placeHolder: "Say what is wrong, or ask for help with it",
    prompt: "Leave a review comment",
  };
  // Reactions render only when the controller can take one, so this has to exist
  // even though it does nothing.
  controller.reactionHandler = async (comment, reaction) => {
    void vscode.window.showInformationMessage(
      `Gallery: reacted "${reaction.label}" to ${comment.author.name}'s comment.`,
    );
  };
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document) =>
      document.uri.scheme === GALLERY_SCHEME
        ? [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)]
        : [],
  };

  let live: vscode.CommentThread[] = [];
  const draw = (): void => {
    for (const thread of live) {
      thread.dispose();
    }
    live = rows.map((row, index) => {
      const line = HEADER.length + index;
      const thread = controller.createCommentThread(
        GALLERY_URI,
        new vscode.Range(line, 0, line, 0),
        [],
      );
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.state = vscode.CommentThreadState.Unresolved;
      thread.contextValue = "answered";
      row.build(thread);
      return thread;
    });
  };

  const say = (what: string): void => void vscode.window.showInformationMessage(`Gallery: ${what}`);
  const button = (id: string, what: (arg: unknown) => string): vscode.Disposable =>
    vscode.commands.registerCommand(id, (arg: unknown) => say(what(arg)));

  return [
    { dispose: () => live.forEach((thread) => thread.dispose()) },
    controller,
    vscode.workspace.registerTextDocumentContentProvider(GALLERY_SCHEME, {
      provideTextDocumentContent: () => text,
    }),
    vscode.commands.registerCommand("debrief.commentGallery", async () => {
      draw();
      await vscode.window.showTextDocument(GALLERY_URI, { preview: false });
    }),
    // What the button beside the box is actually handed: the half-typed text and
    // the thread it belongs to. That is the whole affordance for asking mid-review.
    button("debrief.gallery.ask", (arg) => {
      const reply = arg as vscode.CommentReply | undefined;
      const typed = reply?.text.trim() ?? "";
      return typed === ""
        ? "Ask Claude — the box was empty, so the button gets only the thread."
        : `Ask Claude — the button was handed: "${typed}"`;
    }),
    button("debrief.gallery.comment", () => "Comment — same argument, different intent."),
    button("debrief.gallery.resolve", () => "Resolve — thread title bar."),
    button("debrief.gallery.deleteThread", () => "Delete Thread — thread title bar."),
    button("debrief.gallery.edit", () => "Edit — hover icon on a comment."),
    button("debrief.gallery.askAbout", () => "Ask Claude About This — hover icon on a comment."),
    button("debrief.gallery.copy", () => "Copy Comment — the comment's ... menu."),
    button("debrief.gallery.save", () => "Save — under a comment being edited."),
    button("debrief.gallery.cancel", () => "Cancel — under a comment being edited."),
    button("debrief.gallery.apply", () => "Apply — a command link inside the reply body."),
    button("debrief.gallery.showDiff", () => "Show the diff — a command link inside the body."),
  ];
}
