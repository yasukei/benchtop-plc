import { isFunctionBlockType, isStandardFunction } from "@benchtop-plc/core";
import type { Diagnostic, ProgramIR } from "@benchtop-plc/core";
import type { Program } from "./ast.js";
import type { CheckedProgram } from "./checked.js";
import { check } from "./checker.js";
import { lower, lowerFunction, lowerFunctionBlock } from "./lower.js";
import { isElementaryTypeName } from "./lexer.js";
import { parsePou } from "./parser.js";

/** Source order identifies a POU even when its header is missing or its name is duplicated. */
export type CompileDiagnostic = Diagnostic & { sourceIndex?: number };
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
export function compileProject(sources: readonly string[]): CompileResult {
  const diagnostics: CompileDiagnostic[] = [];
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
  const checked = new Map<Program, CheckedProgram>();
  for (const ast of asts) {
    const result = check(ast, pous, functionIds, blockIds);
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
