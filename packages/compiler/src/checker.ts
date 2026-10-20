import {
  coerceValue,
  bitWidths,
  isBitType,
  isIntegerType,
  timeBinary,
  conversionFunctions,
  convertValue,
  standardFunctionBlocks as blocks,
  getStandardFunctionSignature as getSignature,
  isFunctionBlockType as isBlock,
  isStandardFunction as isFunction,
} from "@benchtop-plc/core";
import type {
  ConversionFunction,
  DataType,
  Diagnostic,
  DiagnosticArgs,
  DiagnosticCode,
  SourceSpan,
  StandardFunction,
} from "@benchtop-plc/core";
import type * as AST from "./ast.js";
import type {
  CheckedProgram,
  ExpressionInfo,
  ResolvedReference,
  VariableSymbol,
} from "./checked.js";
import {
  acceptsKind,
  defaultType,
  exactConstant,
  exactNumber,
  isUntyped,
  materialize,
  timeLiteral,
} from "./exact.js";
import { binaryConstant, unaryConstant, withConstant } from "./constants.js";
import {
  assignable,
  binaryType,
  isInteger,
  isNumeric,
  commonType,
  scalarTypes,
  unaryType,
} from "./type-rules.js";

export type CheckResult =
  | { checked: CheckedProgram; diagnostics: Diagnostic[] }
  | { checked: null; diagnostics: Diagnostic[] };
const isScalar = (name: string): name is DataType => scalarTypes.some((type) => type === name);

class Checker {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly symbols: VariableSymbol[] = [];
  private readonly names = new Map<string, VariableSymbol>();
  private readonly declaredNames = new Set<string>();
  private readonly expressions = new Map<AST.Expression, ExpressionInfo>();
  private readonly references = new Map<AST.Identifier, ResolvedReference>();
  private readonly functions = new Map<AST.FunctionCall, StandardFunction>();

  private report<C extends DiagnosticCode>(
    code: C,
    args: DiagnosticArgs[C],
    span: SourceSpan,
  ): void {
    // Generic indexed arguments retain correlation at callers; TS cannot distribute C here.
    this.diagnostics.push({ code, args, severity: "error", span } as Diagnostic);
  }

  run(ast: AST.Program): CheckResult {
    // Collect all declarations first so forward references receive ordinary type diagnostics.
    for (const declaration of ast.declarations) this.declare(declaration);
    for (const declaration of ast.declarations) this.initializer(declaration);
    this.statements(ast.body, 0);
    if (this.diagnostics.some((item) => item.severity === "error"))
      return { checked: null, diagnostics: this.diagnostics };
    return {
      checked: {
        ast,
        symbols: this.symbols,
        expressions: this.expressions,
        references: this.references,
        functions: this.functions,
      },
      diagnostics: this.diagnostics,
    };
  }

  private declare(declaration: AST.Declaration): void {
    const type = declaration.typeName.key;
    const known = isScalar(type) || isBlock(type);
    if (!known)
      this.report(
        "decl.unknown-type",
        { name: declaration.typeName.name },
        declaration.typeName.span,
      );
    if (declaration.address) {
      const address = declaration.address;
      if (declaration.names.length > 1) this.report("decl.at-multiple-names", {}, address.span);
      if (address.byte !== 0 || address.bit < 0 || address.bit > 7)
        this.report("decl.address-out-of-range", { address: address.text }, address.span);
      if (known && type !== "BOOL")
        this.report(
          "decl.direct-address-type",
          { name: declaration.names[0].name, type },
          address.span,
        );
    }
    for (const name of declaration.names) {
      const duplicate = this.declaredNames.has(name.key);
      this.declaredNames.add(name.key);
      if (isScalar(name.key) || isBlock(name.key)) {
        this.report("decl.name-collision", { name: name.name, kind: "type" }, name.span);
      } else if (isFunction(name.key)) {
        this.report("decl.name-collision", { name: name.name, kind: "function" }, name.span);
      } else if (duplicate) {
        this.report("decl.duplicate", { name: name.name }, name.span);
      } else if (known) {
        const symbol: VariableSymbol = {
          id: this.symbols.length,
          name,
          type,
          initialValue: isBlock(type) ? null : type === "BOOL" ? false : 0,
        };
        this.symbols.push(symbol);
        this.names.set(name.key, symbol);
        this.references.set(name, { variable: symbol.id });
      }
    }
  }

