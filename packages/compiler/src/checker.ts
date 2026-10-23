import {
  coerceValue,
  scalarBase,
  enumerationType,
  subrangeType,
  sameScalarType,
  typeEntry,
  validateDeclaredValue,
  validateValue,
  isCalendarType,
  parseCalendar,
  calendarBinary,
  isLongType,
  ltimeBinary,
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
  CalendarType,
  TypeDescriptor,
  TypeTable,
  ConversionFunction,
  DataType,
  Diagnostic,
  DiagnosticArgs,
  DiagnosticCode,
  SourceSpan,
  ScalarValue,
  StandardFunction,
} from "@benchtop-plc/core";
import type * as AST from "./ast.js";
import type {
  CheckedProgram,
  ExpressionInfo,
  ResolvedReference,
  VariableSymbol,
  UserCallInfo,
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
  blockVariant,
  readsInferredMember,
  selectingPort,
  visitBlockBindings,
} from "./overloaded-blocks.js";
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
export const declarationType = (name: string): string =>
  (
    ({
      TIME_OF_DAY: "TOD",
      DATE_AND_TIME: "DT",
      LTIME_OF_DAY: "LTOD",
      LDATE_AND_TIME: "LDT",
    }) as Record<string, string>
  )[name] ?? name;
const isScalar = (name: string): name is DataType => scalarTypes.some((type) => type === name);

class Checker {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly symbols: VariableSymbol[] = [];
  private readonly names = new Map<string, VariableSymbol>();
  private readonly constants = new Map<
    string,
    {
      name: AST.Identifier;
      type: DataType;
      descriptor?: TypeDescriptor;
      initializerProcessed: boolean;
      value?: ScalarValue;
    }
  >();
  private readonly declaredNames = new Set<string>();
  private readonly expressions = new Map<AST.Expression, ExpressionInfo>();
  private readonly references = new Map<AST.Identifier, ResolvedReference>();
  private readonly functionArguments = new Map<AST.FunctionCall, readonly AST.Expression[]>();
  private readonly functions = new Map<AST.FunctionCall, StandardFunction>();
  private readonly blockInOuts = new Map<
    AST.FunctionCall | AST.FunctionBlockCall,
    UserCallInfo["inOuts"]
  >();
  private readonly userCalls = new Map<AST.FunctionCall | AST.FunctionBlockCall, UserCallInfo>();
  private readonly blockInputTypes = new Map<AST.Identifier, DataType>();
  private readonly failedBlockSelections = new Set<string>();
  private result?: VariableSymbol;
  private collectingDeclarations = true;

  constructor(
    private readonly ast: AST.Program,
    private readonly pous: ReadonlyMap<string, AST.Program>,
    private readonly functionIds: ReadonlyMap<string, number>,
    private readonly blockIds: ReadonlyMap<string, number>,
    private readonly types: TypeTable,
    private readonly interfaces: ReadonlyMap<AST.Program, CheckedProgram> = new Map(),
  ) {}

  private report<C extends DiagnosticCode>(
    code: C,
    args: DiagnosticArgs[C],
    span: SourceSpan,
  ): void {
    // Generic indexed arguments retain correlation at callers; TS cannot distribute C here.
    this.diagnostics.push({
      code,
      args,
      severity: "error",
      span,
      pou: this.ast.name.name,
    } as Diagnostic);
  }

  run(ast: AST.Program, declarationsOnly = false): CheckResult {
    for (const section of ast.sections ?? []) {
      if (section.constant && section.name !== "VAR")
        this.report("decl.constant-section", { section: section.name }, section.span);
      if (
        (ast.kind === "program" && section.name !== "VAR" && section.name !== "VAR_TEMP") ||
        (ast.kind === "function" && section.name === "VAR_TEMP")
      )
        this.report("pou.invalid-section", { section: section.name, kind: ast.kind }, section.span);
    }
    // Collect all declarations first so forward references receive ordinary type diagnostics.
    for (const declaration of ast.declarations) this.declare(declaration);
    if (ast.resultType) {
      const descriptor = this.descriptor(ast.resultType, ast.resultSubrange);
      const type = descriptor
        ? scalarBase(descriptor, this.types)
        : declarationType(ast.resultType.key);
      if (!isScalar(type))
        this.report("decl.unknown-type", { name: ast.resultType.name }, ast.resultType.span);
      else {
        this.result = {
          id: this.symbols.length,
          name: ast.name,
          type,
          descriptor,
          initialValue: this.defaultValue(descriptor!),
        };
        this.symbols.push(this.result);
        this.names.set(ast.name.key, this.result);
      }
    }
    this.collectingDeclarations = false;
    for (const declaration of ast.declarations) {
      this.initializer(declaration);
      for (const name of declaration.names) {
        const constant = this.constants.get(name.key);
        if (constant?.name === name) constant.initializerProcessed = true;
      }
    }
    if (this.result && ast.resultType) {
      const descriptor = this.descriptor(ast.resultType, ast.resultSubrange);
      if (descriptor) {
        this.result.descriptor = descriptor;
        this.result.initialValue = this.defaultValue(descriptor);
      }
    }
    if (!declarationsOnly) {
      this.selectBlockVariants();
      this.statements(ast.body, 0);
    }
    if (this.diagnostics.some((item) => item.severity === "error"))
      return { checked: null, diagnostics: this.diagnostics };
    return {
      checked: {
        ast,
        types: this.types,
        symbols: this.symbols,
        expressions: this.expressions,
        references: this.references,
        functions: this.functions,
        functionArguments: this.functionArguments,
        userCalls: this.userCalls,
        blockInputTypes: this.blockInputTypes,
        blockInOuts: this.blockInOuts,
        ...(this.result ? { result: this.result } : {}),
      },
      diagnostics: this.diagnostics,
    };
  }

