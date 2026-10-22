import { isStandardFunction } from "@benchtop-plc/core";
import type { BinaryOperator, Diagnostic, SourceSpan } from "@benchtop-plc/core";
import type {
  Address,
  AssignmentTarget,
  CaseBranch,
  CaseLabel,
  ConditionalBranch,
  Declaration,
  Expression,
  Identifier,
  FunctionCall,
  NamedOutput,
  Program,
  Statement,
} from "./ast.js";
import { FrontendError, joinedSpan } from "./diagnostic.js";
import { isElementaryTypeName, lex } from "./lexer.js";
import type { Token } from "./lexer.js";

export type ParseResult =
  { ast: Program; diagnostics: [] } | { ast: null; diagnostics: [Diagnostic] };

const precedence: Partial<Record<string, number>> = {
  OR: 1,
  XOR: 2,
  AND: 3,
  "&": 3,
  "=": 4,
  "<>": 4,
  "<": 5,
  ">": 5,
  "<=": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  MOD: 7,
  "**": 8,
};

class Parser {
  private cursor = 0;

  constructor(private readonly tokens: Token[]) {}

  private get current(): Token {
    return this.tokens[this.cursor]!;
  }

  private get previous(): Token {
    return this.tokens[this.cursor - 1]!;
  }

  private at(key: string): boolean {
    return this.current.key === key;
  }

  private take(): Token {
    const token = this.current;
    if (token.kind !== "eof") this.cursor++;
    return token;
  }

  private accept(key: string): boolean {
    if (!this.at(key)) return false;
    this.take();
    return true;
  }

  private fail(diagnostic: Diagnostic): never {
    throw new FrontendError(diagnostic);
  }

  private expected(expected: string): never {
    if (this.current.kind === "eof") {
      this.fail({
        code: "syntax.unexpected-eof",
        severity: "error",
        span: this.current.span,
        args: {},
      });
    }
    this.fail({
      code: "syntax.expected-token",
      severity: "error",
      span: this.current.span,
      args: { expected, found: this.current.text },
    });
  }

  private expect(key: string): Token {
    if (!this.at(key)) this.expected(key);
    return this.take();
  }

  private missingEnd(expected: `END_${string}`): never {
    const { line, column } = this.current.span;
    this.fail({
      code: "syntax.missing-end",
      severity: "error",
      span: { line, column, endLine: line, endColumn: column },
      args: { expected },
    });
  }

  private identifier(allowType = false): Identifier {
    const token = this.current;
    if (token.kind === "identifier" || (allowType && isElementaryTypeName(token.key))) {
      this.take();
      return { name: token.text, key: token.key, span: token.span };
    }
    if (token.kind === "eof") this.expected("identifier");
    if (token.kind === "keyword" || token.kind === "boolean") {
      this.fail({
        code: "syntax.reserved-identifier",
        severity: "error",
        span: token.span,
        args: { name: token.text },
      });
    }
    this.fail({
      code: "syntax.expected-identifier",
      severity: "error",
      span: token.span,
      args: { found: token.text },
    });
  }

  private assignmentOperator(): void {
    if (this.at("=")) {
      this.fail({
        code: "syntax.assignment-operator",
        severity: "error",
        span: this.current.span,
        args: {},
      });
    }
    this.expect(":=");
  }

  private spanFrom(start: SourceSpan): SourceSpan {
    return joinedSpan(start, this.previous.span);
  }

  run(pou = false): Program {
    if (!pou || !["PROGRAM", "FUNCTION", "FUNCTION_BLOCK"].includes(this.current.key))
      this.expect("PROGRAM");
    else this.take();
    const header = this.previous;
    const start = header.span;
    // Type names are accepted here so namespace clashes receive semantic diagnostics.
    const name = this.identifier(pou);
    const resultType =
      header.key === "FUNCTION" && this.accept(":") ? this.identifier(true) : undefined;
    const declarations: Declaration[] = [];
    const sections: NonNullable<Program["sections"]> = [];
    while (
      (pou ? ["VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP"] : ["VAR"]).includes(
        this.current.key,
      )
    ) {
      const section = this.take();
      if (section.key !== "VAR") sections.push({ name: section.key, span: section.span });
      while (!this.at("END_VAR")) {
        if (this.current.kind === "eof" || this.current.key.startsWith("END_"))
          this.missingEnd("END_VAR");
        const declaration = this.declaration();
        if (section.key !== "VAR")
          declaration.section = section.key as NonNullable<Declaration["section"]>;
        declarations.push(declaration);
      }
      this.expect("END_VAR");
    }
    const end = `END_${header.key}` as `END_${string}`;
    const body = this.body([end], end);
    this.expect(end);
    const span = this.spanFrom(start);
    this.accept(";");
    if (this.current.kind !== "eof") this.expected("eof");
    return {
      kind:
        header.key === "FUNCTION"
          ? "function"
          : header.key === "FUNCTION_BLOCK"
            ? "functionBlock"
            : "program",
      name,
      declarations,
      body,
      span,
      ...(resultType ? { resultType } : {}),
      ...(sections.length ? { sections } : {}),
    };
  }

