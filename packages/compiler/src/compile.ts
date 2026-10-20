import type { Diagnostic, ProgramIR } from "@benchtop-plc/core";
import { check } from "./checker.js";
import { lower } from "./lower.js";
import { parse } from "./parser.js";

export type CompileResult =
  { ir: ProgramIR; diagnostics: Diagnostic[] } | { ir?: never; diagnostics: Diagnostic[] };

/** Parse, check and lower a single ST program. Failed compilation never exposes partial IR. */
export function compile(source: string): CompileResult {
  const parsed = parse(source);
  if (!parsed.ast) return { diagnostics: parsed.diagnostics };
  const result = check(parsed.ast);
  if (!result.checked) return { diagnostics: result.diagnostics };
  return { ir: lower(result.checked), diagnostics: result.diagnostics };
}
