import type { ScalarValue } from "./scalar.js";

export const characterTypes = ["STRING", "WSTRING", "CHAR", "WCHAR"] as const;
export type CharacterType = (typeof characterTypes)[number];
export const isCharacterType = (type: string): type is CharacterType =>
  characterTypes.some((item) => item === type);
export const isWideCharacterType = (type: CharacterType): boolean =>
  type === "WSTRING" || type === "WCHAR";
export const DEFAULT_STRING_LENGTH = 80;
export const MAX_STRING_LENGTH = 1024;

export function validateCharacters(type: CharacterType, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_STRING_LENGTH)
    throw new RangeError("Expected character data");
  if ((type === "CHAR" || type === "WCHAR") && value.length !== 1)
    throw new RangeError("Expected one code unit");
  if (!isWideCharacterType(type))
    for (let index = 0; index < value.length; index++)
      if (value.charCodeAt(index) > 255) throw new RangeError("Expected single-byte characters");
}

export class StringLiteralError extends RangeError {
  constructor(
    readonly code:
      "lex.unterminated-string" | "lex.invalid-string-escape" | "lex.invalid-string-character",
  ) {
    super(code);
  }
}

/** Read one quoted ST literal. The caller checks any suffix or typed prefix. */
export function readStringLiteral(source: string): {
  value: string;
  length: number;
  wide: boolean;
} {
  const quote = source[0];
  if (quote !== "'" && quote !== '"') throw new StringLiteralError("lex.unterminated-string");
  const wide = quote === '"';
  let value = "";
  let index = 1;
  while (index < source.length) {
    const char = source[index++]!;
    if (char === quote) return { value, length: index, wide };
    if (char === "\r" || char === "\n") throw new StringLiteralError("lex.unterminated-string");
    if (char !== "$") {
      if (!wide && char.charCodeAt(0) > 255)
        throw new StringLiteralError("lex.invalid-string-character");
      value += char;
      continue;
    }
    const escape = source[index++];
    if (escape === "$" || escape === quote) value += escape;
    else if (escape && /^[LNPRT]$/i.test(escape)) {
      value += ({ L: "\n", N: "\n", P: "\f", R: "\r", T: "\t" } as Record<string, string>)[
        escape.toUpperCase()
      ];
    } else {
      const digits = source.slice(index - 1, index - 1 + (wide ? 4 : 2));
      if (!new RegExp(`^[0-9a-fA-F]{${wide ? 4 : 2}}$`).test(digits))
        throw new StringLiteralError("lex.invalid-string-escape");
      value += String.fromCharCode(parseInt(digits, 16));
      index += digits.length - 1;
    }
  }
  throw new StringLiteralError("lex.unterminated-string");
}

/** Escape controls and surrogate code units so snapshots can be copied back to ST. */
export function formatCharacters(type: CharacterType, value: string): string {
  const wide = isWideCharacterType(type);
  const quote = wide ? '"' : "'";
  let result = quote;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const code = value.charCodeAt(index);
    result +=
      char === "$" || char === quote
        ? `$${char}`
        : code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)
          ? `$${code
              .toString(16)
              .toUpperCase()
              .padStart(wide ? 4 : 2, "0")}`
          : char;
  }
  return result + quote;
}

/** Untyped execution values distinguish 64-bit integers from character data. */
export function internalValue(type: string, value: ScalarValue): ScalarValue {
  return ["LINT", "ULINT", "LWORD", "LTIME", "LDATE", "LTOD", "LDT"].includes(type)
    ? BigInt(value)
    : value;
}
