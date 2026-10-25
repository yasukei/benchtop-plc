import { parseDirectAddress, isStandardFunction } from "@benchtop-plc/core";
import type { BinaryOperator, Diagnostic, SourceSpan } from "@benchtop-plc/core";
import type {
  Address,
  ArrayDeclaration,
  AssignmentTarget,
  CaseBranch,
  CaseLabel,
  ConditionalBranch,
  Declaration,
  DataTypeDeclaration,
  Subrange,
  Expression,
  Identifier,
  FunctionCall,
  NamedOutput,
  Program,
  Statement,
} from "./ast.js";
import { rootName } from "./ast.js";
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

const isFunction = (name: string): boolean =>
  isStandardFunction(name) || name === "LOWER_BOUND" || name === "UPPER_BOUND";

export class Parser {
  private cursor = 0;
  get position(): number {
    return this.cursor;
  }

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

  private access(): import("./ast.js").Access | undefined {
    if (
      this.current.kind !== "keyword" ||
      !["PUBLIC", "PROTECTED", "PRIVATE", "INTERNAL"].includes(this.current.key)
    )
      return;
    const access = this.take().key as import("./ast.js").Access;
    if (["PUBLIC", "PROTECTED", "PRIVATE", "INTERNAL"].includes(this.current.key))
      this.fail({ code: "access.duplicate", severity: "error", span: this.current.span, args: {} });
    return access;
  }

