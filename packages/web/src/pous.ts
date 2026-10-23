import { compileProject, lex, type CompileDiagnostic } from "@benchtop-plc/compiler";
import { spanRange } from "./editor/mapping.js";
import type { Diagnostic } from "@benchtop-plc/core";

export type PouKind = "PROGRAM" | "FUNCTION" | "FUNCTION_BLOCK";
export interface EditorPou {
  source: string;
  name: string;
  kind: PouKind;
}
export interface EditorDataType {
  source: string;
  name: string;
  kind: "TYPE";
}
export type EditorDiagnostic = CompileDiagnostic;

/** Source indexes belong to separate lists for POUs and data types. */
export function diagnosticPouSourceIndex(diagnostic: EditorDiagnostic): number | undefined {
  return diagnostic.sourceKind === "dataType" ? undefined : diagnostic.sourceIndex;
}

function headerTokens(source: string) {
  const scanned = lex(source);
  const tokens =
    scanned.tokens ??
    lex(source.slice(0, spanRange(source, scanned.diagnostics[0]!.span!).from)).tokens;
  return tokens;
}

export function deriveDataType(source: string, previous?: EditorDataType): EditorDataType {
  const tokens = headerTokens(source);
  const name =
    tokens?.[0]?.key === "TYPE" && tokens[1]?.kind === "identifier"
      ? tokens[1].text
      : (previous?.name ?? "Type1");
  return { source, name, kind: "TYPE" };
}
export const createDataTypes = (sources: readonly string[]): EditorDataType[] =>
  sources.map((source) => deriveDataType(source));
export function addDataType(dataTypes: readonly EditorDataType[], pous: readonly EditorPou[]) {
  const name = uniqueFunctionName([...pous, ...dataTypes], "Type");
  return [...dataTypes, deriveDataType(`TYPE ${name} : (Idle, Running, Done); END_TYPE\n`)];
}
export function deleteDataType(dataTypes: EditorDataType[], index: number): EditorDataType[] {
  return dataTypes[index] ? dataTypes.filter((_, position) => position !== index) : dataTypes;
}
export function diagnosticSourceMatches(
  diagnostic: EditorDiagnostic,
  selectedPou: number,
  selectedDataType: number | null,
): boolean {
  return (
    diagnostic.sourceIndex === (selectedDataType ?? selectedPou) &&
    (diagnostic.sourceKind === "dataType") === (selectedDataType !== null)
  );
}

export function derivePou(source: string, previous?: EditorPou): EditorPou {
  const tokens = headerTokens(source);
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
export const pouSources = (pous: readonly { source: string }[]): string[] =>
  pous.map((pou) => pou.source);
export const initialPouIndex = (pous: readonly EditorPou[]): number =>
  Math.max(
    0,
    pous.findIndex((pou) => pou.kind === "PROGRAM"),
  );
export const sameSources = (a: readonly string[], b: readonly string[] | null): boolean =>
  b !== null && a.length === b.length && a.every((source, index) => source === b[index]);

export function uniqueFunctionName(pous: readonly { name: string }[], prefix = "F"): string {
  const names = new Set(pous.map((pou) => pou.name.toUpperCase()));
  let number = 1;
  while (names.has(`${prefix.toUpperCase()}${number}`)) number++;
  return `${prefix}${number}`;
}

export function addFunction(
  pous: readonly EditorPou[],
  dataTypes: readonly EditorDataType[] = [],
): EditorPou[] {
  const name = uniqueFunctionName([...pous, ...dataTypes]);
  return [
    ...pous,
    derivePou(
      `FUNCTION ${name} : INT\nVAR_INPUT\n  value : INT;\nEND_VAR\n\n${name} := value;\nEND_FUNCTION\n`,
    ),
  ];
}

export function addFunctionBlock(
  pous: readonly EditorPou[],
  dataTypes: readonly EditorDataType[] = [],
): EditorPou[] {
  const name = uniqueFunctionName([...pous, ...dataTypes], "FB");
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
export function compilePous(pous: readonly EditorPou[], dataTypes: readonly string[] = []) {
  return compileProject(pouSources(pous), dataTypes);
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
