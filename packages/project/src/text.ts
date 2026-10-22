import { lex, parsePou } from "@benchtop-plc/compiler";
import type { Diagnostic, SourceSpan } from "@benchtop-plc/core";
import type { ProjectResult, SplitProgram, VariableDeclaration } from "./model.js";

/** Convert a compiler span to an offset, including the lexer's CRLF handling. */
function offset(source: string, span: SourceSpan, end = false): number {
  const line = end ? span.endLine : span.line;
  const column = end ? span.endColumn : span.column;
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!;
  return lines.slice(0, line - 1).reduce((sum, text) => sum + text.length, 0) + column - 1;
}

export function splitProgram(source: string): ProjectResult<SplitProgram> {
  const result = parsePou(source);
  if (!result.ast) return { value: null, diagnostics: result.diagnostics };
  const { ast } = result;
  const unsupported = ast.sections?.find(
    (section) => !["VAR_INPUT", "VAR_OUTPUT", "VAR_TEMP"].includes(section.name),
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
  const start = endVars.at(-1)?.span ?? ast.resultType?.span ?? ast.name.span;
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
            : declaration.section === "VAR_OUTPUT"
              ? "outputVars"
              : declaration.section === "VAR_TEMP"
                ? "tempVars"
                : "localVars",
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
  return {
    value: {
      kind: ast.kind,
      name: ast.name.name,
      ...(ast.resultType ? { returnType: normalizeType(ast.resultType.key) } : {}),
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
  for (const variable of program.variables) {
    if (section !== variable.section) {
      if (section) declarations += "END_VAR\n";
      section = variable.section;
      declarations += `${{ localVars: "VAR", inputVars: "VAR_INPUT", outputVars: "VAR_OUTPUT", tempVars: "VAR_TEMP" }[section]}\n`;
    }
    declarations += `    ${variable.name}${variable.address === undefined ? "" : ` AT ${variable.address}`} : ${variable.type}${variable.initialValue === undefined ? "" : ` := ${variable.initialValue}`};\n`;
  }
  if (section) declarations += "END_VAR";
  const keyword = { program: "PROGRAM", function: "FUNCTION", functionBlock: "FUNCTION_BLOCK" }[
    program.kind
  ];
  return `${keyword} ${program.name}${program.returnType === undefined ? "" : ` : ${program.returnType}`}${declarations ? `\n${declarations}` : ""}${canonicalBody(program.body)}END_${keyword}\n`;
}

function normalizeType(type: string): string {
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
