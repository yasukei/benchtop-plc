import type { Diagnostic, TypeDescriptor, TypeTable } from "@benchtop-plc/core";
import type * as AST from "./ast.js";
import type { CheckedProgram, GlobalScope } from "./checked.js";
import { CheckerContext, type CheckerInputs, type CheckResult } from "./checker/context.js";
import { expression } from "./checker/expressions.js";
import { functionCall } from "./checker/calls.js";
import {
  collectDeclarations,
  initializeDeclarations,
  checkBody,
  finishCheck,
  connection,
} from "./checker/phases.js";
import { selectBlockVariants } from "./checker/overloads.js";

export type { CheckResult } from "./checker/context.js";
export { declarationType } from "./checker/type-identity.js";

function createContext(inputs: CheckerInputs): CheckerContext {
  return new CheckerContext(inputs, { expression, functionCall, createContext, declarations });
}

function declarations(inputs: CheckerInputs): CheckResult {
  return finishCheck(initializeDeclarations(collectDeclarations(createContext(inputs))));
}

/** Check a parsed AST. No checked result is exposed when any semantic rule fails. */
export function check(
  ast: AST.Program,
  pous: ReadonlyMap<string, AST.Program> = new Map([[ast.name.key, ast]]),
  functionIds: ReadonlyMap<string, number> = new Map(),
  blockIds: ReadonlyMap<string, number> = new Map(),
  types: TypeTable = [],
  interfaces: ReadonlyMap<AST.Program, CheckedProgram> = new Map(),
  globals?: GlobalScope,
): CheckResult {
  const ctx = createContext({ ast, pous, functionIds, blockIds, types, interfaces, globals });
  const initialized = initializeDeclarations(collectDeclarations(ctx));
  checkBody(initialized);
  return finishCheck(initialized);
}

/** Resolve POU signatures in their own constant scope before checking call sites. */
export function checkDeclarations(
  ast: AST.Program,
  types: TypeTable,
  pous: ReadonlyMap<string, AST.Program>,
  blockIds: ReadonlyMap<string, number>,
  globals?: GlobalScope,
): CheckResult {
  return declarations({
    ast,
    pous,
    functionIds: new Map(),
    blockIds,
    types,
    interfaces: new Map(),
    globals,
  });
}

/** Discover shared selecting types without checking statements or exposing speculative diagnostics. */
export function discoverOverloadBindings(
  ast: AST.Program,
  pous: ReadonlyMap<string, AST.Program>,
  functionIds: ReadonlyMap<string, number>,
  blockIds: ReadonlyMap<string, number>,
  types: TypeTable,
  interfaces: ReadonlyMap<AST.Program, CheckedProgram>,
  globals: GlobalScope,
): Pick<GlobalScope, "bindings" | "memberBindings"> {
  const scope = {
    ...globals,
    bindings: new Map(globals.bindings),
    ...(globals.memberBindings ? { memberBindings: new Map(globals.memberBindings) } : {}),
  };
  const ctx = createContext({
    ast,
    pous,
    functionIds,
    blockIds,
    types,
    interfaces,
    globals: scope,
  });
  const initialized = initializeDeclarations(collectDeclarations(ctx));
  selectBlockVariants(initialized.context);
  return { bindings: scope.bindings, memberBindings: scope.memberBindings };
}

/** Use the ordinary assignment rules in the configuration's global/constant scope. */
export function checkConnection(
  globals: CheckedProgram,
  type: TypeDescriptor,
  value: AST.Expression,
  output: boolean,
): { info?: import("./checked.js").ExpressionInfo; diagnostics: Diagnostic[] } {
  return connection(
    createContext({
      ast: globals.ast,
      pous: new Map(),
      functionIds: new Map(),
      blockIds: new Map(),
      types: globals.types,
      interfaces: new Map(),
    }),
    globals,
    type,
    value,
    output,
  );
}