  private selectBlockVariants(): void {
    const instances = new Map(
      this.symbols
        .filter((symbol) => selectingPort(symbol.type))
        .map((symbol) => [symbol.name.key, symbol]),
    );
    if (!instances.size) return;
    const inferred = new Set(instances.keys());
    // Isolate speculative expression checking: no cached types, references or diagnostics
    // may leak into the ordinary check against the final variants.
    const probe = new Checker(this.ast, this.pous, this.functionIds, this.blockIds, this.types);
    for (const [key, symbol] of this.names) probe.names.set(key, symbol);
    for (const [key, constant] of this.constants) probe.constants.set(key, constant);
    const bindings = new Map<VariableSymbol, DataType[]>();
    visitBlockBindings(this.ast.body, (name, port, value) => {
      const symbol = instances.get(name);
      if (
        !symbol ||
        port !== selectingPort(symbol.type) ||
        isUntyped(value) ||
        readsInferredMember(value, inferred)
      )
        return;
      const info = probe.expression(value);
      if (!info) return;
      const types = bindings.get(symbol) ?? [];
      types.push(info.dataType);
      bindings.set(symbol, types);
    });
    // Resolve only after collecting every selecting type, independently of source order.
    for (const [symbol, types] of bindings) {
      const variant = blockVariant(symbol.type, types);
      if (variant) symbol.type = variant;
      else {
        this.failedBlockSelections.add(symbol.name.key);
        this.report("fb.no-matching-variant", { name: symbol.name.name, types }, symbol.name.span);
      }
    }
  }

  private failedPreset(target: AST.AssignmentTarget): boolean {
    return (
      target.kind === "member" &&
      this.failedBlockSelections.has(target.instance.key) &&
      ["PT", "PV"].includes(target.member.key)
    );
  }

  private descriptor(name: AST.Identifier, range?: AST.Subrange): TypeDescriptor | undefined {
    const key = declarationType(name.key);
    let type: TypeDescriptor;
    if (isScalar(key)) type = key;
    else {
      const entry = this.types.find((entry) => entry.name.toUpperCase() === key);
      if (!entry) return undefined;
      type = { kind: "named", name: entry.name };
    }
    if (!range || this.collectingDeclarations) return type;
    const base = scalarBase(type, this.types);
    const lower = this.expression(range.lower, base),
      upper = this.expression(range.upper, base);
    try {
      if (
        !isIntegerType(base) ||
        lower?.constant === undefined ||
        upper?.constant === undefined ||
        enumerationType(lower.descriptor ?? lower.dataType, this.types) ||
        enumerationType(upper.descriptor ?? upper.dataType, this.types)
      )
        throw new RangeError("Invalid bounds");
      validateValue(base, lower.constant);
      validateValue(base, upper.constant);
      if (BigInt(lower.constant) > BigInt(upper.constant)) throw new RangeError("Reversed bounds");
      return {
        kind: "subrange",
        base,
        lower: coerceValue(base, lower.constant),
        upper: coerceValue(base, upper.constant),
      };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.report("type.invalid-constant", {}, range.span);
      return undefined;
    }
  }

  private defaultValue(type: TypeDescriptor): ScalarValue {
    if (typeof type !== "string" && type.kind === "named")
      return typeEntry(type, this.types).initialValue;
    const range = subrangeType(type, this.types);
    if (range) return range.lower;
    const base = scalarBase(type, this.types);
    return isLongType(base) ? "0" : base === "BOOL" ? false : 0;
  }

  private enum(info: ExpressionInfo): boolean {
    return !!enumerationType(info.descriptor ?? info.dataType, this.types);
  }

  private enumLiteral(
    node: AST.Expression,
    type: TypeDescriptor,
    name: AST.Identifier,
  ): ExpressionInfo | null {
    const enumeration = enumerationType(type, this.types);
    const member = enumeration?.values.find((member) => member.name.toUpperCase() === name.key);
    if (!member) {
      this.report("name.undeclared", { name: name.name }, node.span);
      return null;
    }
    return { dataType: enumeration!.base, descriptor: type, constant: member.value };
  }