  private declaration(): Declaration {
    const names: [Identifier, ...Identifier[]] = [this.identifier()];
    while (this.accept(",")) names.push(this.identifier());
    let address: Address | undefined;
    if (this.accept("AT")) {
      const token = this.current;
      if (token.kind !== "address") this.expected("address");
      this.take();
      const match = /^%([IQ])X([0-9]+)\.([0-9]+)$/.exec(token.key)!;
      address = {
        text: token.text,
        ...(token.dataType ? { dataType: token.dataType } : {}),
        area: match[1] as "I" | "Q",
        byte: Number(match[2]),
        bit: Number(match[3]),
        span: token.span,
      };
    }
    this.expect(":");
    const typeName = this.identifier(true);
    let initializer: Expression | undefined;
    if (this.at(":=") || this.at("=")) {
      this.assignmentOperator();
      initializer = this.expression();
    }
    this.expect(";");
    return {
      kind: "declaration",
      names,
      typeName,
      ...(address ? { address } : {}),
      ...(initializer ? { initializer } : {}),
      span: this.spanFrom(names[0].span),
    };
  }

  private body(
    stops: string[],
    end: `END_${string}`,
    caseLabels = false,
    requiredBeforeEnd?: string,
  ): Statement[] {
    const statements: Statement[] = [];
    while (!stops.includes(this.current.key)) {
      if (
        this.current.kind === "eof" ||
        this.current.key.startsWith("END_") ||
        ["ELSE", "ELSIF", "UNTIL"].includes(this.current.key)
      ) {
        if (requiredBeforeEnd) this.expected(requiredBeforeEnd);
        this.missingEnd(end);
      }
      if (caseLabels && this.startsCaseLabel()) break;
      if (this.accept(";")) continue;
      statements.push(this.statement());
    }
    return statements;
  }

