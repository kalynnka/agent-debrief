import * as fs from "fs/promises";

export interface SnapshotSummary {
  /** The first line, short enough for a tree row (PRD §6, "label without
   * prompting"). */
  label: string;
  /** The same message in full — what the review opens with. */
  message: string;
}

/** A message's label: its first non-empty line, cut to what a tree row has room
 * for. Undefined when the message holds no such line, and so nothing to name a
 * snapshot with. One rule for both sources — a message the agent passed in and a
 * message scraped out of a transcript are labelled the same way. */
export function labelOf(message: string | undefined): string | undefined {
  const first = (message?.split("\n").find((line) => line.trim() !== "") ?? "").trim();
  if (first === "") {
    return undefined;
  }
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

/** A snapshot's message with its label taken off the front.
 *
 * The label used to *be* the message's first line, so anything recorded before it
 * became a sentence of its own says the same thing twice the moment the two are
 * shown together — and the hook's scrape still works that way, because a
 * transcript offers nothing else. `labelOf` is what decides whether that is the
 * case here, so a label truncated at 72 characters is recognised as its own
 * first line rather than left in place. */
export function noteBody(label: string, message: string | undefined): string {
  if (message === undefined) {
    return "";
  }
  if (labelOf(message) !== label) {
    return message.trim();
  }
  const lines = message.split("\n");
  return lines
    .slice(lines.findIndex((line) => line.trim() !== "") + 1)
    .join("\n")
    .trim();
}

/** One `src/git.ts:43` or `src/review.ts:270-275` found in a note. */
export interface CodeReference {
  /** Repo-relative, as written. */
  file: string;
  /** 1-based, as a reader counts. */
  line: number;
  start: number;
  end: number;
}

/** A path with an extension, a colon, a line, and optionally a second line.
 *
 * Deliberately narrow. The note is prose, and prose is full of colons followed by
 * digits — `Verification: 48 checks` must not become a link to a file called
 * "Verification". Requiring a dot-extension and a non-word character in front is
 * what keeps it to things that are actually paths. */
const REFERENCE = /(^|[\s([])((?:[\w.-]+\/)*[\w.-]+\.\w+):(\d+)(?:-\d+)?/g;

/** Every code reference in a note, in the order they appear.
 *
 * The skill tells agents to write `src/cli.ts:220` rather than a markdown link,
 * because the review shows the note in a diff row and a diff row renders no
 * markdown at all. Finding them afterwards is what lets that plain text be
 * clickable anyway: the note stays readable as text, and the editor underlines
 * the references in place. */
export function codeReferences(text: string): CodeReference[] {
  const found: CodeReference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const start = (match.index ?? 0) + match[1].length;
    found.push({
      file: match[2],
      line: Number(match[3]),
      start,
      end: start + match[0].length - match[1].length,
    });
  }
  return found;
}

/** Read a snapshot's summary out of a Claude Code transcript: the session's last
 * assistant text, which is the agent's own account of what it just did. Returns
 * undefined when the transcript is unreadable or holds no assistant text; the
 * caller falls back to `snapshot <n>`. */
export async function summaryFromTranscript(file: string): Promise<SnapshotSummary | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let message: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantText(entry);
    if (text !== undefined) {
      message = text;
    }
  }
  const label = labelOf(message);
  if (message === undefined || label === undefined) {
    return undefined;
  }
  return { label, message: message.trim() };
}

function assistantText(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { type, message } = entry as { type?: unknown; message?: unknown };
  if (type !== "assistant" || typeof message !== "object" || message === null) {
    return undefined;
  }
  const { content } = message as { content?: unknown };
  if (!Array.isArray(content)) {
    return undefined;
  }
  let last: string | undefined;
  for (const part of content as unknown[]) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const { type: partType, text } = part as { type?: unknown; text?: unknown };
    if (partType === "text" && typeof text === "string" && text.trim() !== "") {
      last = text;
    }
  }
  return last;
}