  private declare(declaration: AST.Declaration): void {
    const descriptor = this.descriptor(declaration.typeName, declaration.subrange);
    const type = descriptor
      ? scalarBase(descriptor, this.types)
      : declarationType(declaration.typeName.key);
    const userBlock = this.blockIds.get(type);
    const block = isBlock(type) || userBlock !== undefined;
    const known = isScalar(type) || block;
    if (declaration.constant && block)
      this.report("decl.constant-type", {}, declaration.typeName.span);
    if (declaration.constant && declaration.address)
      this.report("decl.constant-address", {}, declaration.address.span);
    if (declaration.section === "VAR_IN_OUT" && declaration.initializer)
      this.report(
        "decl.in-out-initializer",
        { name: declaration.names[0].name },
        declaration.initializer.span,
      );
    if (block && declaration.section)
      this.report(
        "fb.invalid-instance-section",
        { name: declaration.names[0].name },
        declaration.typeName.span,
      );
    if (this.ast.kind === "function" && block)
      this.report("pou.function-block-in-function", {}, declaration.typeName.span);
    if (!known)
      this.report(
        "decl.unknown-type",
        { name: declaration.typeName.name },
        declaration.typeName.span,
      );
    if (declaration.address) {
      const address = declaration.address;
      if (declaration.section === "VAR_TEMP") this.report("decl.temp-address", {}, address.span);
      if (this.ast.kind !== "program") this.report("pou.direct-address", {}, address.span);
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
      const pou = this.pous.get(name.key);
      if (pou) {
        this.report(
          "decl.name-collision",
          { name: name.name, kind: pou.kind === "function" ? "function" : "type" },
          name.span,
        );
      } else if (
        isScalar(name.key) ||
        isBlock(name.key) ||
        this.types.some((entry) => entry.name.toUpperCase() === name.key)
      ) {
        this.report("decl.name-collision", { name: name.name, kind: "type" }, name.span);
      } else if (isFunction(name.key)) {
        this.report("decl.name-collision", { name: name.name, kind: "function" }, name.span);
      } else if (duplicate) {
        this.report("decl.duplicate", { name: name.name }, name.span);
      } else if (declaration.constant && isScalar(type)) {
        this.constants.set(name.key, { name, type, descriptor, initializerProcessed: false });
      } else if (known) {
        const symbol: VariableSymbol = {
          id: this.symbols.length,
          name,
          type,
          ...(descriptor ? { descriptor } : {}),
          ...(userBlock !== undefined ? { userBlock } : {}),
          initialValue: block ? null : this.defaultValue(descriptor!),
        };
        this.symbols.push(symbol);
        this.names.set(name.key, symbol);
        this.references.set(name, { variable: symbol.id });
      }
    }
  }