  private initializer(declaration: AST.Declaration): void {
    const value = declaration.initializer;
    if (!value) return;
    const type = declaration.typeName.key;
    if (isBlock(type)) {
      this.report("decl.fb-initializer", { name: declaration.names[0].name }, value.span);
      return;
    }
    const before = this.diagnostics.length;
    const info = this.expression(value, isScalar(type) ? type : undefined);
    if (!info || !isScalar(type)) return;
    if (!this.assignment(type, info, value.span)) return;
    if (info.constant === undefined) {
      if (!this.diagnostics.slice(before).some((item) => item.severity === "error"))
        this.report(
          "decl.nonconstant-initializer",
          { name: declaration.names[0].name },
          value.span,
        );
      return;
    }
    const initialValue = coerceValue(type, info.constant);
    for (const name of declaration.names) {
      const symbol = this.names.get(name.key);
      if (symbol?.name === name) symbol.initialValue = initialValue;
    }
  }

  private resolve(name: AST.Identifier): VariableSymbol | null {
    const symbol = this.names.get(name.key);
    if (!symbol) {
      this.report("name.undeclared", { name: name.name }, name.span);
      return null;
    }
    this.references.set(name, { variable: symbol.id });
    return symbol;
  }

  private reference(node: AST.AssignmentTarget, write = false): ExpressionInfo | null {
    const name = node.kind === "name" ? node.name : node.instance;
    const symbol = this.resolve(name);
    if (!symbol) return null;
    if (node.kind === "name") {
      if (!isScalar(symbol.type)) {
        this.report("fb.instance-as-value", { name: name.name }, node.span);
        return null;
      }
      return { dataType: symbol.type };
    }
    if (isScalar(symbol.type) && /^\d+$/.test(node.member.key)) {
      const bit = Number(node.member.key);
      if (!Number.isSafeInteger(bit)) {
        this.report("type.invalid-constant", {}, node.member.span);
        return null;
      }
      if (!isBitType(symbol.type) || symbol.type === "BOOL" || bit >= bitWidths[symbol.type]) {
        this.report("type.invalid-bit-access", { type: symbol.type, bit }, node.member.span);
        return null;
      }
      this.references.set(node.member, { variable: symbol.id, bit });
      return { dataType: "BOOL" };
    }
    if (!isBlock(symbol.type)) {
      this.report("fb.not-function-block", { name: name.name }, name.span);
      return null;
    }
    const descriptor = blocks[symbol.type];
    for (const port of ["inputs", "outputs"] as const) {
      const index = descriptor[port].findIndex(([key]) => key === node.member.key);
      if (index < 0) continue;
      if (write && port === "outputs")
        this.report(
          "fb.output-not-writable",
          { name: name.name, member: node.member.name },
          node.member.span,
        );
      this.references.set(node.member, {
        variable: symbol.id,
        port: port === "inputs" ? "input" : "output",
        member: index,
      });
      return { dataType: descriptor[port][index]![1] };
    }
    this.report(
      "fb.unknown-member",
      { name: name.name, member: node.member.name },
      node.member.span,
    );
    return null;
  }

