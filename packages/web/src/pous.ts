import type { Project } from "@benchtop-plc/project";
import { compileProject, lex, type CompileDiagnostic } from "@benchtop-plc/compiler";
import { spanRange } from "./editor/mapping.js";
import type { Diagnostic } from "@benchtop-plc/core";

export type PouKind = "PROGRAM" | "FUNCTION" | "FUNCTION_BLOCK" | "CLASS" | "INTERFACE";
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
export interface EditorConfiguration {
  source: string;
  name: string;
  kind: "CONFIGURATION";
}
export type EditorDiagnostic = CompileDiagnostic;

/** Source indexes belong to separate lists for POUs and data types. */
export function diagnosticPouSourceIndex(diagnostic: EditorDiagnostic): number | undefined {
  return diagnostic.sourceKind === "dataType" || diagnostic.sourceKind === "configuration"
    ? undefined
    : diagnostic.sourceIndex;
}

function headerTokens(source: string) {
  const scanned = lex(source);
  const tokens =
    scanned.tokens ??
    lex(source.slice(0, spanRange(source, scanned.diagnostics[0]!.span!).from)).tokens;
  const current = () => tokens?.[0];
  let namespace = "";
  if (current()?.key === "NAMESPACE" && tokens) {
    tokens.shift();
    while (current()?.kind === "identifier" || current()?.key === ".")
      namespace += tokens.shift()!.text;
  }
  while (current()?.key === "USING" && tokens) {
    while (tokens.length && current()?.key !== ";" && current()?.kind !== "eof") tokens.shift();
    if (current()?.key === ";") tokens.shift();
    else break;
  }
  return { tokens, namespace };
}

export function deriveConfiguration(
  source: string,
  previous?: EditorConfiguration,
): EditorConfiguration {
  const { tokens } = headerTokens(source);
  const name =
    tokens?.[0]?.key === "CONFIGURATION" && tokens[1]?.kind === "identifier"
      ? tokens[1].text
      : (previous?.name ?? "Config");
  return { source, name, kind: "CONFIGURATION" };
}

/** Preserve implicit project names where possible, avoiding the shared namespace. */
export function configurationTemplate(
  pous: readonly EditorPou[],
  dataTypes: readonly EditorDataType[],
  project: Project | null,
  intervalMs: number,
): EditorConfiguration {
  const names = new Set([...pous, ...dataTypes].map(({ name }) => name.toUpperCase()));
  const claim = (preferred: string) => {
    let name = preferred;
    let suffix = 1;
    while (names.has(name.toUpperCase())) name = `${preferred}${suffix++}`;
    names.add(name.toUpperCase());
    return name;
  };
  const configuration = claim(project?.configuration ?? "Config");
  const resource = claim(project?.resource ?? "Res");
  const task = claim(project?.task.name ?? "Cyclic");
  const instances = pous
    .filter((pou) => pou.kind === "PROGRAM")
    .map((pou, index) => {
      const preferred =
        index === 0
          ? (project?.instance?.name ?? "mainInstance")
          : `${pou.name.replaceAll(".", "_")}Instance`;
      return `    PROGRAM ${claim(preferred)} WITH ${task} : ${pou.name};`;
    });
  return deriveConfiguration(`CONFIGURATION ${configuration}
  RESOURCE ${resource} ON BENCHTOP
    TASK ${task} (INTERVAL := T#${intervalMs}ms, PRIORITY := ${project?.task.priority ?? 1});
${instances.join("\n")}
  END_RESOURCE
END_CONFIGURATION
`);
}

export function deriveDataType(source: string, previous?: EditorDataType): EditorDataType {
  const { tokens, namespace } = headerTokens(source);
  const name =
    tokens?.[0]?.key === "TYPE" &&
    tokens.find((t, i) => i > 0 && t.key !== "INTERNAL")?.kind === "identifier"
      ? `${namespace ? `${namespace}.` : ""}${tokens.find((t, i) => i > 0 && t.key !== "INTERNAL")!.text}`
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
  selectedConfiguration = false,
): boolean {
  if (selectedConfiguration) return diagnostic.sourceKind === "configuration";
  return (
    diagnostic.sourceKind !== "configuration" &&
    diagnostic.sourceIndex === (selectedDataType ?? selectedPou) &&
    (diagnostic.sourceKind === "dataType") === (selectedDataType !== null)
  );
}

export function derivePou(source: string, previous?: EditorPou): EditorPou {
  const { tokens, namespace } = headerTokens(source);
  const kind = tokens?.[0]?.key;
  const name = tokens
    ?.slice(1)
    .find((token) => !["INTERNAL", "ABSTRACT", "FINAL"].includes(token.key));
  if (
    (kind === "PROGRAM" ||
      kind === "FUNCTION" ||
      kind === "FUNCTION_BLOCK" ||
      kind === "CLASS" ||
      kind === "INTERFACE") &&
    name?.kind === "identifier"
  )
    return { source, name: `${namespace ? `${namespace}.` : ""}${name.text}`, kind };
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

export function addInterface(
  pous: readonly EditorPou[],
  dataTypes: readonly EditorDataType[] = [],
): EditorPou[] {
  const name = uniqueFunctionName([...pous, ...dataTypes], "I");
  return [derivePou(`INTERFACE ${name}\nMETHOD Run\nEND_METHOD\nEND_INTERFACE\n`), ...pous];
}

export function addClass(
  pous: readonly EditorPou[],
  dataTypes: readonly EditorDataType[] = [],
): EditorPou[] {
  const name = uniqueFunctionName([...pous, ...dataTypes], "Class");
  return [...pous, derivePou(`CLASS ${name}\nMETHOD PUBLIC Run\nEND_METHOD\nEND_CLASS\n`)];
}

export function deletePou(pous: EditorPou[], index: number): EditorPou[] {
  if (!pous[index] || pous[index].kind === "PROGRAM") return pous;
  return pous.filter((_, position) => position !== index);
}

/** Give even a broken header's diagnostics a stable editor location. */
export function implicitConfiguration(project: Project | null, intervalMs = 10) {
  return {
    name: project?.configuration,
    resource: project?.resource,
    task: {
      name: project?.task.name ?? "Cyclic",
      priority: project?.task.priority ?? 1,
      intervalMs,
    },
    instance: project?.instance?.name,
  };
}
export function compilePous(
  pous: readonly EditorPou[],
  dataTypes: readonly string[] = [],
  project: Project | null = null,
  intervalMs = 10,
  configuration: EditorConfiguration | null = project?.configurationSource === undefined
    ? null
    : deriveConfiguration(project.configurationSource),
) {
  return compileProject(
    pouSources(pous),
    dataTypes,
    configuration?.source,
    implicitConfiguration(project, intervalMs),
  );
}

export function diagnosticPouIndex(
  pous: readonly EditorPou[],
  diagnostic: Diagnostic,
): number | undefined {
  const index = diagnostic.pou
    ? pous.findIndex(
        (pou) =>
          diagnostic.pou!.toUpperCase() === pou.name.toUpperCase() ||
          diagnostic.pou!.toUpperCase().startsWith(`${pou.name.toUpperCase()}.`),
      )
    : pous.findIndex((pou) => pou.kind === "PROGRAM");
  return index < 0 ? undefined : index;
}
