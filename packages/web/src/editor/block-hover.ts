import { formatType } from "@benchtop-plc/core";
import { compileProject, lex, parsePou } from "@benchtop-plc/compiler";
import { spanRange } from "./mapping.js";

/** Resolve on demand from current editor texts, including uninstantiated user blocks. */
export function blockTypeAt(
  sources: readonly string[],
  sourceIndex: number,
  position: number,
  dataTypes: readonly string[] = [],
) {
  const source = sources[sourceIndex];
  if (source === undefined) return null;
  const tokens = lex(source).tokens;
  const index =
    tokens?.findIndex((token) => {
      const range = spanRange(source, token.span);
      return position >= range.from && position < range.to;
    }) ?? -1;
  const token = tokens?.[index];
  if (token?.kind !== "identifier" || tokens?.[index - 1]?.key === ".") return null;
  const previous = tokens?.[index - 1]?.key;
  const next = tokens?.[index + 1]?.key;
  if ((previous === "(" || previous === ",") && (next === ":=" || next === "=>")) return null;
  const ast = parsePou(source).ast;
  if (!ast) return null;
  const ir = compileProject(sources, dataTypes).ir;
  if (!ir) return null;
  const variables =
    ast.kind === "program"
      ? ir.variables
      : ir.functionBlocks?.find((block) => block.name.toUpperCase() === ast.name.key)?.variables;
  const variable = variables?.find((item) => item.key === token.key);
  const declaration = ast.declarations.find((declaration) =>
    declaration.names.some((name) => name.key === token.key),
  );
  if (!declaration) return null;
  if (declaration.array) {
    const composite = ir.composites?.find((item) => item.name === token.key);
    return {
      ...spanRange(source, token.span),
      text: `${token.text}: ${composite ? formatType(composite.dataType) : source.slice(spanRange(source, declaration.array.span).from, spanRange(source, declaration.array.span).to)}`,
    };
  }
  const typeRange = spanRange(source, declaration.typeName.span);
  const end = declaration.subrange ? spanRange(source, declaration.subrange.span).to : typeRange.to;
  const type =
    variable?.kind === "functionBlock" ? variable.fbType : source.slice(typeRange.from, end);
  return { ...spanRange(source, token.span), text: `${token.text}: ${type}` };
}