  private statement(): Statement {
    const start = this.current.span;
    if (this.accept("IF")) {
      const first = this.conditionalBranch(start);
      const branches: [ConditionalBranch, ...ConditionalBranch[]] = [first];
      while (this.accept("ELSIF")) branches.push(this.conditionalBranch(this.previous.span));
      const elseBody = this.accept("ELSE") ? this.body(["END_IF"], "END_IF") : [];
      this.expect("END_IF");
      this.expect(";");
      return { kind: "if", branches, elseBody, span: this.spanFrom(start) };
    }
    if (this.accept("CASE")) {
      const selector = this.expression();
      this.expect("OF");
      const branches: CaseBranch[] = [];
      while (!this.at("ELSE") && !this.at("END_CASE")) {
        if (this.current.kind === "eof" || this.current.key.startsWith("END_"))
          this.missingEnd("END_CASE");
        const labelStart = this.current.span;
        const labels = this.caseLabels();
        this.expect(":");
        const colon = this.previous.span;
        const body = this.body(["ELSE", "END_CASE"], "END_CASE", true);
        branches.push({ labels, body, span: joinedSpan(labelStart, body.at(-1)?.span ?? colon) });
      }
      const elseBody = this.accept("ELSE") ? this.body(["END_CASE"], "END_CASE") : [];
      this.expect("END_CASE");
      this.expect(";");
      return { kind: "case", selector, branches, elseBody, span: this.spanFrom(start) };
    }
    if (this.accept("FOR")) {
      const variable = this.identifier();
      this.assignmentOperator();
      const from = this.expression();
      this.expect("TO");
      const to = this.expression();
      const step = this.accept("BY") ? this.expression() : undefined;
      this.expect("DO");
      const body = this.body(["END_FOR"], "END_FOR");
      this.expect("END_FOR");
      this.expect(";");
      return {
        kind: "for",
        variable,
        from,
        to,
        ...(step ? { step } : {}),
        body,
        span: this.spanFrom(start),
      };
    }
    if (this.accept("WHILE")) {
      const condition = this.expression();
      this.expect("DO");
      const body = this.body(["END_WHILE"], "END_WHILE");
      this.expect("END_WHILE");
      this.expect(";");
      return { kind: "while", condition, body, span: this.spanFrom(start) };
    }
    if (this.accept("REPEAT")) {
      const body = this.body(["UNTIL"], "END_REPEAT", false, "UNTIL");
      this.expect("UNTIL");
      const until = this.expression();
      if (
        this.current.kind === "eof" ||
        (!this.at("END_REPEAT") && this.current.key.startsWith("END_"))
      )
        this.missingEnd("END_REPEAT");
      this.expect("END_REPEAT");
      this.expect(";");
      return { kind: "repeat", body, until, span: this.spanFrom(start) };
    }
    if (this.at("EXIT") || this.at("RETURN")) {
      const kind = this.take().key === "EXIT" ? "exit" : "return";
      this.expect(";");
      return { kind, span: this.spanFrom(start) };
    }
    const token = this.current;
    const keywordCall =
      ["AND", "OR", "XOR", "MOD", "NOT"].includes(token.key) &&
      this.tokens[this.cursor + 1]?.key === "(";
    const name = keywordCall
      ? (this.take(), { name: token.text, key: token.key, span: token.span })
      : this.identifier();
    if (this.accept("(")) {
      const call = this.functionArguments(name, !isStandardFunction(name.key));
      this.expect(";");
      // Preserve the FB AST contract for its existing named-input syntax.
      if (
        !isStandardFunction(name.key) &&
        !call.outputs?.length &&
        (call.inputNames || call.args.length === 0)
      ) {
        return {
          kind: "fbCall",
          instance: name,
          inputs: call.args.map((value, index) => ({
            name: call.inputNames![index]!,
            value,
            span: joinedSpan(call.inputNames![index]!.span, value.span),
          })),
          span: this.spanFrom(start),
        };
      }
      return { kind: "call", call, span: this.spanFrom(start) };
    }
    const target = this.reference(name);
    this.assignmentOperator();
    const value = this.expression();
    this.expect(";");
    return { kind: "assignment", target, value, span: this.spanFrom(start) };
  }

  private conditionalBranch(start: SourceSpan): ConditionalBranch {
    const condition = this.expression();
    this.expect("THEN");
    const then = this.previous.span;
    const body = this.body(["ELSIF", "ELSE", "END_IF"], "END_IF");
    return { condition, body, span: joinedSpan(start, body.at(-1)?.span ?? then) };
  }

  private caseLabels(): [CaseLabel, ...CaseLabel[]] {
    const label = (): CaseLabel => {
      const lower = this.expression();
      if (this.accept("..")) {
        const upper = this.expression();
        return { kind: "range", lower, upper, span: joinedSpan(lower.span, upper.span) };
      }
      return { kind: "value", value: lower, span: lower.span };
    };
    const labels: [CaseLabel, ...CaseLabel[]] = [label()];
    while (this.accept(",")) labels.push(label());
    return labels;
  }

  /** CASE arms have no separator: a label list followed by ':' starts the next arm. */
  private startsCaseLabel(): boolean {
    const saved = this.cursor;
    try {
      this.caseLabels();
      return this.at(":");
    } catch (error) {
      if (!(error instanceof FrontendError)) throw error;
      return false;
    } finally {
      this.cursor = saved;
    }
  }

  private reference(name: Identifier): AssignmentTarget {
    if (this.accept(".")) {
      const token = this.current;
      // A numeric selector is checked against the variable's bit width in the semantic pass.
      const member =
        token.kind === "integer" && !token.dataType && /^\d+$/.test(token.text)
          ? (this.take(), { name: token.text, key: token.key, span: token.span })
          : this.identifier();
      return { kind: "member", instance: name, member, span: joinedSpan(name.span, member.span) };
    }
    return { kind: "name", name, span: name.span };
  }

