import type { Diagnostic, TypeDescriptor } from "@benchtop-plc/core";
import { arrayType, interfaceType, isAggregateType } from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import type { CheckedProgram, ExpressionInfo } from "../checked.js";

import { assignment } from "./assignment.js";
import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { declare } from "./declarations.js";
import { aggregateInitial, initializer } from "./initializers.js";
import { selectBlockVariants } from "./overloads.js";
import { checkReference } from "./references.js";
import { checkStatements } from "./statements.js";
import { baseType, declarationType, hasOpenDimensions, isScalar } from "./type-identity.js";
import { defaultValue, resolveDescriptor } from "./types.js";

import { declarationContext, type CheckResult } from "./context.js";

export interface DeclarationPhase {
  context: CheckerContext;
  memberCount: number;
}
export interface InitializerPhase extends DeclarationPhase {
  initialized: true;
}

function collectMembers(ctx: CheckerContext): number {
  const ast = ctx.ast;
  const owner = ast.owner;
  let memberCount = 0;
  if (owner) {
    const members =
      ctx.interfaces.get(owner) ??
      ctx.rules.declarations({ ...ctx, ast: owner, interfaces: new Map() }).checked;
    if (members) {
      for (const symbol of members.symbols) {
        const member = { ...symbol };
        ctx.symbols.push(member);
        ctx.names.set(member.name.key, member);
      }
      for (const [key, constant] of members.constants) ctx.constants.set(key, constant);
    }
    memberCount = ctx.symbols.length;
    for (const declaration of ast.declarations)
      for (const name of declaration.names)
        if (
          owner.declarations.some((d) => d.names.some((n) => n.key === name.key)) ||
          owner.methods?.some((m) => m.name.key === name.key)
        )
          report(ctx, "method.name-collision", { name: name.name }, name.span);
  }
  return memberCount;
}

function checkMethodNames(ctx: CheckerContext): void {
  const ast = ctx.ast;
  if (ast.methods) {
    const names = new Set(ast.declarations.flatMap((d) => d.names.map((n) => n.key)));
    for (const method of ast.methods) {
      if (method.owner && method.owner !== ast) continue;
      if (names.has(method.name.key))
        report(ctx, "method.name-collision", { name: method.name.name }, method.name.span);
      names.add(method.name.key);
    }
  }
}

function checkSections(ctx: CheckerContext): void {
  const ast = ctx.ast;
  const interfaceSection = (ctx: CheckerContext, name: string): boolean => {
    const declarations = ast.declarations.filter((d) => d.section === name);
    const interfaceStorage = (type: TypeDescriptor): boolean =>
      !!interfaceType(type, ctx.types) ||
      !!(arrayType(type, ctx.types) && interfaceStorage(arrayType(type, ctx.types)!.element));
    return (
      declarations.length > 0 &&
      declarations.every((d) => {
        const type = resolveDescriptor(
          ctx,
          d.typeName,
          d.subrange,
          d.stringLength,
          d.array,
          d.reference,
        );
        return !!type && interfaceStorage(type);
      })
    );
  };
  for (const section of ast.sections ?? []) {
    const scoped = declarationContext(ctx, section.declaringType);
    if (section.retain || section.nonRetain) {
      if (section.retain && section.nonRetain)
        report(scoped, "decl.retention-conflict", {}, section.span);
      if (["VAR_TEMP", "VAR_IN_OUT", "VAR_EXTERNAL"].includes(section.name))
        report(scoped, "decl.retention-section", {}, section.span);
      if (ast.kind === "function") report(scoped, "decl.retention-function", {}, section.span);
      if (section.constant) report(scoped, "decl.retention-constant", {}, section.span);
    }
    if (section.constant && section.name !== "VAR" && section.name !== "VAR_EXTERNAL")
      report(scoped, "decl.constant-section", { section: section.name }, section.span);
    if (
      (ast.kind === "program" &&
        section.name !== "VAR" &&
        section.name !== "VAR_TEMP" &&
        section.name !== "VAR_EXTERNAL" &&
        section.name !== "VAR_INPUT" &&
        section.name !== "VAR_OUTPUT" &&
        !(section.name === "VAR_IN_OUT" && interfaceSection(scoped, "VAR_IN_OUT"))) ||
      (ast.kind === "function" &&
        ["VAR_TEMP", "VAR_EXTERNAL"].includes(section.name) &&
        !(section.name === "VAR_TEMP" && interfaceSection(scoped, "VAR_TEMP"))) ||
      (ast.kind === "class" && !["VAR", "VAR_EXTERNAL"].includes(section.name))
    )
      report(
        scoped,
        "pou.invalid-section",
        { section: section.name, kind: ast.kind },
        section.span,
      );
  }
}