  private expression(node: AST.Expression, expected?: DataType): ExpressionInfo | null {
    const cached = this.expressions.get(node);
    if (cached) return cached;
    let info: ExpressionInfo | null;
    if (isUntyped(node)) {
      try {
        const exact = exactConstant(node);
        const dataType = expected && acceptsKind(expected, exact) ? expected : defaultType(exact);
        info = { dataType, constant: materialize(exact, dataType), untyped: true };
        this.expressions.set(node, info);
        return info;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        this.report("type.invalid-constant", {}, node.span);
        return null;
      }
    }
    switch (node.kind) {
      case "literal": {
        const dataType = node.dataType ?? (node.literalKind === "boolean" ? "BOOL" : "TIME");
        try {
          const constant =
            node.literalKind === "time"
              ? timeLiteral(node.text)
              : node.literalKind === "boolean"
                ? coerceValue(dataType, node.value)
                : materialize(exactNumber(node.text.slice(node.text.indexOf("#") + 1)), dataType);
          info = { dataType, constant };
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          this.report("type.invalid-constant", {}, node.span);
          return null;
        }
        break;
      }
      case "name":
      case "member":
        info = this.reference(node);
        break;
      case "group":
        info = this.expression(node.expression);
        break;
      case "functionCall":
        info = this.functionCall(node);
        break;
      case "unary": {
        const operand = this.expression(node.operand);
        if (!operand) return null;
        const dataType = unaryType(node.operator, operand.dataType);
        if (!dataType) {
          this.report(
            "type.operand-mismatch",
            { operator: node.operator, left: operand.dataType, right: null },
            node.span,
          );
          return null;
        }
        info = this.constant(
          { dataType },
          node,
          operand.constant === undefined
            ? undefined
            : () => unaryConstant(node.operator, operand.constant!),
        );
        break;
      }
      case "binary": {
        const scaling = (node.operator === "*" || node.operator === "/") && !isUntyped(node.left);
        const values = this.operands([node.left, node.right], scaling);
        const [left, right] = values;
        if (!left || !right) return null;
        const dataType = binaryType(node.operator, left.dataType, right.dataType);
        if (!dataType) {
          this.report(
            "type.operand-mismatch",
            { operator: node.operator, left: left.dataType, right: right.dataType },
            node.span,
          );
          return null;
        }
        info = this.constant(
          { dataType },
          node,
          left.constant === undefined || right.constant === undefined
            ? undefined
            : () =>
                dataType === "TIME"
                  ? timeBinary(
                      node.operator as "+" | "-" | "*" | "/",
                      Number(left.constant!),
                      Number(right.constant!),
                      right.dataType,
                    )
                  : node.operator === "*" && isIntegerType(dataType)
                    ? Math.imul(Number(left.constant!), Number(right.constant!))
                    : binaryConstant(node.operator, left.constant!, right.constant!),
        );
        break;
      }
    }
    if (info) this.expressions.set(node, info);
    return info;
  }

  private constant(
    info: ExpressionInfo,
    node: AST.Expression,
    compute?: () => number | boolean,
  ): ExpressionInfo {
    if (!compute) return info;
    try {
      return withConstant(info, compute());
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.report("type.invalid-constant", {}, node.span);
      return info;
    }
  }

  /** Original typed neighbors supply a type only to whole untyped constants.
   * Defaults chosen for other constants never influence this contextual type. TIME scaling
   * has independent operand types, so its numeric factor uses the default. */
  private operands(nodes: AST.Expression[], independent = false): (ExpressionInfo | null)[] {
    const infos = nodes.map((node) => (isUntyped(node) ? null : this.expression(node)));
    const pending = new Set(nodes.flatMap((node, index) => (isUntyped(node) ? [index] : [])));
    independent = independent && infos[0]?.dataType === "TIME";
    const common = commonType(infos.filter((info) => info !== null).map((info) => info.dataType));
    for (const index of pending) {
      const node = nodes[index]!;
      let useDefault = independent || !common;
      try {
        useDefault ||= !acceptsKind(common!, exactConstant(node));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        useDefault = true;
      }
      if (useDefault) {
        infos[index] = this.expression(node);
        pending.delete(index);
      }
    }
    for (const index of pending) infos[index] = this.expression(nodes[index]!, common ?? undefined);
    return infos;
  }

