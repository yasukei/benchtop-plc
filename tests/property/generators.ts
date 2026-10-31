import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import fc from "fast-check";
import { lex } from "@benchtop-plc/compiler";
import { readProject, writeProject, type Project } from "@benchtop-plc/project";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const stFiles = globSync(["tests/conformance/**/*.st", "examples/**/*.st"], { cwd: root }).sort();
export const xmlFiles = globSync("examples/**/*.xml", { cwd: root }).sort();

export interface Sources {
  pous: string[];
  dataTypes: string[];
  configurationSource?: string;
}

const groups = new Map<string, Sources>();
for (const file of stFiles) {
  const group = groups.get(dirname(file)) ?? { pous: [], dataTypes: [] };
  if (file.endsWith(".type.st")) group.dataTypes.push(read(file));
  else if (file.endsWith(".config.st")) group.configurationSource = read(file);
  else group.pous.push(read(file));
  groups.set(dirname(file), group);
}
export const xmlCorpus = xmlFiles.map(read);
const exampleProjects = xmlCorpus.map((xml) => {
  const result = readProject(xml);
  if (!result.value) throw new Error(`Invalid fuzz corpus: ${JSON.stringify(result.diagnostics)}`);
  return result.value;
});
export const sourceCorpus = [
  ...stFiles.map(read),
  ...exampleProjects.flatMap((p) => [
    ...p.pous,
    ...p.dataTypes,
    ...(p.configurationSource === undefined ? [] : [p.configurationSource]),
  ]),
];
const projectCorpus: Sources[] = [
  ...groups.values(),
  ...exampleProjects.map(({ pous, dataTypes, configurationSource }) => ({
    pous,
    dataTypes,
    ...(configurationSource === undefined ? {} : { configurationSource }),
  })),
];

export function projectFrom(sources: Sources): Project {
  return {
    fileHeader: {
      companyName: "Property tests",
      productName: "benchtop-plc",
      productVersion: "test",
      creationDateTime: "2026-10-31T00:00:00Z",
    },
    contentHeader: { name: "Generated project" },
    ...sources,
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: null,
  };
}

// Include XML built from a conformance fixture as well as the bundled example files.
const fixture = writeProject(
  projectFrom({ pous: [read("tests/conformance/fixtures/reference.st")], dataTypes: [] }),
);
if (!fixture.value) throw new Error("Could not serialize the XML fuzz fixture");
xmlCorpus.push(fixture.value);

const text = fc.string({ unit: "binary", maxLength: 256 });
const fragment = fc.oneof(
  fc.string({ unit: "binary", maxLength: 24 }),
  fc.constantFrom("(*", "*)", "'", '"', ":=", ";", "END_VAR", "&#0;", "<![CDATA[", "]]>"),
);
const edits = fc.array(
  fc.record({
    operation: fc.constantFrom("insert", "delete", "replace", "duplicate"),
    position: fc.nat(),
    width: fc.integer({ min: 1, max: 32 }),
    text: fragment,
  }),
  { minLength: 1, maxLength: 4 },
);

function mutate(
  source: string,
  mutations: readonly { operation: string; position: number; width: number; text: string }[],
): string {
  for (const edit of mutations) {
    const start = edit.position % (source.length + 1);
    const end = Math.min(start + edit.width, source.length);
    const replacement =
      edit.operation === "delete"
        ? ""
        : edit.operation === "duplicate"
          ? source.slice(start, end).repeat(2)
          : edit.text;
    source =
      source.slice(0, start) +
      replacement +
      source.slice(edit.operation === "insert" ? start : end);
  }
  return source;
}

const mutatedSource = fc
  .tuple(fc.constantFrom(...sourceCorpus), edits)
  .map(([source, changes]) => mutate(source, changes));
const corpusTokens = sourceCorpus.flatMap((source) => lex(source).tokens ?? []);
const tokens = [...new Set(corpusTokens.map((token) => token.text).filter(Boolean))];
const tokenVocabulary = new Map<string, string[]>(
  ["identifier", "integer", "real", "boolean", "string"].map((kind) => [
    kind,
    [...new Set(corpusTokens.filter((token) => token.kind === kind).map((token) => token.text))],
  ]),
);

function mutateToken(source: string, position: number, replacement: number): string {
  const lexed = lex(source).tokens;
  if (!lexed) return source;
  const candidates = lexed.filter((token) => tokenVocabulary.has(token.kind));
  if (!candidates.length) return source;
  const selected = candidates[position % candidates.length]!;
  const vocabulary = tokenVocabulary.get(selected.kind)!.filter((text) => text !== selected.text);
  if (!vocabulary.length) return source;
  // Re-joining token spellings preserves token boundaries and drops only comments/whitespace.
  return lexed
    .filter((token) => token.kind !== "eof")
    .map((token) =>
      token === selected ? vocabulary[replacement % vocabulary.length]! : token.text,
    )
    .join(" ");
}
const generatedTokens = fc
  .array(fc.constantFrom(...tokens), { maxLength: 64 })
  .map((items) => items.join(" "));
