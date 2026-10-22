import { isFunctionBlockType, isStandardFunction } from "@benchtop-plc/core";
import type { Diagnostic, ProgramIR } from "@benchtop-plc/core";
import type { Program } from "./ast.js";
import type { CheckedProgram } from "./checked.js";
import { check } from "./checker.js";
import { lower, lowerFunction } from "./lower.js";
import { isElementaryTypeName } from "./lexer.js";
import { parsePou } from "./parser.js";

export type CompileResult =
  { ir: ProgramIR; diagnostics: Diagnostic[] } | { ir?: never; diagnostics: Diagnostic[] };

/** Compatibility entry point for the single-program editor and project codec. */
export function compile(source: string): CompileResult {
  return compileProject([source]);
}

/** Compile an ordered list of sources, each containing exactly one POU. */
export function compileProject(sources: readonly string[]): CompileResult {
  const diagnostics: Diagnostic[] = [];
  const asts: Program[] = [];
  for (const source of sources) {
    const parsed = parsePou(source);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.ast) asts.push(parsed.ast);
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
        span: name.span,
        args: { name: name.name },
      });
    if (ast.kind === "functionBlock")
      diagnostics.push({
        code: "pou.unsupported-kind",
        severity: "error",
        pou: name.name,
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
  const checked = new Map<Program, CheckedProgram>();
  for (const ast of asts) {
    const result = check(ast, pous, functionIds);
    diagnostics.push(...result.diagnostics);
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
    for (const [node, call] of checked.get(ast)!.userCalls) {
      const callee = functions[call.function]!;
      if (visiting.has(callee))
        diagnostics.push({
          code: "pou.recursion",
          severity: "error",
          pou: ast.name.name,
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
  const ir = lower(checked.get(programs[0]!)!);
  if (functions.length) ir.functions = functions.map((ast) => lowerFunction(checked.get(ast)!));
  return { ir, diagnostics };
}
