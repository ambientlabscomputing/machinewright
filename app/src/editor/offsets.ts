/**
 * Offset conversions between editor positions, LSP positions, and
 * Machinewright's UTF-8-byte-based `SourceSpan` (RFD-19 "Editor
 * architecture": "Define conversions between editor offsets, LSP
 * positions, and Python source spans, including Unicode" — RFD open
 * question #2).
 *
 * Three coordinate systems meet here:
 *  - Machinewright `SourceSpan.start_byte`/`end_byte` (evaluation.py):
 *    UTF-8 byte offsets into the file's bytes on disk.
 *  - LSP `Position` (line, character): 0-based line, UTF-16 code-unit
 *    offset within that line (the LSP spec's default/legacy encoding —
 *    negotiating UTF-8 position encoding is a real option but out of
 *    scope for this spike).
 *  - JS string index: UTF-16 code units, the native indexing CodeMirror
 *    (a browser/WebKit-hosted editor, in web/editor/) and Hermes (the RN
 *    LSP client, in src/editor/) both use for `string.slice`/`.length`.
 *
 * Every conversion here pivots through the JS string index rather than
 * doing byte<->LSP-position directly, since both endpoints already need
 * to interoperate with JS strings anyway.
 *
 * Line splitting assumes `\n` line endings (matching this project's
 * source files); CRLF is not specifically handled — a real language
 * server on a CRLF file would need this extended.
 */

export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/** UTF-8 byte length of a single Unicode code point's UTF-16 representation. */
function utf8ByteLength(codePoint: string): number {
  return new TextEncoder().encode(codePoint).length;
}

/**
 * Converts a UTF-8 byte offset (as used by SourceSpan) into a UTF-16 JS
 * string index into `text`. O(n) single pass — correct for surrogate
 * pairs (astral code points), since it walks whole code points via
 * `codePointAt`/`fromCodePoint` rather than raw UTF-16 code units.
 */
export function utf8ByteOffsetToStringIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charBytes = utf8ByteLength(char);
    if (bytes + charBytes > byteOffset) return i;
    bytes += charBytes;
    i += char.length; // 1 for BMP code points, 2 for a surrogate pair
    if (bytes === byteOffset) return i;
  }
  return text.length;
}

/** Converts a UTF-16 JS string index into `text` to a UTF-8 byte offset. */
export function stringIndexToUtf8ByteOffset(text: string, stringIndex: number): number {
  return new TextEncoder().encode(text.slice(0, stringIndex)).length;
}

/** Start index (UTF-16) of each line in `text`, line 0 first. */
function lineStartIndices(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Converts an LSP `Position` (0-based line, UTF-16 character) to a JS string index. */
export function lspPositionToStringIndex(text: string, position: LspPosition): number {
  const starts = lineStartIndices(text);
  const lineStart = starts[Math.min(position.line, starts.length - 1)] ?? 0;
  const lineEnd = starts[position.line + 1] ?? text.length + 1;
  const maxCharacter = Math.max(0, lineEnd - lineStart - 1);
  return lineStart + Math.min(position.character, maxCharacter);
}

/** Converts a JS string index into `text` to an LSP `Position`. */
export function stringIndexToLspPosition(text: string, stringIndex: number): LspPosition {
  const starts = lineStartIndices(text);
  let line = 0;
  for (let i = 1; i < starts.length; i++) {
    if ((starts[i] ?? Infinity) > stringIndex) break;
    line = i;
  }
  const lineStart = starts[line] ?? 0;
  return { line, character: stringIndex - lineStart };
}

/** Composed convenience: LSP `Position` directly to a UTF-8 byte offset. */
export function lspPositionToUtf8ByteOffset(text: string, position: LspPosition): number {
  return stringIndexToUtf8ByteOffset(text, lspPositionToStringIndex(text, position));
}

/** Composed convenience: a UTF-8 byte offset directly to an LSP `Position`. */
export function utf8ByteOffsetToLspPosition(text: string, byteOffset: number): LspPosition {
  return stringIndexToLspPosition(text, utf8ByteOffsetToStringIndex(text, byteOffset));
}
