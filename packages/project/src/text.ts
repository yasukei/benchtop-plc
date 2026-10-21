import { lex, parse } from "@benchtop-plc/compiler";
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
  const result = parse(source);
  if (!result.ast) return { value: null, diagnostics: result.diagnostics };
  const { ast } = result;
  // Lexer tokens supply boundaries without mistaking keywords inside comments for delimiters.
  const { tokens } = lex(source);
  const endVars = tokens!.filter((token) => token.key === "END_VAR");
  const start = endVars.at(-1)?.span ?? ast.name.span;
  const end = tokens!.find((token) => token.key === "END_PROGRAM")!.span;
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
        name: name.name,
        type:
          (
            {
              TIME_OF_DAY: "TOD",
              DATE_AND_TIME: "DT",
              LTIME_OF_DAY: "LTOD",
              LDATE_AND_TIME: "LDT",
            } as Record<string, string>
          )[declaration.typeName.key] ?? declaration.typeName.key,
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
      name: ast.name.name,
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
  const declarations = program.variables.map(
    (variable) =>
      `    ${variable.name}${variable.address === undefined ? "" : ` AT ${variable.address}`} : ${variable.type}${variable.initialValue === undefined ? "" : ` := ${variable.initialValue}`};`,
  );
  return `PROGRAM ${program.name}\nVAR\n${declarations.join("\n")}\nEND_VAR${canonicalBody(program.body)}END_PROGRAM\n`;
}