  run(pou = false, method = false): Program {
    if (method) this.expect("METHOD");
    else if (!pou || !["PROGRAM", "FUNCTION", "FUNCTION_BLOCK", "CLASS"].includes(this.current.key))
      this.expect("PROGRAM");
    else this.take();
    const header = this.previous;
    const start = header.span;
    // Type names are accepted here so namespace clashes receive semantic diagnostics.
    const access = method ? this.access() : undefined;
    const modifiers: Pick<Program, "abstract" | "final" | "override"> = {};
    if (method || ["CLASS", "FUNCTION_BLOCK"].includes(header.key)) {
      if (this.accept("ABSTRACT")) modifiers.abstract = true;
      else if (this.accept("FINAL")) modifiers.final = true;
      if (["ABSTRACT", "FINAL"].includes(this.current.key))
        this.fail({
          code: "inheritance.modifier-conflict",
          severity: "error",
          span: this.current.span,
          args: {},
        });
      if (method && this.accept("OVERRIDE")) modifiers.override = true;
    }
    const name = this.identifier(pou);
    const base =
      !method && ["CLASS", "FUNCTION_BLOCK"].includes(header.key) && this.accept("EXTENDS")
        ? this.identifier(true)
        : undefined;
    const hasResult = (method || header.key === "FUNCTION") && this.accept(":");
    const resultReference = hasResult && this.accept("REF_TO") ? this.typeSyntax() : undefined;
    const resultArray =
      !resultReference && hasResult && this.at("ARRAY") ? this.arrayDeclaration() : undefined;
    const resultType = resultReference
      ? { name: "REF_TO", key: "REF_TO", span: start }
      : resultArray
        ? { name: "ARRAY", key: "ARRAY", span: resultArray.span }
        : hasResult
          ? this.identifier(true)
          : undefined;
    const resultStringLength = resultType && this.at("[") ? this.stringLength() : undefined;
    const resultSubrange = resultType && this.at("(") ? this.subrange() : undefined;
    const declarations: Declaration[] = [];
    const sections: NonNullable<Program["sections"]> = [];
    while (
      (pou
        ? ["VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP", "VAR_EXTERNAL"]
        : ["VAR"]
      ).includes(this.current.key)
    ) {
      const section = this.take();
      const sectionAccess = this.access();
      if (
        sectionAccess &&
        (!["FUNCTION_BLOCK", "CLASS"].includes(header.key) || section.key !== "VAR")
      )
        this.fail({
          code: "access.invalid-section",
          severity: "error",
          span: section.span,
          args: {},
        });
      let constant = false,
        retain = false,
        nonRetain = false;
      while (["CONSTANT", "RETAIN", "NON_RETAIN"].includes(this.current.key)) {
        const qualifier = this.take().key;
        constant ||= qualifier === "CONSTANT";
        retain ||= qualifier === "RETAIN";
        nonRetain ||= qualifier === "NON_RETAIN";
      }
      if (section.key !== "VAR" || sectionAccess || constant || retain || nonRetain)
        sections.push({
          name: section.key,
          ...(sectionAccess ? { access: sectionAccess } : {}),
          ...(retain ? { retain: true } : {}),
          ...(nonRetain ? { nonRetain: true } : {}),
          span: section.span,
          ...(constant ? { constant: true } : {}),
        });
      while (!this.at("END_VAR")) {
        if (
          this.current.kind === "eof" ||
          (this.current.kind === "keyword" && this.current.key.startsWith("END_"))
        )
          this.missingEnd("END_VAR");
        const declaration = this.declaration();
        if (sectionAccess) declaration.access = sectionAccess;
        if (constant) declaration.constant = true;
        if (retain) declaration.retain = true;
        if (nonRetain) declaration.nonRetain = true;
        if (section.key !== "VAR")
          declaration.section = section.key as NonNullable<Declaration["section"]>;
        declarations.push(declaration);
      }
      this.expect("END_VAR");
    }
    const methods: Program[] = [];
    while (this.current.kind === "keyword" && this.at("METHOD") && !method) {
      if (!["FUNCTION_BLOCK", "CLASS"].includes(header.key))
        this.fail({
          code: "method.invalid-owner",
          severity: "error",
          span: this.current.span,
          args: {},
        });
      methods.push(this.run(true, true));
    }
    const end = `END_${header.key}` as `END_${string}`;
    if (header.key === "CLASS" && !this.at(end))
      this.fail({ code: "class.body", severity: "error", span: this.current.span, args: {} });
    const body = this.body([end], end);
    this.expect(end);
    const span = this.spanFrom(start);
    this.accept(";");
    if (method) Object.assign(span, this.spanFrom(start));
    if (!method && this.current.kind !== "eof") this.expected("eof");
    return {
      ...modifiers,
      ...(base ? { base } : {}),
      ...(methods.length ? { methods } : {}),
      ...(access ? { access } : {}),
      kind:
        method || header.key === "FUNCTION"
          ? "function"
          : header.key === "CLASS"
            ? "class"
            : header.key === "FUNCTION_BLOCK"
              ? "functionBlock"
              : "program",
      name,
      declarations,
      body,
      span,
      ...(resultType ? { resultType } : {}),
      ...(resultReference ? { resultReference } : {}),
      ...(resultArray ? { resultArray } : {}),
      ...(resultSubrange ? { resultSubrange } : {}),
      ...(resultStringLength === undefined ? {} : { resultStringLength }),
      ...(sections.length ? { sections } : {}),
    };
  }

  private typeSyntax(): import("./ast.js").TypeSyntax {
    const start = this.current.span;
    if (this.accept("REF_TO")) {
      const token = this.previous;
      return {
        typeName: { name: token.text, key: token.key, span: token.span },
        reference: this.typeSyntax(),
        span: this.spanFrom(start),
      };
    }
    const array = this.at("ARRAY") ? this.arrayDeclaration() : undefined;
    const typeName = array
      ? { name: "ARRAY", key: "ARRAY", span: array.span }
      : this.identifier(true);
    const stringLength = this.at("[") ? this.stringLength() : undefined;
    const subrange = this.at("(") ? this.subrange() : undefined;
    return {
      typeName,
      span: this.spanFrom(start),
      ...(array ? { array } : {}),
      ...(stringLength === undefined ? {} : { stringLength }),
      ...(subrange ? { subrange } : {}),
    };
  }
  private stringLength(): number {
    this.expect("[");
    const token = this.current;
    if (token.kind !== "integer" || token.dataType) this.expected("integer");
    this.take();
    this.expect("]");
    return Number(token.value);
  }

