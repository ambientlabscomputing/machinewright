/**
 * Maps a global-find hit (1-based line, UTF-16 column/length within that
 * line, as reported by the native search) to the UTF-8 byte range the
 * editor surface's `setSelection` expects.
 */
import { stringIndexToUtf8ByteOffset } from "../editor/offsets";

export interface ByteSpan {
  readonly startByte: number;
  readonly endByte: number;
}

/** Returns `null` when `line` is past the end of `text`. Splits lines on `\n` (a trailing `\r` is part of its line). */
export function matchByteRange(text: string, line: number, column: number, length: number): ByteSpan | null {
  let lineStart = 0;
  for (let current = 1; current < line; current++) {
    const newline = text.indexOf("\n", lineStart);
    if (newline < 0) return null;
    lineStart = newline + 1;
  }
  if (lineStart > text.length) return null;
  const start = Math.min(lineStart + column, text.length);
  const end = Math.min(start + length, text.length);
  return {
    startByte: stringIndexToUtf8ByteOffset(text, start),
    endByte: stringIndexToUtf8ByteOffset(text, end),
  };
}

/** Rejects paths that are empty, absolute, or escape the project root; returns the normalized relative path. */
export function validateNewFilePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("Enter a file name");
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) throw new Error("Use a path relative to the project root");
  if (trimmed.endsWith("/")) throw new Error("A file name cannot end with /");
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Path segments cannot be empty, “.” or “..”");
  }
  return segments.join("/");
}
