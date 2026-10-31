import { formatType, type ConfigurationIR } from "@benchtop-plc/core";
import { lex, parseConfiguration, parsePou } from "@benchtop-plc/compiler";
import { spanRange } from "./mapping.js";

/** Resolve types from the current editor compilation, including uninstantiated user blocks. */
export function blockTypeAt(source: string, position: number, ir?: ConfigurationIR) {
  if (!ir) return null;
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
  const configuration =
    tokens?.[0]?.key === "CONFIGURATION" ? parseConfiguration(source).ast : undefined;
  const ast = configuration ? undefined : parsePou(source).ast;
  if (!ast && !configuration) return null;
  const declarations = configuration
    ? [...configuration.globals, ...configuration.resourceGlobals]
    : ast!.declarations;
  const declaration = declarations.find((declaration) =>
    declaration.names.some((name) => name.key === token.key),
  );
  if (!declaration) return null;
  const external = declaration.section === "VAR_EXTERNAL";
  const variables =
    !ast || ast.kind === "program" || external
      ? ir.variables
      : ir.functionBlocks?.find((block) => block.name.toUpperCase() === ast.name.key)?.variables;
  const instance =
    ast &&
    ir.resource.programs.find(
      (instance) => ir.programs[instance.program]!.name.toUpperCase() === ast.name.key,
    );
  const qualified =
    ast?.kind === "program" && instance && !external
      ? `${instance.name.toUpperCase()}.${token.key}`
      : token.key;
  const variable = variables?.find((item) => item.key === qualified);
  if (declaration.array) {
    const composite = ir.composites?.find((item) => item.name.toUpperCase() === qualified);
    const dataType = variable?.kind === "array" ? variable.dataType : composite?.dataType;
    return {
      ...spanRange(source, token.span),
      text: `${token.text}: ${dataType ? formatType(dataType) : source.slice(spanRange(source, declaration.array.span).from, spanRange(source, declaration.array.span).to)}`,
    };
  }
  const typeRange = spanRange(source, declaration.typeName.span);
  const end = declaration.reference
    ? spanRange(source, declaration.reference.span).to
    : declaration.subrange
      ? spanRange(source, declaration.subrange.span).to
      : typeRange.to;
  const type =
    variable?.kind === "functionBlock" ? variable.fbType : source.slice(typeRange.from, end);
  return { ...spanRange(source, token.span), text: `${token.text}: ${type}` };
}