function declareResult(ctx: CheckerContext): void {
  const ast = ctx.ast;
  if (hasOpenDimensions(ast.resultArray))
    report(ctx, "decl.open-array-section", {}, ast.resultArray!.span);
  if (ast.resultType) {
    const descriptor = resolveDescriptor(
      ctx,
      ast.resultType,
      ast.resultSubrange,
      ast.resultStringLength,
      ast.resultArray,
      ast.resultReference,
    );
    const type = descriptor
      ? baseType(ctx, descriptor, ctx.types)
      : declarationType(ast.resultType.key);
    if (!isScalar(type)) {
      if (!ctx.failedReferenceTypes.has(ast.resultType))
        report(ctx, "decl.unknown-type", { name: ast.resultType.name }, ast.resultType.span);
    } else {
      ctx.state.result = {
        id: ctx.symbols.length,
        name: ast.simpleName ?? ast.name,
        type,
        descriptor,
        initialValue: defaultValue(ctx, descriptor!),
      };
      ctx.symbols.push(ctx.state.result);
      ctx.names.set((ast.simpleName ?? ast.name).key, ctx.state.result);
    }
  }
}

/** Collect names before resolving initializers, including forward references. */
export function collectDeclarations(ctx: CheckerContext): DeclarationPhase {
  const memberCount = collectMembers(ctx);
  checkMethodNames(ctx);
  checkSections(ctx);
  for (const declaration of ctx.ast.declarations)
    declare(declarationContext(ctx, declaration.declaringType), declaration);
  declareResult(ctx);
  ctx.state.collectingDeclarations = false;
  return { context: ctx, memberCount };
}

/** Initializers resolve bounds/defaults in source order and in their declaring scope. */
export function initializeDeclarations(declarations: DeclarationPhase): InitializerPhase {
  const ctx = declarations.context;
  const ast = ctx.ast;
  for (const declaration of ast.declarations) {
    initializer(declarationContext(ctx, declaration.declaringType, true), declaration);
    for (const name of declaration.names) {
      const constant = ctx.constants.get(name.key);
      if (constant?.name === name) constant.initializerProcessed = true;
    }
  }
  if (ctx.state.result && ast.resultType) {
    const descriptor = resolveDescriptor(
      ctx,
      ast.resultType,
      ast.resultSubrange,
      ast.resultStringLength,
      ast.resultArray,
      ast.resultReference,
    );
    if (descriptor) {
      ctx.state.result.descriptor = descriptor;
      ctx.state.result.initialValue = defaultValue(ctx, descriptor);
      if (isAggregateType(descriptor, ctx.types))
        ctx.state.result.aggregateValues = aggregateInitial(ctx, descriptor);
    }
  }
  return { ...declarations, initialized: true };
}

export function checkBody(declarations: InitializerPhase): void {
  const ctx = declarations.context;
  const ast = ctx.ast;
  selectBlockVariants(ctx);
  checkStatements(ctx, ast.body, 0);
  if (
    ctx.state.result &&
    !ast.abstract &&
    !ctx.state.resultMayBeAssigned &&
    !ctx.diagnostics.some((item) => item.severity === "error")
  )
    report(ctx, "pou.result-not-assigned", { name: ast.name.name }, ast.name.span);
}

export function finishCheck(declarations: InitializerPhase): CheckResult {
  const { context: ctx, memberCount } = declarations;
  const ast = ctx.ast;
  if (
    ctx.state.inheritedDeclarationError ||
    ctx.diagnostics.some((item) => item.severity === "error")
  )
    return { checked: null, diagnostics: ctx.diagnostics };
  return {
    checked: {
      ast,
      superCalls: ctx.superCalls,
      ...(ctx.ast.owner ? { memberCount } : {}),
      types: ctx.types,
      symbols: ctx.symbols,
      constants: ctx.constants,
      expressions: ctx.expressions,
      references: ctx.references,
      arrayBounds: ctx.arrayBounds,
      functions: ctx.functions,
      functionArguments: ctx.functionArguments,
      userCalls: ctx.userCalls,
      blockInputTypes: ctx.blockInputTypes,
      blockCalls: ctx.blockCalls,
      blockInOuts: ctx.blockInOuts,
      ...(ctx.state.result ? { result: ctx.state.result } : {}),
    },
    diagnostics: ctx.diagnostics,
  };
}

export function connection(
  ctx: CheckerContext,
  scope: CheckedProgram,
  type: TypeDescriptor,
  value: AST.Expression,
  output: boolean,
): { info?: ExpressionInfo; diagnostics: Diagnostic[] } {
  for (const symbol of scope.symbols) ctx.names.set(symbol.name.key, symbol);
  for (const [key, constant] of scope.constants) ctx.constants.set(key, constant);
  let info: ExpressionInfo | null;
  if (output) {
    info = checkReference(ctx, value as AST.AssignmentTarget, true);
    if (info)
      assignment(
        ctx,
        info.descriptor ?? info.dataType,
        { dataType: baseType(ctx, type, ctx.types), descriptor: type },
        value.span,
      );
  } else {
    info = ctx.rules.expression(ctx, value, type);
    if (info) assignment(ctx, type, info, value.span);
  }
  return { ...(info ? { info } : {}), diagnostics: ctx.diagnostics };
}
