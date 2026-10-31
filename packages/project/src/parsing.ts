import {
  parsePou,
  parseConfiguration,
  parseDataType,
  type DataTypeDeclaration,
  type Program,
} from "@benchtop-plc/compiler";

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
