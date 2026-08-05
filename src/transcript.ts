import * as fs from "fs/promises";

export interface TurnSummary {
  /** The first line, short enough for a tree row (PRD §6, "label without
   * prompting"). */
  label: string;
  /** The same message in full — what the review opens with. */
  message: string;
}

/** Read a turn's summary out of a Claude Code transcript: the session's last
 * assistant text, which is the agent's own account of what it just did. Returns
 * undefined when the transcript is unreadable or holds no assistant text; the
 * caller falls back to `turn <n>`. */
export async function summaryFromTranscript(file: string): Promise<TurnSummary | undefined> {
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
  if (message === undefined) {
    return undefined;
  }
  const first = (message.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (first === "") {
    return undefined;
  }
  return {
    label: first.length > 72 ? `${first.slice(0, 71)}…` : first,
    message: message.trim(),
  };
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
