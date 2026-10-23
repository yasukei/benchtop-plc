import { check, lex, parsePou } from "@benchtop-plc/compiler";
import type { Diagnostic, SourceSpan, TypeTable } from "@benchtop-plc/core";
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
    endVars.at(-1)?.span ?? ast.resultSubrange?.span ?? ast.resultType?.span ?? ast.name.span;
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
        type: normalizeType(declaration.typeName.key),
        ...(declaration.address ? { address: declaration.address.text } : {}),
        ...(declaration.initializer
          ? {
              initialValue: source.slice(
                offset(source, declaration.initializer.span),
                offset(source, declaration.initializer.span, true),
              ),
            }
          : {}),
      });
    }
  }
  // Fold inline limits with earlier POU constants in scope. Other semantic errors
  // must not hide a representable subrange or prevent saving unrelated declarations.
  const rangeType = (
    name: import("@benchtop-plc/compiler").Identifier,
    range: import("@benchtop-plc/compiler").Subrange,
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
        kind: "program",
        resultType: undefined,
        resultSubrange: undefined,
        sections: [],
        body: [],
        declarations: [
          ...included,
          {
            kind: "declaration",
            names: [{ name: key, key, span: name.span }],
            typeName: name,
            subrange: range,
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
    return descriptor && typeof descriptor !== "string" && descriptor.kind === "subrange"
      ? `${descriptor.base} (${descriptor.lower}..${descriptor.upper})`
      : undefined;
  };
  let index = 0;
  for (const [position, declaration] of ast.declarations.entries()) {
    if (declaration.subrange) {
      const type = rangeType(declaration.typeName, declaration.subrange, position);
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
    (ast.resultSubrange
      ? rangeType(ast.resultType, ast.resultSubrange, ast.declarations.length)
      : normalizeType(ast.resultType.key));
  if (ast.resultSubrange && !returnType)
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
