import {
  parseDirectAddress,
  readStringLiteral,
  StringLiteralError,
  isCharacterType,
} from "@benchtop-plc/core";
import type { DataType, Diagnostic, SourceSpan } from "@benchtop-plc/core";
import { FrontendError } from "./diagnostic.js";

export type TokenKind =
  | "identifier"
  | "keyword"
  | "integer"
  | "real"
  | "string"
  | "time"
  | "calendar"
  | "boolean"
  | "address"
  | "symbol"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** Exact source spelling; empty for EOF. */
  text: string;
  /** Upper-case spelling for case-insensitive comparisons. */
  key: string;
  span: SourceSpan;
  /** Approximate lexical value; numeric source text is authoritative for exact evaluation. */
  value?: number | boolean | string;
  dataType?: DataType;
}

export type LexResult =
  { tokens: Token[]; diagnostics: [] } | { tokens: null; diagnostics: [Diagnostic] };

/** Reserved elementary type names are legal in type position, even before type checking. */
const elementaryTypeKeywords = new Set(
  `BOOL INT DINT UINT REAL LREAL TIME SINT USINT UDINT LINT ULINT BYTE WORD DWORD
   LWORD LTIME DATE TIME_OF_DAY TOD DATE_AND_TIME DT LDATE LTIME_OF_DAY LTOD LDATE_AND_TIME LDT STRING WSTRING CHAR WCHAR`.split(
    /\s+/,
  ),
);

// Include unsupported declaration/POU forms so they cannot masquerade as identifiers.
const keywords = new Set([
  ...elementaryTypeKeywords,
  ...`PROGRAM END_PROGRAM VAR END_VAR AT IF THEN ELSIF ELSE END_IF CASE OF END_CASE
   FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT RETURN
   NOT MOD AND XOR OR
   FUNCTION END_FUNCTION FUNCTION_BLOCK END_FUNCTION_BLOCK VAR_INPUT VAR_OUTPUT
   VAR_IN_OUT VAR_TEMP VAR_GLOBAL VAR_EXTERNAL VAR_ACCESS VAR_CONFIG RETAIN NON_RETAIN
   CONSTANT ARRAY STRUCT END_STRUCT TYPE END_TYPE REF_TO REF NULL
   EN ENO CONFIGURATION END_CONFIGURATION RESOURCE END_RESOURCE
   TASK WITH ON READ_ONLY READ_WRITE METHOD END_METHOD THIS PUBLIC PROTECTED PRIVATE INTERNAL`.split(
    /\s+/,
  ),
]);

/** Case-insensitive ST keyword classification, including reserved type names. */
export const isKeyword = (name: string): boolean => keywords.has(name.toUpperCase());

/** Includes reserved elementary types that are not yet supported by the checker. */
export const isElementaryTypeName = (name: string): boolean =>
  elementaryTypeKeywords.has(name.toUpperCase());

const digits = "[0-9]+(?:_[0-9]+)*";
const decimalInteger = new RegExp(`^${digits}$`);
const realNumber = new RegExp(
  `^${digits}(?:\\.${digits}(?:[eE][+-]?${digits})?|[eE][+-]?${digits})$`,
);
const timePart = new RegExp(`(${digits}(?:\\.${digits})?)(ms|us|ns|d|h|m|s)`, "gi");
const milliseconds: Record<string, number> = {
  d: 86400000,
  h: 3600000,
  m: 60000,
  s: 1000,
  ms: 1,
  us: 0.001,
  ns: 0.000001,
};