  private expression(minimum = 1): Expression {
    let left = this.primary();
    while (true) {
      const level = precedence[this.current.key];
      if (level === undefined || level < minimum) break;
      const token = this.take();
      const right = this.expression(level + 1);
      left = {
        kind: "binary",
        operator: (token.key === "&" ? "AND" : token.key) as BinaryOperator,
        left,
        right,
        span: joinedSpan(left.span, right.span),
      };
    }
    return left;
  }

  private primary(): Expression {
    const token = this.current;
    // NOT(expr) is also the existing unary operator with a grouped operand.
    if (this.at("-") || this.at("+") || this.at("NOT")) {
      this.take();
      const operand = this.expression(precedence["**"]!);
      return {
        kind: "unary",
        operator: token.key as "+" | "-" | "NOT",
        operand,
        span: joinedSpan(token.span, operand.span),
      };
    }
    if (this.accept("(")) {
      const expression = this.expression();
      this.expect(")");
      return { kind: "group", expression, span: this.spanFrom(token.span) };
    }
    if (
      token.kind === "integer" ||
      token.kind === "real" ||
      token.kind === "time" ||
      token.kind === "calendar"
    ) {
      this.take();
      return {
        kind: "literal",
        literalKind: token.kind,
        text: token.text,
        ...(token.dataType ? { dataType: token.dataType } : {}),
        value: token.value as number,
        span: token.span,
      };
    }
    if (token.kind === "boolean") {
      this.take();
      return {
        kind: "literal",
        literalKind: "boolean",
        text: token.text,
        ...(token.dataType ? { dataType: token.dataType } : {}),
        value: token.value as boolean,
        span: token.span,
      };
    }
    const keywordCall =
      ["AND", "OR", "XOR", "MOD"].includes(token.key) && this.tokens[this.cursor + 1]?.key === "(";
    if (token.kind !== "identifier" && !keywordCall) this.expected("expression");
    const name = keywordCall
      ? (this.take(), { name: token.text, key: token.key, span: token.span })
      : this.identifier();
    if (this.accept("(")) {
      return this.functionArguments(name);
    }
    return this.reference(name);
  }
  private functionArguments(name: Identifier, blockSyntax = false): FunctionCall {
    const args: Expression[] = [];
    const names: Identifier[] = [];
    const outputs: NamedOutput[] = [];
    let formal: boolean | undefined;
    if (!this.at(")")) {
      do {
        const named =
          this.current.kind === "identifier" &&
          ([":=", "=>"].includes(this.tokens[this.cursor + 1]?.key ?? "") ||
            (blockSyntax && this.tokens[this.cursor + 1]?.key === "="));
        if (formal !== undefined && formal !== named) this.expected("consistent call arguments");
        formal = named;
        if (named) {
          const port = this.identifier();
          if (this.accept("=>")) {
            const target = this.reference(this.identifier());
            outputs.push({ name: port, target, span: joinedSpan(port.span, target.span) });
          } else {
            this.assignmentOperator();
            names.push(port);
            args.push(this.expression());
          }
        } else args.push(this.expression());
      } while (this.accept(","));
    }
    this.expect(")");
    return {
      kind: "functionCall",
      name,
      args,
      ...(formal ? { inputNames: names } : {}),
      ...(outputs.length ? { outputs } : {}),
      span: this.spanFrom(name.span),
    };
  }
}

/** Parse one textual PROGRAM without resolving names or checking types. */
export function parse(source: string): ParseResult {
  return parseSource(source, false);
}

/** Parse exactly one POU; project-wide name resolution belongs to compilation. */
export function parsePou(source: string): ParseResult {
  return parseSource(source, true);
}

function parseSource(source: string, pou: boolean): ParseResult {
  const result = lex(source);
  if (result.tokens === null) return { ast: null, diagnostics: result.diagnostics };
  try {
    return { ast: new Parser(result.tokens).run(pou), diagnostics: [] };
  } catch (error) {
    if (error instanceof FrontendError) {
      const name = result.tokens[1];
      const diagnostic = {
        ...error.diagnostic,
        ...(["PROGRAM", "FUNCTION", "FUNCTION_BLOCK"].includes(result.tokens[0]?.key ?? "") &&
        name?.kind === "identifier"
          ? { pou: name.text }
          : {}),
      };
      return { ast: null, diagnostics: [diagnostic] };
    }
    throw error;
  }
}
