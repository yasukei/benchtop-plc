import { isElementaryTypeName, isKeyword } from "@benchtop-plc/compiler";
import { isFunctionBlockType } from "@benchtop-plc/core";

export interface TokenizerState {
  commentDepth: number;
}
export type TokenStyle =
  | "keyword"
  | "typeName"
  | "className"
  | "number"
  | "bool"
  | "variableName.special"
  | "comment"
  | "variableName"
  | "operator";

/** Tolerant, line-oriented highlighting, including incomplete input and nested comments. */
export function readStToken(
  source: string,
  state: TokenizerState,
): { length: number; style: TokenStyle | null } {
  if (state.commentDepth > 0 || source.startsWith("(*")) {
    let length = 0;
    do {
      if (source.startsWith("(*", length)) {
        state.commentDepth++;
        length += 2;
      } else if (source.startsWith("*)", length)) {
        state.commentDepth--;
        length += 2;
      } else length++;
    } while (length < source.length && state.commentDepth > 0);
    return { length, style: "comment" };
  }
  if (source.startsWith("//")) return { length: source.length, style: "comment" };
  const whitespace = /^\s+/.exec(source);
  if (whitespace) return { length: whitespace[0].length, style: null };
  const address = /^%[A-Za-z0-9_.]*/.exec(source);
  if (address) return { length: address[0].length, style: "variableName.special" };
  const calendar =
    /^(?:DATE_AND_TIME|LDATE_AND_TIME|TIME_OF_DAY|LTIME_OF_DAY|LDATE|DATE|LTOD|TOD|LDT|DT|LD|D)#(?:\d+(?:_\d+)*-\d+(?:_\d+)*-\d+(?:_\d+)*(?:-\d+(?:_\d+)*:\d+(?:_\d+)*:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?)?|\d+(?:_\d+)*:\d+(?:_\d+)*:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?)/i.exec(
      source,
    );
  if (calendar) return { length: calendar[0].length, style: "number" };
  const time = /^(?:LTIME|LT|TIME|T)#[+-]?[A-Za-z0-9_.]*/i.exec(source);
  if (time) return { length: time[0].length, style: "number" };
  const typed =
    /^(?:BOOL|SINT|USINT|INT|UINT|DINT|UDINT|LINT|ULINT|BYTE|WORD|DWORD|LWORD|REAL|LREAL)#[+-]?(?:TRUE|FALSE|\d+#[A-Za-z0-9_]*|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]*)?)?/i.exec(
      source,
    );
  if (typed) return { length: typed[0].length, style: "number" };
  const number = /^(?:\d+#[A-Za-z0-9_]*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?[\d_]*)?)/.exec(source);
  if (number) return { length: number[0].length, style: "number" };
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source);
  if (identifier) {
    const key = identifier[0].toUpperCase();
    const style =
      key === "TRUE" || key === "FALSE"
        ? "bool"
        : isElementaryTypeName(key)
          ? "typeName"
          : isFunctionBlockType(key)
            ? "className"
            : isKeyword(key)
              ? "keyword"
              : "variableName";
    return { length: identifier[0].length, style };
  }
  return { length: source ? 1 : 0, style: "operator" };
}

/** Indentation after the preceding line, with one level for ST block openers. */
export function nextIndent(previous: string, after: string, unit = 2): number {
  const state = { commentDepth: 0 };
  let code = "";
  for (let pos = 0; pos < previous.length;) {
    const token = readStToken(previous.slice(pos), state);
    if (token.style !== "comment") code += previous.slice(pos, pos + token.length);
    pos += token.length;
  }
  const base = /^\s*/.exec(previous)![0].length;
  const opens = /(?:\b(?:THEN|DO|OF|ELSE|REPEAT)|\bVAR(?:_\w+)?)\s*$/i.test(code);
  const closes = /^\s*(?:END_\w+|ELSE|ELSIF|UNTIL)\b/i.test(after);
  return Math.max(0, base + (opens ? unit : 0) - (closes ? unit : 0));
}
