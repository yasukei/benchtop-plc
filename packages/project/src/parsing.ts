import {
  parsePou,
  NamespaceContext,
  resolveNamespaces,
  parseConfiguration,
  parseDataType,
  type DataTypeDeclaration,
  type Program,
} from "@benchtop-plc/compiler";

/** Valid ST names, unique even against unresolved references in generated wrappers.
 * Conservatively reserve words inside comments and strings too; no parse is needed.
 */
export function generatedIdentifier(base: string, ...sources: string[]): string {
  const used = new Set(
    sources.flatMap((source) => source.toUpperCase().match(/[A-Z_][A-Z_0-9]*/g) ?? []),
  );
  let name = base;
  for (let suffix = 1; used.has(name.toUpperCase()); suffix++) name = `${base}${suffix}`;
  return name;
}

/** Parser results are plain trees. Preserve undefined and non-finite numeric literals too. */
function copyTree<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => copyTree(item)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]: [string, unknown]) => [key, copyTree(child)]),
    ) as T;
  return value;
}

function cachedParser<T>(parse: (source: string, legacyNames: boolean) => T) {
  const results = [new Map<string, T>(), new Map<string, T>()];
  return (source: string, legacyNames = false): T => {
    const cache = results[Number(legacyNames)]!;
    if (!cache.has(source)) cache.set(source, parse(source, legacyNames));
    // Namespace resolution and semantic checks mutate ASTs. Never expose the cached tree.
    return copyTree(cache.get(source)!);
  };
}

/** One operation owns its cache, including the writer's read-back validation.
 * Legacy names use a different lexer grammar and therefore a separate cache.
 */
export class ParsingContext {
  readonly pou = cachedParser(parsePou);
  readonly dataType = cachedParser(parseDataType);
  readonly configuration = cachedParser(parseConfiguration);
  private readonly contextSources = new Map<string, Program | DataTypeDeclaration | null>();

  context(sources: readonly string[]): (Program | DataTypeDeclaration)[] {
    return sources.flatMap((source) => {
      if (!this.contextSources.has(source))
        this.contextSources.set(source, this.pou(source).ast ?? this.dataType(source).ast);
      const ast = this.contextSources.get(source);
      return ast ? [ast] : [];
    });
  }
}

/** A stable lookup context can replace accepted sources without rewalking other POUs. */
export class ProgramContext {
  readonly lookup: NamespaceContext;

  constructor(
    private readonly parsing: ParsingContext,
    sources: readonly string[],
  ) {
    const asts = parsing.context(sources);
    this.lookup = new NamespaceContext([]);
    sources.forEach((source, index) => {
      this.lookup.replace(index, parsing.context([source])[0] ?? null);
    });
    resolveNamespaces(asts, undefined, this.lookup);
  }

  resolve(ast: Program): void {
    this.lookup.withSource(ast, () => resolveNamespaces([ast], undefined, this.lookup));
  }

  replace(index: number, source: string): void {
    const ast = this.parsing.context([source])[0] ?? null;
    if (ast) this.lookup.withSource(ast, () => resolveNamespaces([ast], undefined, this.lookup));
    // Replacements keep source positions, including holes left by legacy drafts.
    this.lookup.replace(index, ast);
  }
}
