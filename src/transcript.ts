import * as fs from "fs/promises";

/** Derive a turn label from a Claude Code transcript: the first line of the
 * session's last assistant text — the agent's own summary of what it just did
 * (PRD §6, "label without prompting"). Returns undefined when the transcript is
 * unreadable or holds no assistant text; the caller falls back to `turn <n>`. */
export async function labelFromTranscript(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let label: string | undefined;
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
      label = text;
    }
  }
  return label;
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
  if (last === undefined) {
    return undefined;
  }
  const first = (last.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  if (first === "") {
    return undefined;
  }
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}
