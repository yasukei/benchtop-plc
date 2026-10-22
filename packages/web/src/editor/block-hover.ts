import { compileProject, lex, parsePou } from "@benchtop-plc/compiler";
import { spanRange } from "./mapping.js";

/** Resolve on demand from current editor texts, including uninstantiated user blocks. */
export function blockTypeAt(sources: readonly string[], sourceIndex: number, position: number) {
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
  const ast = parsePou(source).ast;
  if (!ast) return null;
  const ir = compileProject(sources).ir;
  if (!ir) return null;
  const variables =
    ast.kind === "program"
      ? ir.variables
      : ir.functionBlocks?.find((block) => block.name.toUpperCase() === ast.name.key)?.variables;
  const variable = variables?.find((item) => item.key === token.key);
  if (variable?.kind !== "functionBlock") return null;
  return { ...spanRange(source, token.span), text: `${token.text}: ${variable.fbType}` };
}