  private subrange(): Subrange {
    const start = this.expect("(").span;
    const lower = this.expression();
    this.expect("..");
    const upper = this.expression();
    this.expect(")");
    return { lower, upper, span: this.spanFrom(start) };
  }

  dataType(): DataTypeDeclaration {
    const start = this.expect("TYPE").span;
    const name = this.identifier(true);
    this.expect(":");
    const reference = this.accept("REF_TO") ? this.typeSyntax() : undefined;
    const array = !reference && this.at("ARRAY") ? this.arrayDeclaration() : undefined;
    let members: Declaration[] | undefined;
    if (this.accept("STRUCT")) {
      members = [];
      while (!this.at("END_STRUCT")) members.push(this.declaration());
      this.expect("END_STRUCT");
    }
    const typeName = reference
      ? { name: "REF_TO", key: "REF_TO", span: start }
      : array || members
        ? undefined
        : this.at("(")
          ? undefined
          : this.identifier(true);
    const stringLength = this.at("[") ? this.stringLength() : undefined;
    let subrange: Subrange | undefined;
    let values: DataTypeDeclaration["values"];
    if (this.at("(")) {
      // Enum members end at a delimiter; identifier-led expressions can also be bounds.
      if (
        this.tokens[this.cursor + 1]?.kind === "identifier" &&
        [":=", ",", ")"].includes(this.tokens[this.cursor + 2]?.key ?? "")
      ) {
        this.take();
        values = [];
        do {
          const member = this.identifier();
          const value = this.accept(":=") ? this.expression() : undefined;
          values.push({ name: member, ...(value ? { value } : {}) });
        } while (this.accept(","));
        this.expect(")");
      } else subrange = this.subrange();
    }
    const initializer = this.accept(":=") ? this.initialValue() : undefined;
    this.expect(";");
    this.expect("END_TYPE");
    const span = this.spanFrom(start);
    this.accept(";");
    if (this.current.kind !== "eof") this.expected("eof");
    return {
      name,
      span,
      ...(members ? { members } : {}),
      ...(reference ? { reference } : {}),
      ...(array ? { array } : {}),
      ...(typeName ? { typeName } : {}),
      ...(subrange ? { subrange } : {}),
      ...(stringLength === undefined ? {} : { stringLength }),
      ...(values ? { values } : {}),
      ...(initializer ? { initializer } : {}),
    };
  }

  declaration(): Declaration {
    const names: [Identifier, ...Identifier[]] = [this.identifier()];
    while (this.accept(",")) names.push(this.identifier());
    let address: Address | undefined;
    if (this.accept("AT")) {
      const token = this.current;
      if (token.kind !== "address") this.expected("address");
      this.take();
      address = {
        text: token.text,
        ...parseDirectAddress(token.text)!,
        span: token.span,
      };
    }
    this.expect(":");
    const { typeName, array, stringLength, subrange, reference } = this.typeSyntax();
    let initializer: Expression | undefined;
    if (this.at(":=") || this.at("=")) {
      this.assignmentOperator();
      initializer = this.initialValue();
    }
    this.expect(";");
    return {
      kind: "declaration",
      ...(reference ? { reference } : {}),
      ...(array ? { array } : {}),
      names,
      typeName,
      ...(subrange ? { subrange } : {}),
      ...(stringLength === undefined ? {} : { stringLength }),
      ...(address ? { address } : {}),
      ...(initializer ? { initializer } : {}),
      span: this.spanFrom(names[0].span),
    };
  }

