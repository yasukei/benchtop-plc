import type { DataType, Diagnostic, SourceSpan } from "@benchtop-plc/core";
import { FrontendError } from "./diagnostic.js";

export type TokenKind =
  "identifier" | "keyword" | "integer" | "real" | "time" | "boolean" | "address" | "symbol" | "eof";

export interface Token {
  kind: TokenKind;
  /** Exact source spelling; empty for EOF. */
  text: string;
  /** Upper-case spelling for case-insensitive comparisons. */
  key: string;
  span: SourceSpan;
  /** Approximate lexical value; numeric source text is authoritative for exact evaluation. */
  value?: number | boolean;
  dataType?: DataType;
}

export type LexResult =
  { tokens: Token[]; diagnostics: [] } | { tokens: null; diagnostics: [Diagnostic] };

/** Reserved elementary type names are legal in type position, even before type checking. */
const elementaryTypeKeywords = new Set(
  `BOOL INT DINT UINT REAL LREAL TIME SINT USINT UDINT LINT ULINT BYTE WORD DWORD
   LWORD DATE TIME_OF_DAY TOD DATE_AND_TIME DT STRING WSTRING`.split(/\s+/),
);

// Include unsupported declaration/POU forms so they cannot masquerade as identifiers.
const keywords = new Set([
  ...elementaryTypeKeywords,
  ...`PROGRAM END_PROGRAM VAR END_VAR AT IF THEN ELSIF ELSE END_IF CASE OF END_CASE
   FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT RETURN
   NOT MOD AND XOR OR
   FUNCTION END_FUNCTION FUNCTION_BLOCK END_FUNCTION_BLOCK VAR_INPUT VAR_OUTPUT
   VAR_IN_OUT VAR_TEMP VAR_GLOBAL VAR_EXTERNAL VAR_ACCESS VAR_CONFIG RETAIN NON_RETAIN
   CONSTANT ARRAY STRUCT END_STRUCT TYPE END_TYPE
   EN ENO CONFIGURATION END_CONFIGURATION RESOURCE END_RESOURCE
   TASK WITH ON READ_ONLY READ_WRITE`.split(/\s+/),
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
const timePart = new RegExp(`(${digits}(?:\\.${digits})?)(ms|d|h|m|s)`, "gi");
const milliseconds: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };

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

  private token(kind: TokenKind, start: number, span: SourceSpan, value?: number | boolean): Token {
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
    let kind: "integer" | "real" | "time" | "boolean" = "integer";
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

  private next(): Token {
    this.skipTrivia();
    const start = this.offset;
    const span = this.position();
    if (!this.char) return this.token("eof", start, span);
    if (/[A-Za-z_]/.test(this.char)) {
      while (/[A-Za-z0-9_]/.test(this.char) && this.char) this.advance();
      const key = this.source.slice(start, this.offset).toUpperCase();
      if ((key === "T" || key === "TIME") && this.char === "#") {
        this.advance();
        return this.number(start, span, true);
      }
      if (["BOOL", "INT", "DINT", "UINT", "REAL", "LREAL"].includes(key) && this.char === "#") {
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
      while (/[A-Za-z0-9_.%]/.test(this.char) && this.char) this.advance();
      const address = this.source.slice(start, this.offset);
      const parts = /^%[IQ]X([0-9]+)\.([0-9]+)$/i.exec(address);
      if (
        !parts ||
        !Number.isSafeInteger(Number(parts[1])) ||
        !Number.isSafeInteger(Number(parts[2]))
      ) {
        this.fail({
          code: "lex.malformed-direct-address",
          severity: "error",
          span: this.finishSpan(span),
          args: { address },
        });
      }
      return this.token("address", start, span);
    }
    if ([":=", "..", "<=", ">=", "<>", "=>"].some((symbol) => this.starts(symbol))) {
      this.advance();
      this.advance();
      return this.token("symbol", start, span);
    }
    if (";:,().+-*/=<>&".includes(this.char)) {
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
      tokens.push(this.next());
    } while (tokens[tokens.length - 1]!.kind !== "eof");
    return tokens;
  }
}

/** Tokenize one source file, reporting the first lexical error as data. */
export function lex(source: string): LexResult {
  try {
    return { tokens: new Lexer(source).run(), diagnostics: [] };
  } catch (error) {
    if (error instanceof FrontendError) return { tokens: null, diagnostics: [error.diagnostic] };
    throw error;
  }
}
