import { describe, expect, it } from "vitest";
import {
  utf8ByteOffsetToStringIndex,
  stringIndexToUtf8ByteOffset,
  lspPositionToStringIndex,
  stringIndexToLspPosition,
  lspPositionToUtf8ByteOffset,
  utf8ByteOffsetToLspPosition,
} from "../../src/editor/offsets";

describe("byte offset <-> string index", () => {
  it("round-trips pure ASCII", () => {
    const text = "def f(x):\n    return x\n";
    for (let i = 0; i <= text.length; i++) {
      const byte = stringIndexToUtf8ByteOffset(text, i);
      expect(utf8ByteOffsetToStringIndex(text, byte)).toBe(i);
    }
  });

  it("accounts for multi-byte UTF-8 characters (non-ASCII, non-surrogate-pair)", () => {
    // "café" — the "é" is one UTF-16 code unit but two UTF-8 bytes.
    const text = "café = 1";
    // Byte offsets: c=1,a=1,f=1,é=2 (bytes 3..5 for é's 2 bytes) -> "café" spans 5 bytes, 4 UTF-16 units.
    expect(stringIndexToUtf8ByteOffset(text, 4)).toBe(5); // through "café"
    expect(utf8ByteOffsetToStringIndex(text, 5)).toBe(4);
    // A byte offset landing *inside* the 2-byte "é" should not be requested
    // by a well-formed LSP/SourceSpan producer, but must still resolve to
    // a valid (pre-character) index rather than throwing or corrupting.
    expect(utf8ByteOffsetToStringIndex(text, 4)).toBe(3);
  });

  it("accounts for astral code points (surrogate pairs)", () => {
    // U+1F600 GRINNING FACE — one code point, two UTF-16 code units, four UTF-8 bytes.
    const text = "x = '\u{1F600}'";
    const emojiStringIndex = text.indexOf("\u{1F600}");
    const byteOffsetBeforeEmoji = stringIndexToUtf8ByteOffset(text, emojiStringIndex);
    const byteOffsetAfterEmoji = stringIndexToUtf8ByteOffset(text, emojiStringIndex + 2);
    expect(byteOffsetAfterEmoji - byteOffsetBeforeEmoji).toBe(4);
    expect(utf8ByteOffsetToStringIndex(text, byteOffsetBeforeEmoji)).toBe(emojiStringIndex);
    expect(utf8ByteOffsetToStringIndex(text, byteOffsetAfterEmoji)).toBe(emojiStringIndex + 2);
  });
});

describe("LSP position <-> string index", () => {
  const text = "line0\nline1\nligne2\n";

  it("round-trips line/character positions", () => {
    expect(lspPositionToStringIndex(text, { line: 0, character: 0 })).toBe(0);
    expect(lspPositionToStringIndex(text, { line: 1, character: 2 })).toBe(text.indexOf("line1") + 2);
    expect(stringIndexToLspPosition(text, text.indexOf("line1") + 2)).toEqual({
      line: 1,
      character: 2,
    });
  });

  it("clamps a character beyond the line's length", () => {
    // "line0" is 5 chars; asking for character 99 on line 0 should clamp,
    // not spill into line 1's content.
    const index = lspPositionToStringIndex(text, { line: 0, character: 99 });
    expect(index).toBe(5);
  });
});

describe("composed LSP position <-> byte offset (through a non-ASCII line)", () => {
  const text = "x = 1\ncafé = 2\ny = 3\n";

  it("matches manual byte-offset expectations", () => {
    const lineStart = text.indexOf("café = 2");
    // LSP character 4 on that line lands right after "café" (4 UTF-16 units).
    const byteOffset = lspPositionToUtf8ByteOffset(text, { line: 1, character: 4 });
    const expectedBytes = new TextEncoder().encode(text.slice(0, lineStart)).length + 5; // "café" = 5 bytes
    expect(byteOffset).toBe(expectedBytes);
    expect(utf8ByteOffsetToLspPosition(text, byteOffset)).toEqual({ line: 1, character: 4 });
  });
});