  private functionCall(node: AST.FunctionCall): ExpressionInfo | null {
    const symbol = this.names.get(node.name.key);
    if (symbol && isBlock(symbol.type)) {
      this.report("fb.call-in-expression", { name: node.name.name }, node.span);
      return null;
    }
    if (!isFunction(node.name.key)) {
      node.args.forEach((arg) => this.expression(arg));
      this.report("call.unknown-function", { name: node.name.name }, node.name.span);
      return null;
    }
    const name = node.name.key;
    this.functions.set(node, name);
    const signature = getSignature(name);
    if (
      node.args.length < signature.min ||
      (signature.max !== null && node.args.length > signature.max)
    ) {
      this.report(
        "call.argument-count",
        { name: node.name.name, min: signature.min, max: signature.max, found: node.args.length },
        node.span,
      );
    }
    const args = signature.result
      ? node.args.map((arg, index) => {
          const types = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
          return this.expression(arg, types.length === 1 ? types[0] : undefined);
        })
      : name === "SEL"
        ? [
            node.args[0] ? this.expression(node.args[0], "BOOL") : null,
            ...this.operands(node.args.slice(1)),
          ]
        : this.operands(node.args);
    args.forEach((arg, index) => {
      if (!arg) return;
      const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
      // A fixed source parameter is a typed slot and accepts implicit widening.
      if (
        !expected.some((to) =>
          name.startsWith("TO_") ? to === arg.dataType : assignable(to, arg.dataType),
        )
      ) {
        if (expected.length === 1 && isNumeric(expected[0]!) && isNumeric(arg.dataType))
          this.assignment(expected[0]!, arg, node.args[index]!.span);
        else
          this.report(
            "call.argument-type",
            { name: node.name.name, index, expected, found: arg.dataType },
            node.args[index]!.span,
          );
      }
    });
    if (signature.result) {
      const arg = args[0];
      // Resolve overloaded conversions now, while the operand type is still available.
      const concrete = arg ? `${arg.dataType}_TO_${signature.result}` : name;
      const resolved =
        name.startsWith("TO_") && Object.hasOwn(conversionFunctions, concrete)
          ? (concrete as ConversionFunction)
          : (name as ConversionFunction);
      this.functions.set(node, resolved);
      if (
        resolved === "REAL_TO_DWORD" ||
        resolved === "DWORD_TO_REAL" ||
        ["BYTE_TO_BOOL", "WORD_TO_BOOL", "DWORD_TO_BOOL"].includes(resolved)
      ) {
        this.diagnostics.push({
          code: "type.portability",
          severity: "warning",
          args: { name },
          span: node.span,
        });
      }
      return this.constant(
        { dataType: signature.result },
        node,
        arg?.constant === undefined || node.args.length !== 1
          ? undefined
          : () => convertValue(resolved, arg.constant!),
      );
    }
    const values = (name === "SEL" ? args.slice(1) : args).filter((arg) => arg !== null);
    const dataType = commonType(values.map((arg) => arg.dataType));
    if (!dataType && values.length) {
      this.report(
        "call.argument-type",
        {
          name: node.name.name,
          index: name === "SEL" ? 2 : 1,
          expected: [values[0]!.dataType],
          found: values.at(-1)!.dataType,
        },
        node.span,
      );
    }
    return dataType ? { dataType } : null;
  }

  private assignment(to: DataType, info: ExpressionInfo, span: SourceSpan): boolean {
    const from = info.dataType;
    if (!assignable(to, from)) {
      this.report(
        "type.assign-mismatch",
        {
          from,
          to,
          ...(Object.hasOwn(conversionFunctions, `${from}_TO_${to}`)
            ? { hint: "explicit-conversion" as const }
            : {}),
        },
        span,
      );
      return false;
    }
    if (info.constant !== undefined) {
      try {
        coerceValue(to, info.constant);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        this.report("type.invalid-constant", {}, span);
        return false;
      }
    }
    return true;
  }

  private condition(
    node: AST.Expression,
    statement: DiagnosticArgs["type.condition-not-bool"]["statement"],
  ): void {
    const info = this.expression(node, "BOOL");
    if (info && info.dataType !== "BOOL")
      this.report("type.condition-not-bool", { statement }, node.span);
  }

