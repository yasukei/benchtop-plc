import { check, lex, parsePou, type Declaration, type Expression } from "@benchtop-plc/compiler";
import {
  MAX_STRING_LENGTH,
  formatType,
  arrayType,
  isIntegerType,
  enumerationType,
  type Diagnostic,
  type SourceSpan,
  type TypeTable,
} from "@benchtop-plc/core";
import type { ProjectResult, SplitProgram, VariableDeclaration } from "./model.js";

/** Convert a compiler span to an offset, including the lexer's CRLF handling. */
function offset(source: string, span: SourceSpan, end = false): number {
  const line = end ? span.endLine : span.line;
  const column = end ? span.endColumn : span.column;
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!;
  return lines.slice(0, line - 1).reduce((sum, text) => sum + text.length, 0) + column - 1;
}

export function splitProgram(source: string, types: TypeTable = []): ProjectResult<SplitProgram> {
  const result = parsePou(source);
  if (!result.ast) return { value: null, diagnostics: result.diagnostics };
  const { ast } = result;
  const invalidCapacity = (name: string, length: number | undefined): boolean =>
    length !== undefined &&
    (!["STRING", "WSTRING"].includes(name) ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > MAX_STRING_LENGTH);
  if (
    ast.declarations.some((declaration) =>
      invalidCapacity(declaration.typeName.key, declaration.stringLength),
    ) ||
    (ast.resultType && invalidCapacity(ast.resultType.key, ast.resultStringLength))
  )
    return {
      value: null,
      diagnostics: [{ code: "type.invalid-constant", severity: "error", span: ast.span, args: {} }],
    };

  const unsupported = ast.sections?.find(
    (section) =>
      !["VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_TEMP", "VAR_IN_OUT"].includes(section.name),
  )?.name;
  if (unsupported)
    return {
      value: null,
      diagnostics: [
        { code: "project.unsupported", severity: "error", args: { path: unsupported } },
      ],
    };
  // Lexer tokens supply boundaries without mistaking keywords inside comments for delimiters.
  const { tokens } = lex(source);
  const endVars = tokens!.filter((token) => token.key === "END_VAR");
  const start =
    endVars.at(-1)?.span ??
    ast.resultArray?.span ??
    ast.resultSubrange?.span ??
    (ast.resultStringLength !== undefined
      ? tokens!.find((token) => token.key === "]")?.span
      : undefined) ??
    ast.resultType?.span ??
    ast.name.span;
  const end = tokens!.find(
    (token) =>
      token.key ===
      { program: "END_PROGRAM", function: "END_FUNCTION", functionBlock: "END_FUNCTION_BLOCK" }[
        ast.kind
      ],
  )!.span;
  const variables: VariableDeclaration[] = [];
  for (const declaration of ast.declarations) {
    if (declaration.address && declaration.names.length !== 1) {
      const diagnostic: Diagnostic = {
        code: "decl.at-multiple-names",
        severity: "error",
        args: {},
        span: declaration.span,
      };
      return { value: null, diagnostics: [diagnostic] };
    }
    let initialValue: string | undefined;
    try {
      initialValue = declaration.initializer
        ? canonicalInitializer(
            source,
            declaration.initializer,
            ast.declarations.slice(0, ast.declarations.indexOf(declaration)),
            types,
          )
        : undefined;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return {
        value: null,
        diagnostics: [
          {
            code: "project.invalid",
            severity: "error",
            args: { path: "arrayValue/repetitionValue" },
          },
        ],
      };
    }
    for (const name of declaration.names) {
      variables.push({
        section:
          declaration.section === "VAR_INPUT"
            ? "inputVars"
            : declaration.section === "VAR_IN_OUT"
              ? "inOutVars"
              : declaration.section === "VAR_OUTPUT"
                ? "outputVars"
                : declaration.section === "VAR_TEMP"
                  ? "tempVars"
                  : "localVars",
        ...(declaration.constant ? { constant: true } : {}),
        name: name.name,
        type:
          normalizeType(declaration.typeName.key) +
          (declaration.stringLength === undefined ? "" : `[${declaration.stringLength}]`),
        ...(declaration.address ? { address: declaration.address.text } : {}),
        ...(initialValue === undefined ? {} : { initialValue }),
      });
    }
  }
  // Fold inline limits with earlier POU constants in scope. Other semantic errors
  // must not hide a representable subrange or prevent saving unrelated declarations.
  const rangeType = (
    name: import("@benchtop-plc/compiler").Identifier,
    range:
      import("@benchtop-plc/compiler").Subrange | import("@benchtop-plc/compiler").ArrayDeclaration,
    before: number,
  ): string | undefined => {
    const names = new Set([
      ast.name.key,
      ...ast.declarations.flatMap((declaration) => declaration.names.map((item) => item.key)),
      ...types.map((type) => type.name.toUpperCase()),
    ]);
    let key = "__RANGE";
    while (names.has(key)) key += "_";
    const needed = new Set<string>();
    const dependencies = (span: SourceSpan): void => {
      for (const token of lex(expressionText(source, span)).tokens ?? [])
        if (token.kind === "identifier") needed.add(token.key);
    };
    dependencies(range.span);
    // Walk backwards to include transitive dependencies in their original order.
    // Unrelated unresolved constants remain exchangeable semantic errors.
    const constants = ast.declarations
      .slice(0, before)
      .filter((declaration) => declaration.constant);
    const included: typeof constants = [];
    for (const declaration of constants.toReversed()) {
      if (!declaration.names.some((item) => needed.has(item.key))) continue;
      included.unshift(declaration);
      if (declaration.initializer) dependencies(declaration.initializer.span);
      if (declaration.subrange) dependencies(declaration.subrange.span);
    }
    const result = check(
      {
        ...ast,
        kind: "functionBlock",
        resultType: undefined,
        resultArray: undefined,
        resultSubrange: undefined,
        sections: [],
        body: [],
        declarations: [
          ...included,
          {
            kind: "declaration",
            names: [{ name: key, key, span: name.span }],
            typeName: name,
            ...("dimensions" in range && range.dimensions.includes("*")
              ? { section: "VAR_IN_OUT" as const }
              : {}),
            ...("dimensions" in range ? { array: range } : { subrange: range }),
            span: range.span,
          },
        ],
      },
      new Map(),
      new Map(),
      new Map(),
      types,
    );
    const descriptor = result.checked?.symbols.at(-1)?.descriptor;
    // XML readers canonicalize derived names too; source extensions keep declared spelling.
    if (descriptor) return formatType(descriptor).toUpperCase();
    if ("dimensions" in range && result.diagnostics.some((d) => d.code === "decl.unknown-type")) {
      // Unknown element names are exchangeable semantic errors; fold only the dimensions.
      const eraseElement = (
        array: import("@benchtop-plc/compiler").ArrayDeclaration,
      ): import("@benchtop-plc/compiler").ArrayDeclaration => ({
        ...array,
        typeName: { ...array.typeName, name: "INT", key: "INT" },
        subrange: undefined,
        stringLength: undefined,
        ...(array.array ? { array: eraseElement(array.array) } : {}),
      });
      const folded = check(
        {
          ...ast,
          kind: "functionBlock",
          resultType: undefined,
          resultArray: undefined,
          sections: [],
          body: [],
          declarations: [
            ...included,
            {
              kind: "declaration",
              names: [{ name: key, key, span: name.span }],
              typeName: name,
              ...("dimensions" in range && range.dimensions.includes("*")
                ? { section: "VAR_IN_OUT" as const }
                : {}),
              array: eraseElement(range),
              span: range.span,
            },
          ],
        },
        new Map(),
        new Map(),
        new Map(),
        types,
      ).checked?.symbols.at(-1)?.descriptor;
      const restore = (
        syntax: import("@benchtop-plc/compiler").ArrayDeclaration,
        type: import("@benchtop-plc/core").TypeDescriptor,
      ): string => {
        const array = arrayType(type, types)!;
        const element = syntax.array
          ? restore(syntax.array, array.element)
          : normalizeType(syntax.typeName.key) +
            (syntax.stringLength === undefined ? "" : `[${syntax.stringLength}]`) +
            (syntax.subrange
              ? ` (${expressionText(source, syntax.subrange.lower.span)}..${expressionText(source, syntax.subrange.upper.span)})`
              : "");
        return `ARRAY[${array.dimensions.map((d) => (d === "*" ? "*" : `${d.lower}..${d.upper}`)).join(", ")}] OF ${element}`;
      };
      if (folded) return restore(range, folded);
    }
    return undefined;
  };
  let index = 0;
  for (const [position, declaration] of ast.declarations.entries()) {
    if (declaration.subrange || declaration.array) {
      const type = rangeType(
        declaration.typeName,
        (declaration.array ?? declaration.subrange)!,
        position,
      );
      if (!type)
        return {
          value: null,
          diagnostics: [{ code: "project.invalid", severity: "error", args: { path: "subrange" } }],
        };
      for (let n = 0; n < declaration.names.length; n++) variables[index + n]!.type = type;
    }
    index += declaration.names.length;
  }
  const returnType =
    ast.resultType &&
    (ast.resultSubrange || ast.resultArray
      ? rangeType(ast.resultType, (ast.resultArray ?? ast.resultSubrange)!, ast.declarations.length)
      : normalizeType(ast.resultType.key) +
        (ast.resultStringLength === undefined ? "" : `[${ast.resultStringLength}]`));
  if ((ast.resultSubrange || ast.resultArray) && !returnType)
    return {
      value: null,
      diagnostics: [
        { code: "project.invalid", severity: "error", args: { path: "returnType/subrange" } },
      ],
    };
  return {
    value: {
      kind: ast.kind,
      name: ast.name.name,
      ...(returnType ? { returnType } : {}),
      variables,
      body: source.slice(offset(source, start, true), offset(source, end)),
    },
    diagnostics: [],
  };
}