  private arrayDeclaration(): ArrayDeclaration {
    const start = this.expect("ARRAY").span;
    this.expect("[");
    const dimensions: (Subrange | "*")[] = [];
    do {
      if (this.accept("*")) {
        dimensions.push("*");
        continue;
      }
      const lower = this.expression();
      this.expect("..");
      const upper = this.expression();
      dimensions.push({ lower, upper, span: joinedSpan(lower.span, upper.span) });
    } while (this.accept(","));
    this.expect("]");
    this.expect("OF");
    const { typeName, array, stringLength, subrange, reference } = this.typeSyntax();
    return {
      dimensions,
      typeName,
      span: this.spanFrom(start),
      ...(reference ? { reference } : {}),
      ...(array ? { array } : {}),
      ...(stringLength === undefined ? {} : { stringLength }),
      ...(subrange ? { subrange } : {}),
    };
  }

  private initialValue(): Expression {
    if (
      this.at("(") &&
      (this.tokens[this.cursor + 1]?.key === ")" ||
        (this.tokens[this.cursor + 1]?.kind === "identifier" &&
          this.tokens[this.cursor + 2]?.key === ":="))
    ) {
      const start = this.take().span;
      const members: import("./ast.js").StructureInitializer["members"] = [];
      if (!this.at(")"))
        do {
          const name = this.identifier();
          this.expect(":=");
          members.push({ name, value: this.initialValue() });
        } while (this.accept(","));
      this.expect(")");
      return { kind: "structureInitializer", members, span: this.spanFrom(start) };
    }
    if (!this.at("[")) return this.expression();
    const start = this.take().span;
    const items: import("./ast.js").ArrayInitializer["items"] = [];
    if (!this.at("]"))
      do {
        if (
          this.current.kind === "identifier" &&
          this.tokens[this.cursor + 1]?.key === "(" &&
          !isStandardFunction(this.current.key)
        ) {
          const name = this.identifier();
          this.expect("(");
          const values = [this.initialValue()];
          while (this.accept(",")) values.push(this.initialValue());
          this.expect(")");
          items.push({ count: { kind: "name", name, span: name.span }, values });
          continue;
        }
        const first = this.initialValue();
        if (this.accept("(")) {
          const values = [this.initialValue()];
          while (this.accept(",")) values.push(this.initialValue());
          this.expect(")");
          items.push({ count: first, values });
        } else items.push({ values: [first] });
      } while (this.accept(","));
    this.expect("]");
    return { kind: "arrayInitializer", items, span: this.spanFrom(start) };
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
        (this.current.kind === "keyword" && this.current.key.startsWith("END_")) ||
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
        if (
          this.current.kind === "eof" ||
          (this.current.kind === "keyword" && this.current.key.startsWith("END_"))
        )
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
        (!this.at("END_REPEAT") &&
          this.current.kind === "keyword" &&
          this.current.key.startsWith("END_"))
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
    const name = ["THIS", "SUPER"].includes(token.key)
      ? (this.take(), { name: token.text, key: token.key, span: token.span })
      : keywordCall
        ? (this.take(), { name: token.text, key: token.key, span: token.span })
        : this.identifier();
    if (this.accept("(")) {
      const call = this.functionArguments(name, !isFunction(name.key));
      this.expect(";");
      // Preserve the FB AST contract for its existing named-input syntax.
      if (
        !isFunction(name.key) &&
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
    if ((target.kind === "member" || target.kind === "field") && this.accept("(")) {
      const call = this.methodArguments(target);
      this.expect(";");
      return { kind: "call", call, span: this.spanFrom(start) };
    }
    if (target.kind === "index" && this.accept("(")) {
      const call = this.functionArguments(rootName(target), true);
      call.instance = target;
      this.expect(";");
      return { kind: "call", call, span: this.spanFrom(start) };
    }
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
    let result: AssignmentTarget = { kind: "name", name, span: name.span };
    while (this.at("[") || this.at(".") || this.at("^")) {
      if (this.accept("^")) {
        result = { kind: "dereference", reference: result, span: this.spanFrom(name.span) };
        continue;
      }
      if (this.accept("[")) {
        const indices = [this.expression()];
        while (this.accept(",")) indices.push(this.expression());
        this.expect("]");
        result = { kind: "index", array: result, indices, span: this.spanFrom(name.span) };
      } else {
        this.expect(".");
        const token = this.current;
        const member =
          token.kind === "integer" && !token.dataType && /^\d+$/.test(token.text)
            ? (this.take(), { name: token.text, key: token.key, span: token.span })
            : this.identifier();
        result =
          result.kind === "name"
            ? { kind: "member", instance: name, member, span: this.spanFrom(name.span) }
            : { kind: "field", object: result, member, span: this.spanFrom(name.span) };
      }
    }
    return result;
  }

  expression(minimum = 1): Expression {
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
    if (token.kind === "string") {
      this.take();
      return {
        kind: "literal",
        literalKind: "string",
        text: token.text,
        ...(token.dataType ? { dataType: token.dataType } : {}),
        value: token.value as string,
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
    if (this.accept("NULL")) return { kind: "null", span: token.span };
    const keywordCall =
      ["AND", "OR", "XOR", "MOD", "REF"].includes(token.key) &&
      this.tokens[this.cursor + 1]?.key === "(";
    if (token.kind !== "identifier" && !["THIS", "SUPER"].includes(token.key) && !keywordCall)
      this.expected("expression");
    const name = ["THIS", "SUPER"].includes(token.key)
      ? (this.take(), { name: token.text, key: token.key, span: token.span })
      : keywordCall
        ? (this.take(), { name: token.text, key: token.key, span: token.span })
        : this.identifier();
    if (this.accept("#")) {
      const member = this.identifier();
      return {
        kind: "enumeration",
        typeName: name,
        member,
        span: joinedSpan(name.span, member.span),
      };
    }
    if (this.accept("(")) {
      return this.functionArguments(name);
    }
    const reference = this.reference(name);
    if ((reference.kind === "member" || reference.kind === "field") && this.accept("("))
      return this.methodArguments(reference);
    return reference;
  }
  private methodArguments(
    target: import("./ast.js").MemberReference | import("./ast.js").FieldReference,
  ): FunctionCall {
    const call = this.functionArguments(target.member);
    call.receiver =
      target.kind === "member"
        ? { kind: "name", name: target.instance, span: target.instance.span }
        : target.object;
    call.span = joinedSpan(target.span, call.span);
    return call;
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
            const token = this.current;
            const name = ["THIS", "SUPER"].includes(token.key)
              ? (this.take(), { name: token.text, key: token.key, span: token.span })
              : this.identifier();
            const target = this.reference(name);
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
export function parsePou(source: string, legacyNames = false): ParseResult {
  return parseSource(source, true, legacyNames);
}

function parseSource(source: string, pou: boolean, legacyNames = false): ParseResult {
  const result = lex(source, legacyNames);
  if (result.tokens === null) return { ast: null, diagnostics: result.diagnostics };
  try {
    return { ast: new Parser(result.tokens).run(pou), diagnostics: [] };
  } catch (error) {
    if (error instanceof FrontendError) {
      const name = result.tokens[1];
      const diagnostic = {
        ...error.diagnostic,
        ...(["PROGRAM", "FUNCTION", "FUNCTION_BLOCK", "CLASS"].includes(
          result.tokens[0]?.key ?? "",
        ) && name?.kind === "identifier"
          ? { pou: name.text }
          : {}),
      };
      return { ast: null, diagnostics: [diagnostic] };
    }
    throw error;
  }
}

/** Parse exactly one data type source, separately from the POU list. */
export function parseDataType(
  source: string,
  legacyNames = false,
): {
  ast: DataTypeDeclaration | null;
  diagnostics: Diagnostic[];
} {
  const result = lex(source, legacyNames);
  if (!result.tokens) return { ast: null, diagnostics: result.diagnostics };
  try {
    return { ast: new Parser(result.tokens).dataType(), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof FrontendError)) throw error;
    const name = result.tokens[1];
    return {
      ast: null,
      diagnostics: [{ ...error.diagnostic, ...(name ? { pou: name.text } : {}) }],
    };
  }
}
