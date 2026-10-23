import { isFunctionBlockType, isStandardFunction } from "@benchtop-plc/core";
import type { Diagnostic, ProgramIR } from "@benchtop-plc/core";
import type { Program } from "./ast.js";
import type { CheckedProgram } from "./checked.js";
import { check, checkDeclarations } from "./checker.js";
import { lower, lowerFunction, lowerFunctionBlock } from "./lower.js";
import { isElementaryTypeName } from "./lexer.js";
import { resolveDataTypes } from "./data-types.js";
import { parseDataType, parsePou } from "./parser.js";

/** Source order identifies a POU even when its header is missing or its name is duplicated. */
export type CompileDiagnostic = Diagnostic & {
  sourceIndex?: number;
  sourceKind?: "dataType" | "pou";
};
export type CompileResult =
  | { ir: ProgramIR; diagnostics: CompileDiagnostic[] }
  | { ir?: never; diagnostics: CompileDiagnostic[] };

/** Compatibility entry point for the single-program editor and project codec. */
export function compile(source: string): CompileResult {
  const result = compileProject([source]);
  // Preserve the legacy single-source diagnostic shape for existing callers.
  return {
    ...result,
    diagnostics: result.diagnostics.map((diagnostic) => {
      const legacy = { ...diagnostic };
      delete legacy.sourceIndex;
      return legacy;
    }),
  };
}

/** Compile an ordered list of sources, each containing exactly one POU. */
export function compileProject(
  sources: readonly string[],
  dataTypeSources: readonly string[] = [],
): CompileResult {
  const diagnostics: CompileDiagnostic[] = [];
  const dataTypes: import("./ast.js").DataTypeDeclaration[] = [];
  const typeIndexes = new Map<string, number>();
  for (const [sourceIndex, source] of dataTypeSources.entries()) {
    const parsed = parseDataType(source);
    diagnostics.push(
      ...parsed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourceIndex,
        sourceKind: "dataType" as const,
      })),
    );
    if (parsed.ast) {
      const ast = parsed.ast;
      if (typeIndexes.has(ast.name.key))
        diagnostics.push({
          code: "decl.duplicate",
          severity: "error",
          pou: ast.name.name,
          sourceIndex,
          sourceKind: "dataType",
          span: ast.name.span,
          args: { name: ast.name.name },
        });
      else {
        dataTypes.push(ast);
        typeIndexes.set(ast.name.key, sourceIndex);
      }
    }
  }
  const sourceIndexes = new Map<Program, number>();
  const asts: Program[] = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const parsed = parsePou(source);
    diagnostics.push(...parsed.diagnostics.map((diagnostic) => ({ ...diagnostic, sourceIndex })));
    if (parsed.ast) {
      asts.push(parsed.ast);
      sourceIndexes.set(parsed.ast, sourceIndex);
    }
  }
  // A damaged header cannot reliably participate in project-wide name/count checks.
  if (asts.length !== sources.length) return { diagnostics };
  const pous = new Map<string, Program>();
  for (const ast of asts) {
    const name = ast.name;
    if (pous.has(name.key))
      diagnostics.push({
        code: "pou.duplicate",
        severity: "error",
        pou: name.name,
        sourceIndex: sourceIndexes.get(ast),
        span: name.span,
        args: { name: name.name },
      });
    else pous.set(name.key, ast);
    if (
      isElementaryTypeName(name.key) ||
      isStandardFunction(name.key) ||
      isFunctionBlockType(name.key)
    )
      diagnostics.push({
        code: "pou.name-collision",
        severity: "error",
        pou: name.name,
        sourceIndex: sourceIndexes.get(ast),
        span: name.span,
        args: { name: name.name },
      });
  }
  for (const ast of dataTypes) {
    if (
      pous.has(ast.name.key) ||
      isElementaryTypeName(ast.name.key) ||
      isStandardFunction(ast.name.key) ||
      isFunctionBlockType(ast.name.key)
    )
      diagnostics.push({
        code: "decl.name-collision",
        severity: "error",
        pou: ast.name.name,
        sourceIndex: typeIndexes.get(ast.name.key),
        sourceKind: "dataType",
        span: ast.name.span,
        args: { name: ast.name.name, kind: "type" },
      });
  }
  if (dataTypeSources.length && diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return { diagnostics };
  const resolved = resolveDataTypes(dataTypes);
  diagnostics.push(
    ...resolved.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      sourceIndex: diagnostic.pou ? typeIndexes.get(diagnostic.pou.toUpperCase()) : undefined,
      sourceKind: "dataType" as const,
    })),
  );
  if (resolved.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return { diagnostics };
  const programs = asts.filter((ast) => ast.kind === "program");
  if (programs.length !== 1)
    diagnostics.push({
      code: "pou.program-count",
      severity: "error",
      args: { found: programs.length },
    });
  const functions = asts.filter((ast) => ast.kind === "function");
  const functionIds = new Map(functions.map((ast, index) => [ast.name.key, index]));
  const blocks = asts.filter((ast) => ast.kind === "functionBlock");
  const blockIds = new Map(blocks.map((ast, index) => [ast.name.key, index]));
  const interfaces = new Map<Program, CheckedProgram>();
  for (const ast of asts) {
    const result = checkDeclarations(ast, resolved.types, pous, blockIds);
    if (result.checked) interfaces.set(ast, result.checked);
  }
  const checked = new Map<Program, CheckedProgram>();
  for (const ast of asts) {
    const result = check(ast, pous, functionIds, blockIds, resolved.types, interfaces);
    diagnostics.push(
      ...result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourceIndex: sourceIndexes.get(ast),
      })),
    );
    if (result.checked) checked.set(ast, result.checked);
  }
  if (
    checked.size !== asts.length ||
    diagnostics.some((diagnostic) => diagnostic.severity === "error")
  )
    return { diagnostics };
  // Reject a back edge at its call site, including cycles unreachable from the PROGRAM.
  const visiting = new Set<Program>(),
    visited = new Set<Program>();
  const visit = (ast: Program): void => {
    if (visited.has(ast)) return;
    visiting.add(ast);
    const edges = [
      ...[...checked.get(ast)!.userCalls].map(([node, call]) => ({
        node,
        callee: functions[call.function]!,
      })),
      ...ast.declarations.flatMap((node) => {
        const callee = pous.get(node.typeName.key);
        return callee?.kind === "functionBlock" ? [{ node, callee }] : [];
      }),
    ];
    for (const { node, callee } of edges) {
      if (visiting.has(callee))
        diagnostics.push({
          code: "pou.recursion",
          severity: "error",
          pou: ast.name.name,
          sourceIndex: sourceIndexes.get(ast),
          span: node.span,
          args: { name: callee.name.name },
        });
      else visit(callee);
    }
    visiting.delete(ast);
    visited.add(ast);
  };
  for (const ast of asts) visit(ast);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { diagnostics };
  const ir = lower(
    checked.get(programs[0]!)!,
    blocks.map((ast) => lowerFunctionBlock(checked.get(ast)!)),
  );
  if (functions.length) ir.functions = functions.map((ast) => lowerFunction(checked.get(ast)!));
  return { ir, diagnostics };
}
