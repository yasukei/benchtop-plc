import { arrayType } from "@benchtop-plc/core";
import type * as AST from "../ast.js";
import type { UserCallInfo } from "../checked.js";
import { isConstantDeclaration } from "../constants.js";

import { assignment } from "./assignment.js";
import type { CheckerContext } from "./context.js";
import { report } from "./context.js";
import { failedPreset } from "./overloads.js";
import { blockMember, checkReference, resolve } from "./references.js";
import { isScalar } from "./type-identity.js";
import { parameterType } from "./types.js";
import { inOutActual, requireInOuts } from "./user-calls.js";

export function superBodyCall(
  ctx: CheckerContext,
  node: AST.FunctionCall | AST.FunctionBlockCall,
): void {
  if (
    ctx.ast.kind !== "functionBlock" ||
    ctx.ast.owner ||
    !ctx.ast.baseType ||
    (node.kind === "fbCall" ? node.inputs.length : node.args.length || node.outputs?.length)
  ) {
    report(ctx, "inheritance.super-body", {}, node.span);
    return;
  }
  ctx.superCalls.set(node, ctx.blockIds.get(ctx.ast.baseType.name.key)!);
}

export function blockCall(ctx: CheckerContext, node: AST.FunctionCall): void {
  let symbol = resolve(ctx, node.name);
  if (!symbol) return;
  if (isScalar(symbol.type) && node.instance?.kind !== "dereference") {
    report(ctx, "fb.not-function-block", { name: node.name.name }, node.name.span);
    return;
  }
  if (node.instance) {
    const info = checkReference(ctx, node.instance, false, true);
    if (!info) return;
    ctx.expressions.set(node.instance, info);
    if (typeof info.descriptor === "string" || info.descriptor?.kind !== "functionBlock") {
      report(ctx, "fb.not-function-block", { name: node.name.name }, node.span);
      return;
    }
    symbol = {
      ...symbol,
      type: info.descriptor.name,
      descriptor: undefined,
      userBlock: info.descriptor.block,
    };
  } else if (symbol.descriptor && arrayType(symbol.descriptor, ctx.types)) {
    report(ctx, "fb.not-function-block", { name: node.name.name }, node.span);
    return;
  }
  if (ctx.pous.get(symbol.type)?.kind === "class") {
    report(ctx, "class.not-callable", { name: node.name.name }, node.span);
    return;
  }
  if (ctx.ast.kind === "function" && !ctx.ast.owner && node.instance?.kind !== "dereference")
    report(ctx, "pou.function-block-in-function", {}, node.span);
  if (node.args.length && !node.inputNames) {
    report(ctx, "fb.unsupported-call", { name: node.name.name }, node.span);
    return;
  }
  if (symbol.userBlock !== undefined) ctx.blockCalls.set(node, symbol.userBlock);
  const inOuts =
    symbol.userBlock === undefined
      ? []
      : ctx.pous
          .get(symbol.type)!
          .declarations.filter((declaration) => !isConstantDeclaration(declaration))
          .flatMap((declaration) => declaration.names.map((name) => ({ name, declaration })))
          .map((parameter, variable) => ({ ...parameter, variable }))
          .filter(({ declaration }) => declaration.section === "VAR_IN_OUT");
  const bindings: UserCallInfo["inOuts"] = [];
  ctx.blockInOuts.set(node, bindings);
  const seen = new Set<string>();
  node.args.forEach((value, index) => {
    const name = node.inputNames![index]!;
    const inOut = inOuts.find((parameter) => parameter.name.key === name.key);
    if (inOut) {
      if (seen.has(name.key))
        report(ctx, "fb.duplicate-input", { name: node.name.name, member: name.name }, name.span);
      seen.add(name.key);
      const type = parameterType(ctx, ctx.pous.get(symbol.type)!, inOut.declaration);
      if (type && inOutActual(ctx, value, type))
        bindings.push({ variable: inOut.variable, actual: value });
      return;
    }
    const member: AST.MemberReference = {
      kind: "member",
      instance: node.name,
      member: name,
      span: name.span,
    };
    const target = blockMember(ctx, symbol, name, true);
    const failed = failedPreset(ctx, member);
    const info = ctx.rules.expression(
      ctx,
      value,
      failed ? undefined : (target?.descriptor ?? target?.dataType),
    );
    if (target) ctx.blockInputTypes.set(name, target.dataType);
    if (seen.has(name.key))
      report(ctx, "fb.duplicate-input", { name: node.name.name, member: name.name }, name.span);
    seen.add(name.key);
    if (target && info && !failed)
      assignment(ctx, target.descriptor ?? target.dataType, info, value.span);
  });
  requireInOuts(ctx, inOuts, seen, node);
  for (const output of node.outputs ?? []) {
    const source = blockMember(ctx, symbol, output.name, false);
    const reference = ctx.references.get(output.name);
    if ((reference && reference.port !== "output") || seen.has(output.name.key))
      report(
        ctx,
        "call.invalid-parameter",
        { name: node.name.name, parameter: output.name.name },
        output.name.span,
      );
    seen.add(output.name.key);
    const target = checkReference(ctx, output.target, true);
    if (target) ctx.expressions.set(output.target, target);
    if (source && target)
      assignment(ctx, target.descriptor ?? target.dataType, source, output.target.span);
  }
}