  private statements(statements: AST.Statement[], depth: number): void {
    for (const node of statements) {
      switch (node.kind) {
        case "assignment": {
          const target = this.reference(node.target, true),
            value = this.expression(node.value, target?.dataType);
          if (target) this.expressions.set(node.target, target);
          if (target && value) this.assignment(target.dataType, value, node.value.span);
          break;
        }
        case "fbCall": {
          const symbol = this.resolve(node.instance);
          if (symbol && !isBlock(symbol.type))
            this.report("fb.not-function-block", { name: node.instance.name }, node.instance.span);
          const seen = new Set<string>();
          for (const input of node.inputs) {
            const reference: AST.MemberReference = {
              kind: "member",
              instance: node.instance,
              member: input.name,
              span: input.span,
            };
            const target = symbol && isBlock(symbol.type) ? this.reference(reference, true) : null;
            const value = this.expression(input.value, target?.dataType);
            if (seen.has(input.name.key))
              this.report(
                "fb.duplicate-input",
                { name: node.instance.name, member: input.name.name },
                input.name.span,
              );
            seen.add(input.name.key);
            if (target && value) this.assignment(target.dataType, value, input.value.span);
          }
          break;
        }
        case "if":
          node.branches.forEach((branch, index) => {
            this.condition(branch.condition, index === 0 ? "IF" : "ELSIF");
            this.statements(branch.body, depth);
          });
          this.statements(node.elseBody, depth);
          break;
        case "case": {
          const selector = this.expression(node.selector);
          if (selector && !isInteger(selector.dataType))
            this.report(
              "type.case-selector-not-integer",
              { type: selector.dataType },
              node.selector.span,
            );
          for (const branch of node.branches) {
            for (const label of branch.labels)
              for (const value of label.kind === "value"
                ? [label.value]
                : [label.lower, label.upper]) {
                const info = this.expression(value, selector?.dataType);
                if (!info) continue;
                if (!isInteger(info.dataType))
                  this.report("type.case-label-not-integer", { type: info.dataType }, value.span);
                else {
                  if (selector && isInteger(selector.dataType))
                    this.assignment(selector.dataType, info, value.span);
                  if (info.constant === undefined)
                    this.report("type.case-label-not-constant", {}, value.span);
                }
              }
            this.statements(branch.body, depth);
          }
          this.statements(node.elseBody, depth);
          break;
        }
        case "for": {
          const symbol = this.resolve(node.variable);
          if (symbol) {
            if (isBlock(symbol.type))
              this.report("fb.instance-as-value", { name: node.variable.name }, node.variable.span);
            else if (!isInteger(symbol.type))
              this.report(
                "type.for-variable-not-integer",
                { name: node.variable.name, type: symbol.type },
                node.variable.span,
              );
          }
          for (const bound of ["from", "to", "step"] as const) {
            const value = node[bound];
            if (!value) continue;
            const type =
              symbol && isScalar(symbol.type) && isInteger(symbol.type) ? symbol.type : undefined;
            const info = this.expression(value, type);
            if (info && type && isInteger(info.dataType)) this.assignment(type, info, value.span);
            if (info && !isInteger(info.dataType))
              this.report("type.for-bound-not-integer", { bound, type: info.dataType }, value.span);
          }
          this.statements(node.body, depth + 1);
          break;
        }
        case "while":
          this.condition(node.condition, "WHILE");
          this.statements(node.body, depth + 1);
          break;
        case "repeat":
          this.statements(node.body, depth + 1);
          this.condition(node.until, "REPEAT");
          break;
        case "exit":
          if (depth === 0) this.report("flow.exit-outside-loop", {}, node.span);
          break;
        case "return":
          break;
      }
    }
  }
}

/** Check a parsed AST. No checked result is exposed when any semantic rule fails. */
export function check(ast: AST.Program): CheckResult {
  return new Checker().run(ast);
}