  private initializer(declaration: AST.Declaration): void {
    const descriptor = this.descriptor(declaration.typeName, declaration.subrange);
    for (const name of declaration.names) {
      const symbol = this.names.get(name.key),
        constant = this.constants.get(name.key);
      if (descriptor && symbol?.name === name) {
        symbol.descriptor = descriptor;
        symbol.initialValue = this.defaultValue(descriptor);
      }
      if (descriptor && constant?.name === name) constant.descriptor = descriptor;
    }
    const value = declaration.initializer;
    if (!value) {
      for (const name of declaration.names) {
        const constant = this.constants.get(name.key);
        if (constant?.name === name)
          constant.value = this.defaultValue(constant.descriptor ?? constant.type);
      }
      return;
    }
    const type = descriptor
      ? scalarBase(descriptor, this.types)
      : declarationType(declaration.typeName.key);
    if (isBlock(type) || this.blockIds.has(type)) {
      this.report("decl.fb-initializer", { name: declaration.names[0].name }, value.span);
      return;
    }
    const before = this.diagnostics.length;
    const info = this.expression(value, descriptor ?? (isScalar(type) ? type : undefined));
    if (!info || !isScalar(type)) return;
    if (!this.assignment(descriptor ?? type, info, value.span)) return;
    if (info.constant === undefined) {
      if (!this.diagnostics.slice(before).some((item) => item.severity === "error"))
        this.report(
          "decl.nonconstant-initializer",
          { name: declaration.names[0].name },
          value.span,
        );
      return;
    }
    const initialValue =
      isLongType(type) && info.dataType !== type
        ? convertValue(`${info.dataType}_TO_${type}` as ConversionFunction, info.constant)
        : coerceValue(type, info.constant);
    for (const name of declaration.names) {
      const symbol = this.names.get(name.key);
      if (symbol?.name === name) symbol.initialValue = initialValue;
      const constant = this.constants.get(name.key);
      if (constant?.name === name) constant.value = initialValue;
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

  private bitIndex(type: DataType, member: AST.Identifier): number | null {
    const index = this.constants.get(member.key);
    if (index && index.value === undefined) {
      if (!index.initializerProcessed)
        this.report("decl.constant-order", { name: member.name }, member.span);
      return null;
    }
    if (index && !isInteger(index.type)) {
      this.report("type.invalid-constant", {}, member.span);
      return null;
    }
    const bit = Number(index ? index.value : member.key);
    if (!Number.isSafeInteger(bit)) {
      this.report("type.invalid-constant", {}, member.span);
      return null;
    }
    if (!isBitType(type) || type === "BOOL" || bit < 0 || bit >= bitWidths[type]) {
      this.report("type.invalid-bit-access", { type, bit }, member.span);
      return null;
    }
    return bit;
  }

  private parameterType(
    pou: AST.Program,
    declaration: AST.Declaration,
  ): TypeDescriptor | undefined {
    const checked = this.interfaces.get(pou);
    const reference = checked?.references.get(declaration.names[0]);
    if (reference) return checked!.symbols[reference.variable]?.descriptor;
    return this.descriptor(declaration.typeName, declaration.subrange);
  }

  private reference(node: AST.AssignmentTarget, write = false): ExpressionInfo | null {
    const name = node.kind === "name" ? node.name : node.instance;
    const constant = this.constants.get(name.key);
    if (constant) {
      if (write) {
        this.report("decl.constant-not-writable", { name: name.name }, name.span);
        return null;
      }
      if (constant.value === undefined) {
        if (!constant.initializerProcessed)
          this.report("decl.constant-order", { name: name.name }, name.span);
        return null;
      }
      if (node.kind === "name")
        return {
          dataType: constant.type,
          descriptor: constant.descriptor,
          constant: constant.value,
        };
      const bit = this.bitIndex(constant.type, node.member);
      return bit === null
        ? null
        : { dataType: "BOOL", constant: !!((BigInt(constant.value) >> BigInt(bit)) & 1n) };
    }
    const symbol = this.resolve(name);
    if (!symbol) return null;
    if (node.kind === "name") {
      if (!isScalar(symbol.type)) {
        this.report("fb.instance-as-value", { name: name.name }, node.span);
        return null;
      }
      return { dataType: symbol.type, descriptor: symbol.descriptor };
    }
    if (
      isScalar(symbol.type) &&
      (/^\d+$/.test(node.member.key) || this.constants.has(node.member.key))
    ) {
      const bit = this.bitIndex(symbol.type, node.member);
      if (bit === null) return null;
      this.references.set(node.member, { variable: symbol.id, bit });
      return { dataType: "BOOL" };
    }
    if (symbol.userBlock !== undefined) {
      const pou = this.pous.get(symbol.type)!;
      const parameters = pou.declarations
        .filter((declaration) => !declaration.constant)
        .flatMap((declaration) =>
          declaration.names.map((member) => ({
            name: member,
            type: this.parameterType(pou, declaration),
            section: declaration.section,
          })),
        );
      const index = parameters.findIndex(
        (parameter) =>
          parameter.name.key === node.member.key &&
          ["VAR_INPUT", "VAR_OUTPUT"].includes(parameter.section ?? ""),
      );
      const parameter = parameters[index];
      if (!parameter?.type) {
        this.report(
          "fb.unknown-member",
          { name: name.name, member: node.member.name },
          node.member.span,
        );
        return null;
      }
      if (write && parameter.section === "VAR_OUTPUT")
        this.report(
          "fb.output-not-writable",
          { name: name.name, member: node.member.name },
          node.member.span,
        );
      this.references.set(node.member, {
        variable: symbol.id,
        member: index,
        port: parameter.section === "VAR_INPUT" ? "input" : "output",
        userBlock: true,
      });
      return { dataType: scalarBase(parameter.type, this.types), descriptor: parameter.type };
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

  private expression(node: AST.Expression, expected?: TypeDescriptor): ExpressionInfo | null {
    const expectedBase = expected ? scalarBase(expected, this.types) : undefined;
    const cached = this.expressions.get(node);
    if (cached) return cached;
    let info: ExpressionInfo | null;
    if (isUntyped(node)) {
      try {
        const exact = exactConstant(node);
        const dataType =
          expectedBase && acceptsKind(expectedBase, exact) ? expectedBase : defaultType(exact);
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
            node.literalKind === "calendar"
              ? parseCalendar(dataType as CalendarType, node.text)
              : node.literalKind === "time"
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
      case "enumeration": {
        const type = this.descriptor(node.typeName);
        if (!type) {
          this.report("decl.unknown-type", { name: node.typeName.name }, node.typeName.span);
          return null;
        }
        info = this.enumLiteral(node, type, node.member);
        break;
      }
      case "name":
        if (
          expected &&
          enumerationType(expected, this.types)?.values.some(
            (member) => member.name.toUpperCase() === node.name.key,
          )
        ) {
          if (this.names.has(node.name.key) || this.constants.has(node.name.key)) {
            this.report("type.ambiguous-enumeration", { name: node.name.name }, node.span);
            return null;
          }
          info = this.enumLiteral(node, expected, node.name);
        } else info = this.reference(node);
        break;
      case "member":
        info = this.reference(node);
        break;
      case "group":
        info = this.expression(node.expression, expected);
        break;
      case "functionCall":
        info = this.functionCall(node, false, expected);
        break;
      case "unary": {
        const operand = this.expression(node.operand);
        if (!operand) return null;
        const dataType = this.enum(operand) ? null : unaryType(node.operator, operand.dataType);
        if (!dataType) {
          this.report(
            "type.operand-mismatch",
            { operator: node.operator, left: operand.descriptor ?? operand.dataType, right: null },
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
        const values =
          node.operator === "**"
            ? [
                this.expression(node.left, isUntyped(node.left) ? "LREAL" : undefined),
                this.expression(node.right),
              ]
            : this.operands([node.left, node.right], scaling);
        const [left, right] = values;
        if (!left || !right) return null;
        const enums = this.enum(left) || this.enum(right);
        const dataType = enums
          ? ["=", "<>"].includes(node.operator) &&
            sameScalarType(
              left.descriptor ?? left.dataType,
              right.descriptor ?? right.dataType,
              this.types,
            )
            ? "BOOL"
            : null
          : binaryType(node.operator, left.dataType, right.dataType);
        if (!dataType) {
          this.report(
            "type.operand-mismatch",
            {
              operator: node.operator,
              left: left.descriptor ?? left.dataType,
              right: right.descriptor ?? right.dataType,
            },
            node.span,
          );
          return null;
        }
        const common = node.operator === "**" ? null : commonType([left.dataType, right.dataType]);
        const constantOperand = (operand: ExpressionInfo): ScalarValue =>
          common && isLongType(common) && operand.dataType !== common
            ? convertValue(
                `${operand.dataType}_TO_${common}` as ConversionFunction,
                operand.constant!,
              )
            : operand.constant!;
        info = this.constant(
          { dataType },
          node,
          left.constant === undefined || right.constant === undefined
            ? undefined
            : () =>
                isCalendarType(left.dataType)
                  ? calendarBinary(
                      node.operator,
                      left.dataType,
                      left.constant!,
                      right.dataType,
                      right.constant!,
                    )
                  : dataType === "LTIME"
                    ? ltimeBinary(
                        node.operator as "+" | "-" | "*" | "/",
                        BigInt(constantOperand(left)),
                        right.dataType === "REAL" || right.dataType === "LREAL"
                          ? Number(right.constant!)
                          : BigInt(constantOperand(right)),
                        right.dataType,
                      )
                    : dataType === "TIME"
                      ? timeBinary(
                          node.operator as "+" | "-" | "*" | "/",
                          Number(left.constant!),
                          typeof right.constant === "string" || typeof right.constant === "bigint"
                            ? BigInt(right.constant!)
                            : Number(right.constant!),
                          right.dataType,
                        )
                      : node.operator === "*" && isIntegerType(dataType) && !isLongType(dataType)
                        ? Math.imul(Number(left.constant!), Number(right.constant!))
                        : binaryConstant(
                            node.operator,
                            constantOperand(left),
                            constantOperand(right),
                          ),
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
    compute?: () => ScalarValue,
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
  private operands(
    nodes: AST.Expression[],
    independent = false,
    defaultExpected?: TypeDescriptor,
  ): (ExpressionInfo | null)[] {
    const deferred = (node: AST.Expression): boolean =>
      isUntyped(node) ||
      (node.kind === "name" &&
        !this.names.has(node.name.key) &&
        !this.constants.has(node.name.key));
    const hint = (node: AST.Expression): TypeDescriptor | undefined => {
      if (node.kind === "group") return hint(node.expression);
      if (node.kind === "enumeration") return this.descriptor(node.typeName);
      if (node.kind === "name")
        return (
          this.names.get(node.name.key)?.descriptor ?? this.constants.get(node.name.key)?.descriptor
        );
      return undefined;
    };
    const context =
      defaultExpected && enumerationType(defaultExpected, this.types)
        ? defaultExpected
        : nodes.map(hint).find((type) => type && enumerationType(type, this.types));
    const infos = nodes.map((node) => (deferred(node) ? null : this.expression(node, context)));
    const enumeration = infos.find((info) => info && this.enum(info));
    const enumExpected =
      enumeration?.descriptor ??
      (defaultExpected && enumerationType(defaultExpected, this.types)
        ? defaultExpected
        : undefined);
    if (enumExpected)
      return nodes.map((node, index) => {
        if (
          node.kind === "name" &&
          (this.names.has(node.name.key) || this.constants.has(node.name.key)) &&
          enumerationType(enumExpected, this.types)?.values.some(
            (member) => member.name.toUpperCase() === node.name.key,
          )
        ) {
          this.report("type.ambiguous-enumeration", { name: node.name.name }, node.span);
          return null;
        }
        return infos[index] ?? this.expression(node, enumExpected);
      });
    const pending = new Set(nodes.flatMap((node, index) => (deferred(node) ? [index] : [])));
    independent = independent && (infos[0]?.dataType === "TIME" || infos[0]?.dataType === "LTIME");
    const common = commonType(infos.filter((info) => info !== null).map((info) => info.dataType));
    for (const index of pending) {
      const node = nodes[index]!;
      let useDefault = independent || !common || !isUntyped(node);
      try {
        if (!useDefault) useDefault = !acceptsKind(common!, exactConstant(node));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        useDefault = true;
      }
      if (useDefault) {
        infos[index] = this.expression(node, defaultExpected);
        pending.delete(index);
      }
    }
    for (const index of pending) infos[index] = this.expression(nodes[index]!, common ?? undefined);
    return infos;
  }

  private functionCall(
    node: AST.FunctionCall,
    statement = false,
    expectedType?: TypeDescriptor,
  ): ExpressionInfo | null {
    const pou = this.pous.get(node.name.key);
    if (pou?.kind === "program") {
      this.report("call.program", { name: node.name.name }, node.name.span);
      return null;
    }
    if (pou?.kind === "function") return this.userFunctionCall(node, pou, statement);
    const symbol = this.names.get(node.name.key);
    if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined)) {
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
    const inputs = [...node.args];
    const invalidParameter = (parameter: AST.Identifier) =>
      this.report(
        "call.invalid-parameter",
        { name: node.name.name, parameter: parameter.name },
        parameter.span,
      );
    if (node.inputNames) {
      const ordered = new Map<number, AST.Expression>();
      node.inputNames.forEach((parameter, index) => {
        const port = signature.inputNames?.indexOf(parameter.key) ?? -1;
        if (port < 0 || ordered.has(port)) invalidParameter(parameter);
        else ordered.set(port, node.args[index]!);
      });
      if (ordered.size !== signature.min) {
        this.report(
          "call.argument-count",
          { name: node.name.name, min: signature.min, max: signature.max, found: ordered.size },
          node.span,
        );
      }
      // Failed calls still check their supplied expressions, but never reach lowering.
      if (Array.from({ length: signature.min }, (_, index) => ordered.has(index)).every(Boolean))
        inputs.splice(
          0,
          inputs.length,
          ...Array.from({ length: signature.min }, (_, index) => ordered.get(index)!),
        );
    }
    this.functionArguments.set(node, inputs);
    const seenOutputs = new Set<number>();
    for (const output of node.outputs ?? []) {
      const port = signature.outputs?.findIndex(([name]) => name === output.name.key) ?? -1;
      if (port < 0 || seenOutputs.has(port)) invalidParameter(output.name);
      seenOutputs.add(port);
      const target = this.reference(output.target, true);
      if (target) {
        this.expressions.set(output.target, target);
        if (port >= 0)
          this.assignment(
            target.descriptor ?? target.dataType,
            { dataType: signature.outputs![port]![1] },
            output.target.span,
          );
      }
    }
    if (
      !node.inputNames &&
      (inputs.length < signature.min || (signature.max !== null && inputs.length > signature.max))
    ) {
      this.report(
        "call.argument-count",
        { name: node.name.name, min: signature.min, max: signature.max, found: inputs.length },
        node.span,
      );
    }
    const enumContext =
      expectedType && enumerationType(expectedType, this.types) ? expectedType : undefined;
    const parameter = (arg: AST.Expression, index: number): ExpressionInfo | null => {
      const types = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
      return this.expression(
        arg,
        name === "MOVE"
          ? enumContext
          : types.length === 1
            ? types[0]
            : types.every((type) => type === "REAL" || type === "LREAL")
              ? "LREAL"
              : undefined,
      );
    };
    const start = signature.genericStart;
    const realGroup =
      start !== undefined &&
      signature.arguments[start]?.every((type) => type === "REAL" || type === "LREAL");
    const args =
      start === undefined
        ? inputs.map(parameter)
        : [
            ...inputs.slice(0, start).map(parameter),
            ...this.operands(inputs.slice(start), false, realGroup ? "LREAL" : enumContext),
          ];
    const enumeration = args.find((arg) => arg && this.enum(arg));
    if (enumeration) {
      const firstValue = name === "SEL" || name === "MUX" ? 1 : 0;
      args.forEach((arg, index) => {
        if (!arg) return;
        const accepted =
          ["MOVE", "SEL", "MUX"].includes(name) && index >= firstValue
            ? sameScalarType(enumeration.descriptor!, arg.descriptor ?? arg.dataType, this.types)
            : !this.enum(arg) &&
              signature.arguments[Math.min(index, signature.arguments.length - 1)]!.includes(
                arg.dataType,
              );
        if (!accepted)
          this.report(
            "call.argument-type",
            {
              name,
              index,
              expected: [enumeration.descriptor!],
              found: arg.descriptor ?? arg.dataType,
            },
            inputs[index]!.span,
          );
      });
      return ["MOVE", "SEL", "MUX"].includes(name)
        ? { dataType: enumeration.dataType, descriptor: enumeration.descriptor }
        : null;
    }
    let validArguments = true;
    args.forEach((arg, index) => {
      if (!arg) {
        validArguments = false;
        return;
      }
      const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
      // A fixed source parameter is a typed slot and accepts implicit widening.
      if (
        !expected.some((to) =>
          expected.length === 1 ? assignable(to, arg.dataType) : to === arg.dataType,
        )
      ) {
        validArguments = false;
        if (expected.length === 1 && isNumeric(expected[0]!) && isNumeric(arg.dataType))
          this.assignment(expected[0]!, arg, inputs[index]!.span);
        else
          this.report(
            "call.argument-type",
            { name: node.name.name, index, expected, found: arg.dataType },
            inputs[index]!.span,
          );
      }
    });
    if (signature.result && start === undefined) {
      if (!Object.hasOwn(conversionFunctions, name)) return { dataType: signature.result };
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
        resolved === "LREAL_TO_LWORD" ||
        resolved === "LWORD_TO_LREAL" ||
        ["BYTE_TO_BOOL", "WORD_TO_BOOL", "DWORD_TO_BOOL", "LWORD_TO_BOOL"].includes(resolved)
      ) {
        this.diagnostics.push({
          code: "type.portability",
          severity: "warning",
          args: { function: resolved },
          span: node.span,
          pou: this.ast.name.name,
        });
      }
      return this.constant(
        { dataType: signature.result },
        node,
        !validArguments || arg?.constant === undefined || inputs.length !== 1
          ? undefined
          : () =>
              convertValue(
                resolved,
                signature.arguments[0]?.length === 1 &&
                  signature.arguments[0][0] !== arg.dataType &&
                  isLongType(signature.arguments[0][0]!)
                  ? convertValue(
                      `${arg.dataType}_TO_${signature.arguments[0][0]}` as ConversionFunction,
                      arg.constant!,
                    )
                  : arg.constant!,
              ),
      );
    }
    if (signature.resultArgument !== undefined) {
      const arg = args[signature.resultArgument];
      return arg ? { dataType: arg.dataType } : null;
    }
    const values = args.flatMap((arg, index) =>
      arg && index >= (start ?? 0) ? [{ ...arg, index }] : [],
    );
    const types = values.map((arg) => arg.dataType);
    const dataType = commonType(types);
    if (!dataType) {
      for (let offset = 1; offset < values.length; offset++) {
        // Recompute from each complete prefix, not a pairwise fold: common-type
        // selection is set-based and can change when a third type is added.
        const expected = commonType(types.slice(0, offset));
        const found = values[offset]!;
        if (expected && !commonType(types.slice(0, offset + 1))) {
          this.report(
            "call.argument-type",
            {
              name: node.name.name,
              index: found.index,
              expected: [expected],
              found: found.dataType,
            },
            inputs[found.index]!.span,
          );
          break;
        }
      }
    }
    return dataType ? { dataType: signature.result ?? dataType } : null;
  }

  private userFunctionCall(
    node: AST.FunctionCall,
    pou: AST.Program,
    statement: boolean,
  ): ExpressionInfo | null {
    const parameters = pou.declarations
      .filter((declaration) => !declaration.constant)
      .flatMap((declaration) =>
        declaration.names.map((name) => ({
          name,
          type: this.parameterType(pou, declaration),
          section: declaration.section,
        })),
      )
      .map((parameter, variable) => ({ ...parameter, variable }));
    const inputs = parameters.filter((parameter) => parameter.section === "VAR_INPUT");
    const outputs = parameters.filter((parameter) => parameter.section === "VAR_OUTPUT");
    const inOuts = parameters.filter((parameter) => parameter.section === "VAR_IN_OUT");
    const result = pou.resultType
      ? (this.interfaces.get(pou)?.result?.descriptor ??
        this.descriptor(pou.resultType, pou.resultSubrange) ??
        null)
      : null;
    if (!statement && result === null)
      this.report("call.no-result", { name: node.name.name }, node.span);
    const call: UserCallInfo = {
      function: this.functionIds.get(pou.name.key)!,
      inputs: [],
      outputs: [],
      inOuts: [],
      result: result ? scalarBase(result, this.types) : null,
      ...(result ? { resultDescriptor: result } : {}),
    };
    this.userCalls.set(node, call);
    const invalid = (name: AST.Identifier) =>
      this.report(
        "call.invalid-parameter",
        { name: node.name.name, parameter: name.name },
        name.span,
      );
    const formal = node.inputNames !== undefined || node.args.length === 0;
    if (!formal) {
      if (outputs.length || inOuts.length)
        this.report("call.formal-required", { name: node.name.name }, node.span);
      if (node.args.length !== inputs.length)
        this.report(
          "call.argument-count",
          { name: node.name.name, min: inputs.length, max: inputs.length, found: node.args.length },
          node.span,
        );
    }
    const seen = new Set<string>();
    node.args.forEach((value, index) => {
      const name = node.inputNames?.[index];
      const parameter = formal
        ? [...inputs, ...inOuts].find((input) => input.name.key === name?.key)
        : inputs[index];
      if (name && (!parameter || seen.has(name.key))) invalid(name);
      if (name) seen.add(name.key);
      const type = parameter?.type;
      if (parameter?.section === "VAR_IN_OUT") {
        if (type && this.inOutActual(value, type))
          call.inOuts.push({ variable: parameter.variable, actual: value });
        return;
      }
      const info = this.expression(value, type);
      if (parameter && type) {
        if (info) this.assignment(type, info, value.span);
        call.inputs.push({
          variable: parameter.variable,
          value,
          dataType: scalarBase(type, this.types),
        });
      }
    });
    for (const output of node.outputs ?? []) {
      const parameter = outputs.find((item) => item.name.key === output.name.key);
      if (!parameter || seen.has(output.name.key)) invalid(output.name);
      seen.add(output.name.key);
      const target = this.reference(output.target, true);
      if (target) {
        this.expressions.set(output.target, target);
        if (parameter?.type) {
          this.assignment(
            target.descriptor ?? target.dataType,
            { dataType: scalarBase(parameter.type, this.types), descriptor: parameter.type },
            output.target.span,
          );
          call.outputs.push({ variable: parameter.variable, target: output.target });
        }
      }
    }
    this.requireInOuts(inOuts, seen, node);
    if (result === null) return statement ? { dataType: "BOOL" } : null;
    return { dataType: scalarBase(result, this.types), descriptor: result };
  }

  private inOutActual(value: AST.Expression, type: TypeDescriptor): value is AST.NameReference {
    if (value.kind !== "name") {
      this.report("call.in-out-variable", {}, value.span);
      return false;
    }
    const info = this.reference(value, true);
    if (!info) return false;
    this.expressions.set(value, info);
    if (!sameScalarType(info.descriptor ?? info.dataType, type, this.types)) {
      this.report(
        "call.in-out-type",
        { from: info.descriptor ?? info.dataType, to: type },
        value.span,
      );
      return false;
    }
    return true;
  }

  private requireInOuts(
    parameters: { name: AST.Identifier }[],
    seen: ReadonlySet<string>,
    node: AST.FunctionCall,
  ): void {
    for (const parameter of parameters)
      if (!seen.has(parameter.name.key))
        this.report(
          "call.missing-in-out",
          { name: node.name.name, parameter: parameter.name.name },
          node.span,
        );
  }

  private blockCall(node: AST.FunctionCall): void {
    const symbol = this.resolve(node.name);
    if (!symbol) return;
    if (isScalar(symbol.type)) {
      this.report("fb.not-function-block", { name: node.name.name }, node.name.span);
      return;
    }
    if (this.ast.kind === "function") this.report("pou.function-block-in-function", {}, node.span);
    if (node.args.length && !node.inputNames) {
      this.report("fb.unsupported-call", { name: node.name.name }, node.span);
      return;
    }
    const inOuts =
      symbol.userBlock === undefined
        ? []
        : this.pous
            .get(symbol.type)!
            .declarations.filter((declaration) => !declaration.constant)
            .flatMap((declaration) => declaration.names.map((name) => ({ name, declaration })))
            .map((parameter, variable) => ({ ...parameter, variable }))
            .filter(({ declaration }) => declaration.section === "VAR_IN_OUT");
    const bindings: UserCallInfo["inOuts"] = [];
    this.blockInOuts.set(node, bindings);
    const seen = new Set<string>();
    node.args.forEach((value, index) => {
      const name = node.inputNames![index]!;
      const inOut = inOuts.find((parameter) => parameter.name.key === name.key);
      if (inOut) {
        if (seen.has(name.key))
          this.report("fb.duplicate-input", { name: node.name.name, member: name.name }, name.span);
        seen.add(name.key);
        const type = this.parameterType(this.pous.get(symbol.type)!, inOut.declaration);
        if (type && this.inOutActual(value, type))
          bindings.push({ variable: inOut.variable, actual: value });
        return;
      }
      const member: AST.MemberReference = {
        kind: "member",
        instance: node.name,
        member: name,
        span: name.span,
      };
      const target = this.reference(member, true);
      const failed = this.failedPreset(member);
      const info = this.expression(
        value,
        failed ? undefined : (target?.descriptor ?? target?.dataType),
      );
      if (target) this.blockInputTypes.set(name, target.dataType);
      if (seen.has(name.key))
        this.report("fb.duplicate-input", { name: node.name.name, member: name.name }, name.span);
      seen.add(name.key);
      if (target && info && !failed)
        this.assignment(target.descriptor ?? target.dataType, info, value.span);
    });
    this.requireInOuts(inOuts, seen, node);
    for (const output of node.outputs ?? []) {
      const source = this.reference({
        kind: "member",
        instance: node.name,
        member: output.name,
        span: output.name.span,
      });
      const reference = this.references.get(output.name);
      if ((reference && reference.port !== "output") || seen.has(output.name.key))
        this.report(
          "call.invalid-parameter",
          { name: node.name.name, parameter: output.name.name },
          output.name.span,
        );
      seen.add(output.name.key);
      const target = this.reference(output.target, true);
      if (target) this.expressions.set(output.target, target);
      if (source && target)
        this.assignment(target.descriptor ?? target.dataType, source, output.target.span);
    }
  }

  private assignment(target: TypeDescriptor, info: ExpressionInfo, span: SourceSpan): boolean {
    const to = scalarBase(target, this.types),
      from = info.dataType;
    const enums = this.enum(info) || !!enumerationType(target, this.types);
    if (
      enums ? !sameScalarType(target, info.descriptor ?? from, this.types) : !assignable(to, from)
    ) {
      this.report(
        "type.assign-mismatch",
        {
          from: info.descriptor ?? from,
          to: target,
          ...(!enums && Object.hasOwn(conversionFunctions, `${from}_TO_${to}`)
            ? { hint: "explicit-conversion" as const }
            : {}),
        },
        span,
      );
      return false;
    }
    if (info.constant !== undefined) {
      try {
        validateDeclaredValue(target, info.constant, this.types);
        if (isLongType(to) && to !== from)
          convertValue(`${from}_TO_${to}` as ConversionFunction, info.constant);
        else coerceValue(to, info.constant);
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
          const failed = this.failedPreset(node.target);
          const target = this.reference(node.target, true),
            value = this.expression(
              node.value,
              failed ? undefined : (target?.descriptor ?? target?.dataType),
            );
          if (target) this.expressions.set(node.target, target);
          if (target && value && !failed)
            this.assignment(target.descriptor ?? target.dataType, value, node.value.span);
          break;
        }
        case "call": {
          const symbol = this.names.get(node.call.name.key);
          if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined))
            this.blockCall(node.call);
          else {
            const info = this.functionCall(node.call, true);
            if (info) this.expressions.set(node.call, info);
          }
          break;
        }
        case "fbCall": {
          const call: AST.FunctionCall = {
            kind: "functionCall",
            name: node.instance,
            args: node.inputs.map((input) => input.value),
            inputNames: node.inputs.map((input) => input.name),
            span: node.span,
          };
          if (this.pous.has(node.instance.key)) {
            this.functionCall(call, true);
            const info = this.userCalls.get(call);
            if (info) {
              this.userCalls.delete(call);
              this.userCalls.set(node, info);
            }
          } else {
            this.blockCall(call);
            const bindings = this.blockInOuts.get(call);
            if (bindings) {
              this.blockInOuts.delete(call);
              this.blockInOuts.set(node, bindings);
            }
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
                const info = this.expression(value, selector?.descriptor ?? selector?.dataType);
                if (!info) continue;
                if (!isInteger(info.dataType))
                  this.report("type.case-label-not-integer", { type: info.dataType }, value.span);
                else {
                  if (selector && isInteger(selector.dataType))
                    this.assignment(selector.descriptor ?? selector.dataType, info, value.span);
                  if (selector && this.enum(selector) && label.kind === "range")
                    this.report("type.invalid-constant", {}, label.span);
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
          const constant = this.constants.has(node.variable.key);
          if (constant)
            this.report(
              "decl.constant-not-writable",
              { name: node.variable.name },
              node.variable.span,
            );
          const symbol = constant ? null : this.resolve(node.variable);
          if (symbol) {
            if (!isScalar(symbol.type))
              this.report("fb.instance-as-value", { name: node.variable.name }, node.variable.span);
            else if (
              !isInteger(symbol.type) ||
              (symbol.descriptor &&
                (enumerationType(symbol.descriptor, this.types) ||
                  subrangeType(symbol.descriptor, this.types)))
            )
              this.report(
                "type.for-variable-not-integer",
                { name: node.variable.name, type: symbol.descriptor ?? symbol.type },
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
            if (info && (!isInteger(info.dataType) || this.enum(info)))
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
export function check(
  ast: AST.Program,
  pous: ReadonlyMap<string, AST.Program> = new Map([[ast.name.key, ast]]),
  functionIds: ReadonlyMap<string, number> = new Map(),
  blockIds: ReadonlyMap<string, number> = new Map(),
  types: TypeTable = [],
  interfaces: ReadonlyMap<AST.Program, CheckedProgram> = new Map(),
): CheckResult {
  return new Checker(ast, pous, functionIds, blockIds, types, interfaces).run(ast);
}

/** Resolve POU signatures in their own constant scope before checking call sites. */
export function checkDeclarations(
  ast: AST.Program,
  types: TypeTable,
  pous: ReadonlyMap<string, AST.Program>,
  blockIds: ReadonlyMap<string, number>,
): CheckResult {
  return new Checker(ast, pous, new Map(), blockIds, types).run(ast, true);
}