class Lexer {
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly source: string) {}

  private get char(): string {
    return this.source[this.offset] ?? "";
  }

  private starts(text: string): boolean {
    return this.source.startsWith(text, this.offset);
  }

  private advance(): void {
    const char = this.char;
    this.offset++;
    if (char === "\r" || (char === "\n" && this.source[this.offset - 2] !== "\r")) {
      this.line++;
      this.column = 1;
    } else if (char !== "\n") {
      this.column++;
    }
  }

  private position(): SourceSpan {
    return { line: this.line, column: this.column, endLine: this.line, endColumn: this.column };
  }

  private finishSpan(start: SourceSpan): SourceSpan {
    return { ...start, endLine: this.line, endColumn: this.column };
  }

  private token(
    kind: TokenKind,
    start: number,
    span: SourceSpan,
    value?: number | boolean | string,
  ): Token {
    const text = this.source.slice(start, this.offset);
    return {
      kind,
      text,
      key: text.toUpperCase(),
      span: this.finishSpan(span),
      ...(value === undefined ? {} : { value }),
    };
  }

  private fail(diagnostic: Diagnostic): never {
    throw new FrontendError(diagnostic);
  }

  private skipTrivia(): void {
    while (this.char) {
      if (/\s/.test(this.char)) {
        this.advance();
      } else if (this.starts("//")) {
        while (this.char && this.char !== "\r" && this.char !== "\n") this.advance();
      } else if (this.starts("(*")) {
        const span = this.position();
        this.advance();
        this.advance();
        let depth = 1;
        while (depth > 0) {
          if (!this.char) {
            this.fail({
              code: "lex.unterminated-comment",
              severity: "error",
              span: this.finishSpan(span),
              args: {},
            });
          }
          if (this.starts("(*")) {
            depth++;
            this.advance();
            this.advance();
          } else if (this.starts("*)")) {
            depth--;
            this.advance();
            this.advance();
          } else {
            this.advance();
          }
        }
      } else {
        break;
      }
    }
  }

  private number(start: number, span: SourceSpan, time: boolean, dataType?: DataType): Token {
    if ((time || dataType) && (this.char === "+" || this.char === "-")) this.advance();
    while (this.char) {
      if (/[A-Za-z0-9_#]/.test(this.char) || (this.char === "." && !this.starts(".."))) {
        this.advance();
      } else if (
        !time &&
        /[eE]/.test(this.source[this.offset - 1] ?? "") &&
        !this.source
          .slice(start, this.offset)
          .replace(/^[A-Za-z]+#/, "")
          .includes("#") &&
        (this.char === "+" || this.char === "-")
      ) {
        this.advance();
      } else {
        break;
      }
    }
    const fullText = this.source.slice(start, this.offset);
    const text = dataType ? fullText.slice(fullText.indexOf("#") + 1) : fullText;
    let kind: "integer" | "real" | "time" | "calendar" | "boolean" = "integer";
    let value = NaN;
    if (time) {
      kind = "time";
      const duration = text.slice(text.indexOf("#") + 1);
      const sign = duration.startsWith("-") ? -1 : 1;
      const parts = duration.replace(/^[+-]/, "");
      let end = 0;
      let previousUnit = Infinity;
      let fractional = false;
      value = 0;
      // matchAll creates a fresh regex iterator, so calls share no mutable lastIndex.
      for (const match of parts.matchAll(timePart)) {
        const unit = milliseconds[match[2]!.toLowerCase()]!;
        if (dataType !== "LTIME" && unit < 1) {
          value = NaN;
          break;
        }
        const separated = end > 0 && parts[end] === "_" && match.index === end + 1;
        if ((match.index !== end && !separated) || unit >= previousUnit || fractional) {
          value = NaN;
          break;
        }
        value += Number(match[1]!.replaceAll("_", "")) * unit;
        previousUnit = unit;
        fractional = match[1]!.includes(".");
        end = match.index + match[0].length;
      }
      if (end !== parts.length || end === 0) value = NaN;
      value *= sign;
    } else if (dataType === "BOOL" && /^(TRUE|FALSE)$/i.test(text)) {
      kind = "boolean";
      value = text.toUpperCase() === "TRUE" ? 1 : 0;
    } else if (decimalInteger.test(text.replace(/^[+-]/, ""))) {
      value = Number(text.replaceAll("_", ""));
    } else if (realNumber.test(text.replace(/^[+-]/, ""))) {
      kind = "real";
      value = Number(text.replaceAll("_", ""));
    } else {
      const based = /^([+-]?)(2|16)#(.+)$/.exec(text);
      if (based) {
        const base = Number(based[2]);
        const digitClass = base === 2 ? "[01]" : "[0-9a-fA-F]";
        if (new RegExp(`^${digitClass}+(?:_${digitClass}+)*$`).test(based[3]!)) {
          value = parseInt(based[3]!.replaceAll("_", ""), base) * (based[1] === "-" ? -1 : 1);
        }
      }
    }
    if (Number.isNaN(value)) {
      this.fail({
        code: "lex.malformed-number",
        severity: "error",
        span: this.finishSpan(span),
        args: { literal: fullText },
      });
    }
    return {
      ...this.token(
        kind,
        start,
        span,
        kind === "boolean" ? Boolean(value) : Number.isFinite(value) ? value || 0 : 0,
      ),
      ...(dataType ? { dataType } : {}),
    };
  }

  private string(start: number, span: SourceSpan, dataType?: DataType): Token {
    try {
      const literal = readStringLiteral(this.source.slice(this.offset));
      for (let index = 0; index < literal.length; index++) this.advance();
      return {
        ...this.token("string", start, span, literal.value),
        ...(dataType ? { dataType } : {}),
      };
    } catch (error) {
      if (!(error instanceof StringLiteralError)) throw error;
      this.fail({ code: error.code, severity: "error", span: this.finishSpan(span), args: {} });
    }
  }

  private next(): Token {
    this.skipTrivia();
    const start = this.offset;
    const span = this.position();
    if (!this.char) return this.token("eof", start, span);
    if (this.char === "'" || this.char === '"') return this.string(start, span);
    if (/[A-Za-z_]/.test(this.char)) {
      while (/[A-Za-z0-9_]/.test(this.char) && this.char) this.advance();
      const key = this.source.slice(start, this.offset).toUpperCase();
      if (isCharacterType(key) && this.char === "#") {
        this.advance();
        return this.string(start, span, key);
      }
      const calendarPrefixes: Record<string, DataType> = {
        D: "DATE",
        DATE: "DATE",
        LD: "LDATE",
        LDATE: "LDATE",
        TOD: "TOD",
        TIME_OF_DAY: "TOD",
        LTOD: "LTOD",
        LTIME_OF_DAY: "LTOD",
        DT: "DT",
        DATE_AND_TIME: "DT",
        LDT: "LDT",
        LDATE_AND_TIME: "LDT",
      };
      if (Object.hasOwn(calendarPrefixes, key) && this.char === "#") {
        this.advance();
        const dateOnly = calendarPrefixes[key] === "DATE" || calendarPrefixes[key] === "LDATE";
        // Hyphens belong to the calendar fields; a following subtraction is a new token.
        const field = "[0-9]+(?:_[0-9]+)*";
        const datePattern = `${field}-${field}-${field}`;
        const timePattern = `${field}:${field}:${field}(?:\\.${field})?`;
        const pattern = new RegExp(
          `^${dateOnly ? datePattern : calendarPrefixes[key] === "TOD" || calendarPrefixes[key] === "LTOD" ? timePattern : `${datePattern}-${timePattern}`}`,
        );
        const match = pattern.exec(this.source.slice(this.offset));
        if (match) for (let i = 0; i < match[0].length; i++) this.advance();
        return { ...this.token("calendar", start, span, 0), dataType: calendarPrefixes[key]! };
      }
      if (["T", "TIME", "LT", "LTIME"].includes(key) && this.char === "#") {
        this.advance();
        return this.number(
          start,
          span,
          true,
          key === "LT" || key === "LTIME" ? "LTIME" : undefined,
        );
      }
      if (
        [
          "BOOL",
          "SINT",
          "USINT",
          "INT",
          "UINT",
          "DINT",
          "UDINT",
          "BYTE",
          "WORD",
          "DWORD",
          "LINT",
          "ULINT",
          "LWORD",
          "REAL",
          "LREAL",
        ].includes(key) &&
        this.char === "#"
      ) {
        this.advance();
        return this.number(start, span, false, key as DataType);
      }
      if (key === "TRUE" || key === "FALSE")
        return this.token("boolean", start, span, key === "TRUE");
      return this.token(isKeyword(key) ? "keyword" : "identifier", start, span);
    }
    if (/[0-9]/.test(this.char)) return this.number(start, span, false);
    if (this.char === "%") {
      this.advance();
      while (/[A-Za-z0-9_.%*]/.test(this.char) && this.char) this.advance();
      const address = this.source.slice(start, this.offset);
      if (!parseDirectAddress(address)) {
        this.fail({
          code: "lex.malformed-direct-address",
          severity: "error",
          span: this.finishSpan(span),
          args: { address },
        });
      }
      return this.token("address", start, span);
    }
    if ([":=", "..", "<=", ">=", "<>", "=>", "**"].some((symbol) => this.starts(symbol))) {
      this.advance();
      this.advance();
      return this.token("symbol", start, span);
    }
    if (";:,()[].+-*/=<>&#^".includes(this.char)) {
      this.advance();
      return this.token("symbol", start, span);
    }
    this.advance();
    this.fail({
      code: "lex.invalid-character",
      severity: "error",
      span: this.finishSpan(span),
      args: { character: this.source.slice(start, this.offset) },
    });
  }

  run(): Token[] {
    const tokens: Token[] = [];
    do {
      try {
        tokens.push(this.next());
      } catch (error) {
        if (
          error instanceof FrontendError &&
          ["PROGRAM", "FUNCTION", "FUNCTION_BLOCK", "TYPE"].includes(tokens[0]?.key ?? "") &&
          tokens[1]?.kind === "identifier"
        )
          throw new FrontendError({ ...error.diagnostic, pou: tokens[1].text });
        throw error;
      }
    } while (tokens[tokens.length - 1]!.kind !== "eof");
    return tokens;
  }
}

/** Tokenize one source file, reporting the first lexical error as data. */
export const newlyReservedWords = new Set([
  "METHOD",
  "END_METHOD",
  "THIS",
  "PUBLIC",
  "PROTECTED",
  "PRIVATE",
  "INTERNAL",
]);

/** legacyNames is for validating pre-method project text during import only. */
export function lex(source: string, legacyNames = false): LexResult {
  try {
    const tokens = new Lexer(source).run();
    if (legacyNames)
      for (const token of tokens)
        if (token.kind === "keyword" && newlyReservedWords.has(token.key))
          token.kind = "identifier";
    return { tokens, diagnostics: [] };
  } catch (error) {
    if (error instanceof FrontendError) return { tokens: null, diagnostics: [error.diagnostic] };
    throw error;
  }
}
