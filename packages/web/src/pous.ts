import { compileProject, lex, type CompileDiagnostic } from "@benchtop-plc/compiler";
import { spanRange } from "./editor/mapping.js";
import type { Diagnostic } from "@benchtop-plc/core";

export type PouKind = "PROGRAM" | "FUNCTION" | "FUNCTION_BLOCK";
export interface EditorPou {
  source: string;
  name: string;
  kind: PouKind;
}
export type EditorDiagnostic = CompileDiagnostic;

export function derivePou(source: string, previous?: EditorPou): EditorPou {
  const scanned = lex(source);
  const tokens =
    scanned.tokens ??
    lex(source.slice(0, spanRange(source, scanned.diagnostics[0]!.span!).from)).tokens;
  const kind = tokens?.[0]?.key;
  const name = tokens?.[1];
  if (
    (kind === "PROGRAM" || kind === "FUNCTION" || kind === "FUNCTION_BLOCK") &&
    name?.kind === "identifier"
  )
    return { source, name: name.text, kind };
  return { source, name: previous?.name ?? "Main", kind: previous?.kind ?? "PROGRAM" };
}

export const createPous = (sources: readonly string[]): EditorPou[] =>
  sources.map((source) => derivePou(source));
export const pouSources = (pous: readonly EditorPou[]): string[] => pous.map((pou) => pou.source);
export const initialPouIndex = (pous: readonly EditorPou[]): number =>
  Math.max(
    0,
    pous.findIndex((pou) => pou.kind === "PROGRAM"),
  );
export const sameSources = (a: readonly string[], b: readonly string[] | null): boolean =>
  b !== null && a.length === b.length && a.every((source, index) => source === b[index]);

export function uniqueFunctionName(pous: readonly EditorPou[], prefix = "F"): string {
  const names = new Set(pous.map((pou) => pou.name.toUpperCase()));
  let number = 1;
  while (names.has(`${prefix}${number}`)) number++;
  return `${prefix}${number}`;
}

export function addFunction(pous: readonly EditorPou[]): EditorPou[] {
  const name = uniqueFunctionName(pous);
  return [
    ...pous,
    derivePou(
      `FUNCTION ${name} : INT\nVAR_INPUT\n  value : INT;\nEND_VAR\n\n${name} := value;\nEND_FUNCTION\n`,
    ),
  ];
}

export function addFunctionBlock(pous: readonly EditorPou[]): EditorPou[] {
  const name = uniqueFunctionName(pous, "FB");
  return [
    ...pous,
    derivePou(
      `FUNCTION_BLOCK ${name}\nVAR_INPUT\n  value : BOOL;\nEND_VAR\nVAR_OUTPUT\n  Q : BOOL;\nEND_VAR\n\nQ := value;\nEND_FUNCTION_BLOCK\n`,
    ),
  ];
}

export function deletePou(pous: EditorPou[], index: number): EditorPou[] {
  if (!pous[index] || pous[index].kind === "PROGRAM") return pous;
  return pous.filter((_, position) => position !== index);
}

/** Give even a broken header's diagnostics a stable editor location. */
export function compilePous(pous: readonly EditorPou[]) {
  return compileProject(pouSources(pous));
}

export function diagnosticPouIndex(
  pous: readonly EditorPou[],
  diagnostic: Diagnostic,
): number | undefined {
  const index = diagnostic.pou
    ? pous.findIndex((pou) => pou.name.toUpperCase() === diagnostic.pou!.toUpperCase())
    : pous.findIndex((pou) => pou.kind === "PROGRAM");
  return index < 0 ? undefined : index;
}