/** Add only missing line separators so canonical imports remain stable on repeated exchanges. */
export function canonicalBody(body: string): string {
  const separated = /^[\r\n]/.test(body) ? body : `\n${body}`;
  return /[\r\n]$/.test(separated) ? separated : `${separated}\n`;
}

/** External files without our source extension receive a canonical declaration section. */
export function joinProgram(program: SplitProgram): string {
  let declarations = "";
  let section: VariableDeclaration["section"] | undefined;
  let constant = false;
  for (const variable of program.variables) {
    if (section !== variable.section || constant !== !!variable.constant) {
      if (section) declarations += "END_VAR\n";
      section = variable.section;
      constant = !!variable.constant;
      declarations += `${{ localVars: "VAR", inputVars: "VAR_INPUT", outputVars: "VAR_OUTPUT", tempVars: "VAR_TEMP", inOutVars: "VAR_IN_OUT" }[section]}${constant ? " CONSTANT" : ""}\n`;
    }
    declarations += `    ${variable.name}${variable.address === undefined ? "" : ` AT ${variable.address}`} : ${variable.type}${variable.initialValue === undefined ? "" : ` := ${variable.initialValue}`};\n`;
  }
  if (section) declarations += "END_VAR";
  const keyword = { program: "PROGRAM", function: "FUNCTION", functionBlock: "FUNCTION_BLOCK" }[
    program.kind
  ];
  return `${keyword} ${program.name}${program.returnType === undefined ? "" : ` : ${program.returnType}`}${declarations ? `\n${declarations}` : ""}${canonicalBody(program.body)}END_${keyword}\n`;
}