// Large enough to exercise the stack-overflow regression, bounded independently of the guard.
export const nestingDepth = fc.integer({ min: 0, max: 4096 });
export const sourceAtDepth = (depth: number) =>
  `PROGRAM Main VAR x : INT; END_VAR x := ${"(".repeat(depth)}1${")".repeat(depth)}; END_PROGRAM`;
const nestedSource = nestingDepth.map(sourceAtDepth);
export const stSource = fc.oneof(text, generatedTokens, mutatedSource, nestedSource);
function mutateProject(
  project: Sources,
  index: number,
  transform: (source: string) => string,
): Sources {
  const copy: Sources = { ...project, pous: [...project.pous], dataTypes: [...project.dataTypes] };
  const size =
    copy.pous.length + copy.dataTypes.length + Number(copy.configurationSource !== undefined);
  const selected = index % size;
  if (selected < copy.pous.length) copy.pous[selected] = transform(copy.pous[selected]!);
  else if (selected < copy.pous.length + copy.dataTypes.length) {
    const typeIndex = selected - copy.pous.length;
    copy.dataTypes[typeIndex] = transform(copy.dataTypes[typeIndex]!);
  } else copy.configurationSource = transform(copy.configurationSource!);
  return copy;
}

export const projectSources = fc.oneof(
  stSource.map((source): Sources => ({ pous: [source], dataTypes: [] })),
  fc
    .tuple(fc.constantFrom(...projectCorpus), fc.nat(), edits)
    .map(([project, index, changes]) =>
      mutateProject(project, index, (source) => mutate(source, changes)),
    ),
  fc
    .tuple(fc.constantFrom(...projectCorpus), fc.nat(), fc.nat(), fc.nat())
    .map(([project, index, position, replacement]) =>
      mutateProject(project, index, (source) => mutateToken(source, position, replacement)),
    ),
);
export const mutatedXml = fc
  .tuple(fc.constantFrom(...xmlCorpus), edits)
  .map(([xml, changes]) => mutate(xml, changes));

// XML 1.0 text excludes control characters; keep escaping and non-ASCII text in scope.
const xmlText = fc
  .array(fc.constantFrom("a", " ", "<", ">", "&", "'", '"', "運", "転", "🙂"), { maxLength: 24 })
  .map((chars) => chars.join(""));
export const validProject = fc
  .record({
    initial: fc.integer({ min: -100, max: 100 }),
    deltas: fc.array(fc.integer({ min: -10, max: 10 }), { minLength: 1, maxLength: 8 }),
    width: fc.integer({ min: 1, max: 4 }),
    explicit: fc.boolean(),
    crlf: fc.boolean(),
    name: xmlText,
    label: xmlText,
    enabled: fc.boolean(),
  })
  .map(({ initial, deltas, width, explicit, crlf, name, label, enabled }): Project => {
    const newline = crlf ? "\r\n" : "\n";
    const project = projectFrom({
      dataTypes: ["TYPE CounterValue : INT; END_TYPE"],
      pous: [
        [
          "PROGRAM Main",
          `VAR value : CounterValue := ${initial}; values : ARRAY[0..${width - 1}] OF INT; enabled : BOOL := ${enabled ? "TRUE" : "FALSE"}; END_VAR`,
          ...deltas.map(
            (delta, index) =>
              `IF enabled THEN value := Adjust(value, ${delta}); ELSE values[${index % width}] := value; END_IF;`,
          ),
          "END_PROGRAM",
        ].join(newline),
        [
          "FUNCTION Adjust : INT",
          "VAR_INPUT value, delta : INT; END_VAR",
          "Adjust := value + delta;",
          "END_FUNCTION",
        ].join(newline),
      ],
      ...(explicit
        ? {
            configurationSource: [
              "CONFIGURATION Config RESOURCE Res ON Cpu",
              "TASK Cyclic (INTERVAL := T#10ms, PRIORITY := 1);",
              "PROGRAM mainInstance WITH Cyclic : Main;",
              "END_RESOURCE END_CONFIGURATION",
            ].join(newline),
          }
        : {}),
    });
    project.contentHeader.name = name;
    project.fileHeader.companyName = label;
    project.panel = { label, enabled, values: deltas, nested: { initial } };
    return project;
  });
