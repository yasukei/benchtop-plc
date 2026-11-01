import type { DataType } from "@benchtop-plc/core";
import { arrayType } from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import { rootName } from "../ast.js";
import type { VariableSymbol } from "../checked.js";
import { isUntyped } from "../exact.js";
import {
  blockVariant,
  readsInferredMember,
  selectingPort,
  visitBlockBindings,
} from "../overloaded-blocks.js";

import type { CheckerContext } from "./context.js";
import { report } from "./context.js";

export function selectBlockVariants(ctx: CheckerContext): void {
  const instances = new Map(
    ctx.symbols
      .filter((symbol) => selectingPort(symbol.type))
      .map((symbol) => [symbol.name.key, symbol]),
  );
  if (!instances.size) return;
  const inferred = new Set(instances.keys());
  // Isolate speculative expression checking: no cached types, references or diagnostics
  // may leak into the ordinary check against the final variants.
  const probe = ctx.rules.createContext({ ...ctx, interfaces: new Map(), globals: undefined });
  for (const [key, symbol] of ctx.names) probe.names.set(key, symbol);
  for (const [key, constant] of ctx.constants) probe.constants.set(key, constant);
  const bindings = new Map<VariableSymbol, DataType[]>();
  visitBlockBindings(ctx.ast.body, (name, port, value) => {
    const symbol = instances.get(name);
    if (
      !symbol ||
      port !== selectingPort(symbol.type) ||
      isUntyped(value) ||
      readsInferredMember(value, inferred)
    )
      return;
    const info = probe.rules.expression(probe, value);
    if (!info) return;
    const types = bindings.get(symbol) ?? [];
    types.push(info.dataType);
    bindings.set(symbol, types);
  });
  // Resolve only after collecting every selecting type, independently of source order.
  for (const symbol of instances.values()) {
    let types = bindings.get(symbol) ?? [];
    if (symbol.external && ctx.globals) {
      const shared = ctx.globals.bindings.get(symbol.external) ?? [];
      types = [...new Set([...shared, ...types])];
      ctx.globals.bindings.set(symbol.external, types);
    }
    const owner =
      ctx.ast.owner ?? (["functionBlock", "class"].includes(ctx.ast.kind) ? ctx.ast : undefined);
    if (owner && !symbol.external && ctx.globals?.memberBindings) {
      const key = `${owner.name.key}.${symbol.name.key}`;
      types = [...new Set([...(ctx.globals.memberBindings.get(key) ?? []), ...types])];
      ctx.globals.memberBindings.set(key, types);
    }
    if (!types.length) continue;
    const variant = blockVariant(symbol.type, types);
    if (variant) {
      symbol.type = variant;
      const array = symbol.descriptor && arrayType(symbol.descriptor, ctx.types);
      if (array)
        symbol.descriptor = { ...array, element: { kind: "functionBlock", name: variant } };
    } else {
      ctx.failedBlockSelections.add(symbol.name.key);
      report(ctx, "fb.no-matching-variant", { name: symbol.name.name, types }, symbol.name.span);
    }
  }
}

export function failedPreset(ctx: CheckerContext, target: AST.AssignmentTarget): boolean {
  return (
    (target.kind === "member" || target.kind === "field") &&
    ctx.failedBlockSelections.has(rootName(target).key) &&
    ["PT", "PV"].includes(target.member.key)
  );
}