export function normalizeType(type: string): string {
  return (
    (
      {
        TIME_OF_DAY: "TOD",
        DATE_AND_TIME: "DT",
        LTIME_OF_DAY: "LTOD",
        LDATE_AND_TIME: "LDT",
      } as Record<string, string>
    )[type] ?? type
  );
}

export function expressionText(source: string, span: SourceSpan): string {
  return source.slice(offset(source, span), offset(source, span, true));
}
export function containsSpan(outer: SourceSpan, inner: SourceSpan): boolean {
  return (
    (inner.line > outer.line || (inner.line === outer.line && inner.column >= outer.column)) &&
    (inner.endLine < outer.endLine ||
      (inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn))
  );
}

/** Canonical XML spelling preserves repetition and expands repeated groups in source order. */
export function canonicalInitializer(
  source: string,
  node: Expression,
  declarations: Declaration[] = [],
  types: TypeTable = [],
): string {
  if (node.kind === "structureInitializer")
    return `(${node.members.map((member) => `${member.name.name} := ${canonicalInitializer(source, member.value, declarations, types)}`).join(", ")})`;
  if (node.kind !== "arrayInitializer") return expressionText(source, node.span);
  const items: string[] = [];
  for (const item of node.items) {
    const values = item.values.map((value) =>
      canonicalInitializer(source, value, declarations, types),
    );
    if (!item.count) {
      items.push(...values);
      continue;
    }
    const countAst = parsePou(
      `PROGRAM Initial MOVE(${expressionText(source, item.count.span)}); END_PROGRAM`,
    ).ast;
    if (!countAst) throw new RangeError("Invalid repetition expression");
    const statement = countAst.body[0]!;
    if (statement.kind !== "call") throw new RangeError("Invalid repetition expression");
    const countExpression = statement.call.args[0]!;
    // Only count dependencies participate, so unrelated semantic errors remain exchangeable.
    const needed = new Set(
      (lex(expressionText(source, item.count.span)).tokens ?? []).map((t) => t.key),
    );
    const constants: Declaration[] = [];
    for (const declaration of declarations.toReversed()) {
      if (!declaration.constant || !declaration.names.some((n) => needed.has(n.key))) continue;
      constants.unshift(declaration);
      if (declaration.initializer)
        for (const token of lex(expressionText(source, declaration.initializer.span)).tokens ?? [])
          needed.add(token.key);
    }
    const checked = check(
      { ...countAst, declarations: constants },
      new Map(),
      new Map(),
      new Map(),
      types,
    );
    const info = checked.checked?.expressions.get(countExpression);
    const count = Number(info?.constant);
    if (
      !info ||
      !isIntegerType(info.dataType) ||
      enumerationType(info.descriptor ?? info.dataType, types) ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > 10000
    )
      throw new RangeError("Invalid array repetition");
    if (values.length === 1) items.push(`${count}(${values[0]})`);
    else for (let i = 0; i < count; i++) items.push(...values);
  }
  return `[${items.join(", ")}]`;
}
