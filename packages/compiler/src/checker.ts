import { isReservedStandardName } from "./reserved-names.js";
import {
  addressBinds,
  validDirectAddress,
  resolveType,
  coerceValue,
  cloneInitialValue,
  arrayType,
  structureType,
  isAggregateType,
  arraySize,
  leafCount,
  type InitialValue,
  isCharacterType,
  isWideCharacterType,
  internalValue,
  DEFAULT_STRING_LENGTH,
  MAX_STRING_LENGTH,
  scalarBase,
  referenceType,
  referenceLike,
  interfaceType,
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
import { accessible } from "./inheritance.js";
import { rootName } from "./ast.js";
import type {
  CheckedProgram,
  ConstantSymbol,
  GlobalScope,
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
  stringArgumentType,
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

function hasOpenDimensions(node?: AST.ArrayDeclaration): boolean {
  return !!node && (node.dimensions.includes("*") || hasOpenDimensions(node.array));
}

class Checker {
  private initializerOwner?: AST.Program;
  private declarationOwner?: AST.Program;
  private inheritedDeclarationError = false;
  private readonly superCalls = new Map<AST.FunctionCall | AST.FunctionBlockCall, number>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly symbols: VariableSymbol[] = [];
  private readonly names = new Map<string, VariableSymbol>();
  private readonly constants = new Map<string, ConstantSymbol>();
  private readonly declaredNames = new Set<string>();
  private readonly expressions = new Map<AST.Expression, ExpressionInfo>();
  private readonly references = new Map<AST.Identifier, ResolvedReference>();
  private readonly functionArguments = new Map<AST.FunctionCall, readonly AST.Expression[]>();
  private readonly arrayBounds = new Map<
    AST.FunctionCall,
    { array: AST.Expression; dimension: number; upper: boolean }
  >();
  private readonly functions = new Map<AST.FunctionCall, StandardFunction>();
  private readonly blockInOuts = new Map<
    AST.FunctionCall | AST.FunctionBlockCall,
    UserCallInfo["inOuts"]
  >();
  private readonly userCalls = new Map<AST.FunctionCall | AST.FunctionBlockCall, UserCallInfo>();
  private readonly blockInputTypes = new Map<AST.Identifier, DataType>();
  private readonly blockCalls = new Map<AST.FunctionCall, number>();
  private readonly failedBlockSelections = new Set<string>();
  private result?: VariableSymbol;
  private collectingDeclarations = true;
  private readonly failedReferenceTypes = new Set<AST.Identifier>();
  private readonly failedReferenceTargets = new Set<AST.TypeSyntax>();
  private readonly unsupportedBlockArrays = new Set<AST.ArrayDeclaration>();

  constructor(
    private readonly ast: AST.Program,
    private readonly pous: ReadonlyMap<string, AST.Program>,
    private readonly functionIds: ReadonlyMap<string, number>,
    private readonly blockIds: ReadonlyMap<string, number>,
    private readonly types: TypeTable,
    private readonly interfaces: ReadonlyMap<AST.Program, CheckedProgram> = new Map(),
    private readonly globals?: GlobalScope,
  ) {}

  connection(
    scope: CheckedProgram,
    type: TypeDescriptor,
    value: AST.Expression,
    output: boolean,
  ): { info?: ExpressionInfo; diagnostics: Diagnostic[] } {
    for (const symbol of scope.symbols) this.names.set(symbol.name.key, symbol);
    for (const [key, constant] of scope.constants) this.constants.set(key, constant);
    let info: ExpressionInfo | null;
    if (output) {
      info = this.reference(value as AST.AssignmentTarget, true);
      if (info)
        this.assignment(
          info.descriptor ?? info.dataType,
          { dataType: this.base(type, this.types), descriptor: type },
          value.span,
        );
    } else {
      info = this.expression(value, type);
      if (info) this.assignment(type, info, value.span);
    }
    return { ...(info ? { info } : {}), diagnostics: this.diagnostics };
  }

  private report<C extends DiagnosticCode>(
    code: C,
    args: DiagnosticArgs[C],
    span: SourceSpan,
  ): void {
    if (this.declarationOwner && this.declarationOwner !== this.ast) {
      // The declaring type reports this error at its own source position.
      this.inheritedDeclarationError = true;
      return;
    }
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
    const owner = ast.owner;
    let memberCount = 0;
    if (owner) {
      const members =
        this.interfaces.get(owner) ??
        new Checker(
          owner,
          this.pous,
          this.functionIds,
          this.blockIds,
          this.types,
          new Map(),
          this.globals,
        ).run(owner, true).checked;
      if (members) {
        for (const symbol of members.symbols) {
          const member = { ...symbol };
          this.symbols.push(member);
          this.names.set(member.name.key, member);
        }
        for (const [key, constant] of members.constants) this.constants.set(key, constant);
      }
      memberCount = this.symbols.length;
      for (const declaration of ast.declarations)
        for (const name of declaration.names)
          if (
            owner.declarations.some((d) => d.names.some((n) => n.key === name.key)) ||
            owner.methods?.some((m) => m.name.key === name.key)
          )
            this.report("method.name-collision", { name: name.name }, name.span);
    }
    if (ast.methods) {
      const names = new Set(ast.declarations.flatMap((d) => d.names.map((n) => n.key)));
      for (const method of ast.methods) {
        if (method.owner && method.owner !== ast) continue;
        if (names.has(method.name.key))
          this.report("method.name-collision", { name: method.name.name }, method.name.span);
        names.add(method.name.key);
      }
    }
    const interfaceSection = (name: string): boolean => {
      const declarations = ast.declarations.filter((d) => d.section === name);
      const interfaceStorage = (type: TypeDescriptor): boolean =>
        !!interfaceType(type, this.types) ||
        !!(arrayType(type, this.types) && interfaceStorage(arrayType(type, this.types)!.element));
      return (
        declarations.length > 0 &&
        declarations.every((d) => {
          const type = this.descriptor(
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
      this.declarationOwner = section.declaringType;
      if (section.retain || section.nonRetain) {
        if (section.retain && section.nonRetain)
          this.report("decl.retention-conflict", {}, section.span);
        if (["VAR_TEMP", "VAR_IN_OUT", "VAR_EXTERNAL"].includes(section.name))
          this.report("decl.retention-section", {}, section.span);
        if (ast.kind === "function") this.report("decl.retention-function", {}, section.span);
        if (section.constant) this.report("decl.retention-constant", {}, section.span);
      }
      if (section.constant && section.name !== "VAR" && section.name !== "VAR_EXTERNAL")
        this.report("decl.constant-section", { section: section.name }, section.span);
      if (
        (ast.kind === "program" &&
          section.name !== "VAR" &&
          section.name !== "VAR_TEMP" &&
          section.name !== "VAR_EXTERNAL" &&
          section.name !== "VAR_INPUT" &&
          section.name !== "VAR_OUTPUT" &&
          !(section.name === "VAR_IN_OUT" && interfaceSection("VAR_IN_OUT"))) ||
        (ast.kind === "function" &&
          ["VAR_TEMP", "VAR_EXTERNAL"].includes(section.name) &&
          !(section.name === "VAR_TEMP" && interfaceSection("VAR_TEMP"))) ||
        (ast.kind === "class" && !["VAR", "VAR_EXTERNAL"].includes(section.name))
      )
        this.report("pou.invalid-section", { section: section.name, kind: ast.kind }, section.span);
      this.declarationOwner = undefined;
    }
    // Collect all declarations first so forward references receive ordinary type diagnostics.
    for (const declaration of ast.declarations) {
      this.declarationOwner = declaration.declaringType;
      this.declare(declaration);
      this.declarationOwner = undefined;
    }
    if (hasOpenDimensions(ast.resultArray))
      this.report("decl.open-array-section", {}, ast.resultArray!.span);
    if (ast.resultType) {
      const descriptor = this.descriptor(
        ast.resultType,
        ast.resultSubrange,
        ast.resultStringLength,
        ast.resultArray,
        ast.resultReference,
      );
      const type = descriptor
        ? this.base(descriptor, this.types)
        : declarationType(ast.resultType.key);
      if (!isScalar(type)) {
        if (!this.failedReferenceTypes.has(ast.resultType))
          this.report("decl.unknown-type", { name: ast.resultType.name }, ast.resultType.span);
      } else {
        this.result = {
          id: this.symbols.length,
          name: ast.simpleName ?? ast.name,
          type,
          descriptor,
          initialValue: this.defaultValue(descriptor!),
        };
        this.symbols.push(this.result);
        this.names.set((ast.simpleName ?? ast.name).key, this.result);
      }
    }
    this.collectingDeclarations = false;
    for (const declaration of ast.declarations) {
      this.initializerOwner = declaration.declaringType;
      this.declarationOwner = declaration.declaringType;
      this.initializer(declaration);
      this.initializerOwner = undefined;
      this.declarationOwner = undefined;
      for (const name of declaration.names) {
        const constant = this.constants.get(name.key);
        if (constant?.name === name) constant.initializerProcessed = true;
      }
    }
    if (this.result && ast.resultType) {
      const descriptor = this.descriptor(
        ast.resultType,
        ast.resultSubrange,
        ast.resultStringLength,
        ast.resultArray,
        ast.resultReference,
      );
      if (descriptor) {
        this.result.descriptor = descriptor;
        this.result.initialValue = this.defaultValue(descriptor);
        if (isAggregateType(descriptor, this.types))
          this.result.aggregateValues = this.aggregateInitial(descriptor);
      }
    }
    if (!declarationsOnly) {
      this.selectBlockVariants();
      this.statements(ast.body, 0);
    }
    if (
      this.inheritedDeclarationError ||
      this.diagnostics.some((item) => item.severity === "error")
    )
      return { checked: null, diagnostics: this.diagnostics };
    return {
      checked: {
        ast,
        superCalls: this.superCalls,
        ...(owner ? { memberCount } : {}),
        types: this.types,
        symbols: this.symbols,
        constants: this.constants,
        expressions: this.expressions,
        references: this.references,
        arrayBounds: this.arrayBounds,
        functions: this.functions,
        functionArguments: this.functionArguments,
        userCalls: this.userCalls,
        blockInputTypes: this.blockInputTypes,
        blockCalls: this.blockCalls,
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
    for (const symbol of instances.values()) {
      let types = bindings.get(symbol) ?? [];
      if (symbol.external && this.globals) {
        const shared = this.globals.bindings.get(symbol.external) ?? [];
        types = [...new Set([...shared, ...types])];
        this.globals.bindings.set(symbol.external, types);
      }
      const owner =
        this.ast.owner ??
        (["functionBlock", "class"].includes(this.ast.kind) ? this.ast : undefined);
      if (owner && !symbol.external && this.globals?.memberBindings) {
        const key = `${owner.name.key}.${symbol.name.key}`;
        types = [...new Set([...(this.globals.memberBindings.get(key) ?? []), ...types])];
        this.globals.memberBindings.set(key, types);
      }
      if (!types.length) continue;
      const variant = blockVariant(symbol.type, types);
      if (variant) {
        symbol.type = variant;
        const array = symbol.descriptor && arrayType(symbol.descriptor, this.types);
        if (array)
          symbol.descriptor = { ...array, element: { kind: "functionBlock", name: variant } };
      } else {
        this.failedBlockSelections.add(symbol.name.key);
        this.report("fb.no-matching-variant", { name: symbol.name.name, types }, symbol.name.span);
      }
    }
  }

  private failedPreset(target: AST.AssignmentTarget): boolean {
    return (
      (target.kind === "member" || target.kind === "field") &&
      this.failedBlockSelections.has(rootName(target).key) &&
      ["PT", "PV"].includes(target.member.key)
    );
  }

  /** Composite descriptors remain authoritative; scalar-only side tables use an unused INT tag. */
  private base(type: TypeDescriptor, table = this.types): DataType {
    return isAggregateType(type, table) ||
      referenceLike(type, table) ||
      (typeof type !== "string" && type.kind === "functionBlock")
      ? "INT"
      : scalarBase(type, table);
  }

  private arrayDeclaration(node: AST.ArrayDeclaration): TypeDescriptor | undefined {
    if (this.unsupportedBlockArrays.has(node)) return undefined;
    const key = declarationType(node.typeName.key);
    const block = !node.array && !node.reference && (isBlock(key) || this.blockIds.has(key));
    if (block && (node.subrange || node.stringLength !== undefined)) {
      this.report("type.invalid-constant", {}, node.span);
      return undefined;
    }
    const element: TypeDescriptor | undefined = block
      ? {
          kind: "functionBlock",
          name: key,
          ...(this.blockIds.has(key) ? { block: this.blockIds.get(key)! } : {}),
        }
      : this.descriptor(
          node.typeName,
          node.subrange,
          node.stringLength,
          node.array,
          node.reference,
        );
    if (!element) {
      if (node.array && this.unsupportedBlockArrays.has(node.array))
        this.unsupportedBlockArrays.add(node);
      return undefined;
    }
    const nested = arrayType(element, this.types);
    if (nested && typeof nested.element !== "string" && nested.element.kind === "functionBlock") {
      this.unsupportedBlockArrays.add(node);
      this.report("decl.fb-array-form", { form: "nested" }, node.span);
      return undefined;
    }
    if (this.collectingDeclarations)
      return { kind: "array", dimensions: [{ lower: 0, upper: 0 }], element };
    try {
      if (node.dimensions.some((d) => d === "*") && !node.dimensions.every((d) => d === "*"))
        throw new RangeError("Mixed open and fixed dimensions");
      const dimensions = node.dimensions.map((d) => {
        if (d === "*") return "*" as const;
        const lower = this.expression(d.lower, "LINT"),
          upper = this.expression(d.upper, "LINT");
        if (
          !lower ||
          !upper ||
          !isIntegerType(lower.dataType) ||
          !isIntegerType(upper.dataType) ||
          this.enum(lower) ||
          this.enum(upper) ||
          lower.constant === undefined ||
          upper.constant === undefined
        )
          throw new RangeError("Nonconstant array bounds");
        const l = BigInt(lower.constant),
          u = BigInt(upper.constant);
        if (l < -2147483648n || u > 2147483647n || l > u)
          throw new RangeError("Invalid array bounds");
        return { lower: Number(l), upper: Number(u) };
      });
      const type: TypeDescriptor = { kind: "array", dimensions, element };
      if (dimensions.length > 3 || leafCount(type, this.types) > 10000)
        throw new RangeError("Array limit");
      return type;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.report("type.invalid-constant", {}, node.span);
      return undefined;
    }
  }

  private aggregateInitial(type: TypeDescriptor, node?: AST.Expression): InitialValue[] {
    const structure = structureType(type, this.types);
    if (!structure) return this.arrayInitial(type, node);
    if (!node && typeof type !== "string" && type.kind === "named")
      return cloneInitialValue(typeEntry(type, this.types).initialValue) as InitialValue[];
    const result = structure.members.map((member) => cloneInitialValue(member.initialValue));
    if (node) {
      if (node.kind !== "structureInitializer") this.report("type.invalid-constant", {}, node.span);
      else {
        const seen = new Set<string>();
        for (const member of node.members) {
          const index = structure.members.findIndex(
            (item) => item.name.toUpperCase() === member.name.key,
          );
          if (index < 0 || seen.has(member.name.key)) {
            this.report("type.invalid-constant", {}, member.name.span);
            continue;
          }
          seen.add(member.name.key);
          const target = structure.members[index]!.dataType;
          if (isAggregateType(target, this.types))
            result[index] = this.aggregateInitial(target, member.value);
          else {
            if (referenceLike(target, this.types)) {
              if (member.value.kind !== "null")
                this.report("type.reference-initializer", {}, member.value.span);
              result[index] = null;
              continue;
            }
            const info = this.expression(member.value, target);
            if (!info || !this.assignment(target, info, member.value.span)) continue;
            if (info.constant === undefined) {
              this.report("type.invalid-constant", {}, member.value.span);
              continue;
            }
            const base = this.base(target);
            result[index] =
              isLongType(base) && info.dataType !== base
                ? (convertValue(
                    `${info.dataType}_TO_${base}` as ConversionFunction,
                    info.constant,
                  ) as InitialValue)
                : coerceValue(base, info.constant);
          }
        }
      }
    }
    return result;
  }

  private arrayInitial(type: TypeDescriptor, node?: AST.Expression): InitialValue[] {
    const array = arrayType(type, this.types)!;
    if (!node && typeof type !== "string" && type.kind === "named")
      return cloneInitialValue(typeEntry(type, this.types).initialValue) as InitialValue[];
    const result: InitialValue[] = [];
    if (node) {
      if (node.kind !== "arrayInitializer")
        this.report("type.array-initializer-required", { type }, node.span);
      else
        for (const item of node.items) {
          const countInfo = item.count ? this.expression(item.count, "DINT") : undefined;
          const count = item.count ? Number(countInfo?.constant) : 1;
          if (
            !Number.isInteger(count) ||
            count < 0 ||
            count > 10000 ||
            (countInfo && (!isIntegerType(countInfo.dataType) || this.enum(countInfo)))
          ) {
            this.report("type.invalid-constant", {}, node.span);
            continue;
          }
          const values = item.values.map((value) => {
            if (isAggregateType(array.element, this.types))
              return this.aggregateInitial(array.element, value);
            if (referenceLike(array.element, this.types)) {
              if (value.kind !== "null") this.report("type.reference-initializer", {}, value.span);
              return null;
            }
            const info = this.expression(value, array.element);
            if (!info) return this.defaultValue(array.element);
            if (!this.assignment(array.element, info, value.span) || info.constant === undefined) {
              this.report("type.invalid-constant", {}, value.span);
              return this.defaultValue(array.element);
            }
            const base = this.base(array.element);
            return isLongType(base) && info.dataType !== base
              ? (convertValue(
                  `${info.dataType}_TO_${base}` as ConversionFunction,
                  info.constant,
                ) as InitialValue)
              : coerceValue(base, info.constant);
          });
          if (result.length + count * values.length > arraySize(array)) {
            this.report("type.invalid-constant", {}, node.span);
            continue;
          }
          for (let i = 0; i < count; i++)
            result.push(...(cloneInitialValue(values) as InitialValue[]));
        }
    }
    while (result.length < arraySize(array))
      result.push(
        isAggregateType(array.element, this.types)
          ? this.aggregateInitial(array.element)
          : (this.defaultValue(array.element) as InitialValue),
      );
    return result;
  }

  private descriptor(
    name: AST.Identifier,
    range?: AST.Subrange,
    stringLength?: number,
    array?: AST.ArrayDeclaration,
    reference?: AST.TypeSyntax,
  ): TypeDescriptor | undefined {
    if (reference) {
      const fail = () => {
        this.failedReferenceTypes.add(name);
        this.failedReferenceTargets.add(reference);
        return undefined;
      };
      if (this.failedReferenceTargets.has(reference)) return fail();
      if (!reference.reference && !reference.array && isBlock(reference.typeName.key)) {
        this.report("type.invalid-reference-target", {}, reference.typeName.span);
        return fail();
      }
      const target: TypeDescriptor | undefined =
        !reference.reference &&
        !reference.array &&
        !reference.subrange &&
        reference.stringLength === undefined &&
        this.blockIds.has(reference.typeName.key)
          ? {
              kind: "functionBlock",
              name: reference.typeName.key,
              block: this.blockIds.get(reference.typeName.key)!,
            }
          : this.descriptor(
              reference.typeName,
              reference.subrange,
              reference.stringLength,
              reference.array,
              reference.reference,
            );
      if (!target) {
        if (!this.failedReferenceTypes.has(reference.typeName)) {
          let leaf = reference;
          while (leaf.reference || leaf.array) leaf = (leaf.reference ?? leaf.array)!;
          this.report("decl.unknown-type", { name: leaf.typeName.name }, leaf.typeName.span);
        }
        return fail();
      }
      const seen = new Set<TypeDescriptor>();
      const valid = (type: TypeDescriptor): boolean => {
        if (seen.has(type)) return true;
        seen.add(type);
        const a = arrayType(type, this.types);
        const r = referenceType(type, this.types);
        return a
          ? !a.dimensions.includes("*") && valid(a.element)
          : r
            ? valid(r.target)
            : !interfaceType(type, this.types) &&
              !(
                typeof type === "object" &&
                type.kind === "functionBlock" &&
                !this.blockIds.has(type.name)
              );
      };
      if (!valid(target)) {
        this.report("type.invalid-reference-target", {}, reference.typeName.span);
        return fail();
      }
      return { kind: "reference", target };
    }
    if (array) {
      const descriptor = this.arrayDeclaration(array);
      if (!descriptor && this.failedReferenceTypes.has(array.typeName))
        this.failedReferenceTypes.add(name);
      return descriptor;
    }
    const key = declarationType(name.key);
    let type: TypeDescriptor;
    if (isScalar(key)) type = key;
    else {
      const entry = this.types.find((entry) => entry.name.toUpperCase() === key);
      if (!entry) return undefined;
      type = { kind: "named", name: entry.name };
    }
    if (key === "STRING" || key === "WSTRING") {
      const length = stringLength ?? DEFAULT_STRING_LENGTH;
      if (!Number.isInteger(length) || length < 1 || length > MAX_STRING_LENGTH) {
        this.report("type.invalid-constant", {}, name.span);
        return type;
      }
      type = { kind: "string", base: key, length };
    } else if (stringLength !== undefined) {
      this.report("type.invalid-constant", {}, name.span);
      return type;
    } else if (key === "CHAR" || key === "WCHAR") type = { kind: "character", base: key };
    if (range && (isAggregateType(type, this.types) || referenceLike(type, this.types))) {
      this.report("type.invalid-constant", {}, range.span);
      return undefined;
    }
    if (!range || this.collectingDeclarations) return type;
    const base = this.base(type, this.types);
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

  private defaultValue(type: TypeDescriptor): ScalarValue | null {
    if (referenceLike(type, this.types)) return null;
    if (isAggregateType(type, this.types)) return 0;
    if (typeof type !== "string" && type.kind === "named")
      return typeEntry(type, this.types).initialValue as ScalarValue;
    const range = subrangeType(type, this.types);
    if (range) return range.lower;
    const base = this.base(type, this.types);
    return isCharacterType(base)
      ? base === "CHAR" || base === "WCHAR"
        ? "\0"
        : ""
      : isLongType(base)
        ? "0"
        : base === "BOOL"
          ? false
          : 0;
  }

  private aggregate(info: ExpressionInfo): boolean {
    return isAggregateType(info.descriptor ?? info.dataType, this.types);
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

  private sameExternalType(left: TypeDescriptor, right: TypeDescriptor): boolean {
    const a = arrayType(left, this.types),
      b = arrayType(right, this.types);
    if (a || b)
      return (
        !!a &&
        !!b &&
        JSON.stringify(a.dimensions) === JSON.stringify(b.dimensions) &&
        this.sameExternalType(a.element, b.element)
      );
    if (typeof left !== "string" && left.kind === "functionBlock")
      return (
        typeof right !== "string" && right.kind === "functionBlock" && left.name === right.name
      );
    return sameScalarType(left, right, this.types);
  }
  private declare(declaration: AST.Declaration): void {
    const descriptor = this.descriptor(
      declaration.typeName,
      declaration.subrange,
      declaration.stringLength,
      declaration.array,
      declaration.reference,
    );
    if (declaration.array && this.unsupportedBlockArrays.has(declaration.array)) return;
    const element = descriptor && arrayType(descriptor, this.types)?.element;
    const type =
      element && typeof element !== "string" && element.kind === "functionBlock"
        ? element.name
        : descriptor
          ? this.base(descriptor, this.types)
          : declarationType(declaration.typeName.key);
    const userBlock = this.blockIds.get(type);
    const block = isBlock(type) || userBlock !== undefined;
    if (
      userBlock !== undefined &&
      this.pous.get(type)?.abstract &&
      declaration.section !== "VAR_EXTERNAL"
    )
      this.report(
        "inheritance.abstract-instance",
        { name: declaration.typeName.name },
        declaration.typeName.span,
      );
    const known = isScalar(type) || block;
    if (
      hasOpenDimensions(declaration.array) &&
      (declaration.section !== "VAR_IN_OUT" || hasOpenDimensions(declaration.array?.array))
    )
      this.report("decl.open-array-section", {}, declaration.span);
    if (descriptor && leafCount(descriptor, this.types) > 10000)
      this.report("type.invalid-constant", {}, declaration.span);
    if (
      declaration.constant &&
      (block ||
        (descriptor &&
          (isAggregateType(descriptor, this.types) || referenceLike(descriptor, this.types))))
    )
      this.report("decl.constant-type", {}, declaration.typeName.span);
    if ((declaration.retain || declaration.nonRetain) && declaration.address)
      this.report("decl.retention-address", {}, declaration.address.span);
    if (declaration.constant && declaration.address)
      this.report("decl.constant-address", {}, declaration.address.span);
    if (declaration.section === "VAR_IN_OUT" && declaration.initializer)
      this.report(
        "decl.in-out-initializer",
        { name: declaration.names[0].name },
        declaration.initializer.span,
      );
    if (block && declaration.section && declaration.section !== "VAR_EXTERNAL")
      this.report(
        "fb.invalid-instance-section",
        { name: declaration.names[0].name },
        declaration.typeName.span,
      );
    if (this.ast.kind === "function" && block)
      this.report("pou.function-block-in-function", {}, declaration.typeName.span);
    if (!known && !this.failedReferenceTypes.has(declaration.typeName))
      this.report(
        "decl.unknown-type",
        { name: declaration.typeName.name },
        declaration.typeName.span,
      );
    if (declaration.address) {
      const address = declaration.address;
      if (declaration.section === "VAR_TEMP") this.report("decl.temp-address", {}, address.span);
      if (
        this.ast.kind === "program" &&
        (declaration.section === "VAR_INPUT" || declaration.section === "VAR_OUTPUT")
      )
        this.report("decl.parameter-address", {}, address.span);
      if (this.ast.kind !== "program") this.report("pou.direct-address", {}, address.span);
      if (declaration.names.length > 1) this.report("decl.at-multiple-names", {}, address.span);
      if (!validDirectAddress(address))
        this.report("decl.address-out-of-range", { address: address.text }, address.span);
      if (
        known &&
        (declaration.subrange ||
          !addressBinds(address, descriptor ? resolveType(descriptor, this.types) : type))
      )
        this.report(
          "decl.direct-address-type",
          { name: declaration.names[0].name, type },
          address.span,
        );
    }
    if (declaration.section === "VAR_EXTERNAL") {
      if (declaration.initializer || declaration.address)
        this.report(
          "global.external-initializer",
          { name: declaration.names[0].name },
          declaration.span,
        );
      for (const name of declaration.names) {
        if (this.declaredNames.has(name.key)) {
          this.report("decl.duplicate", { name: name.name }, name.span);
          continue;
        }
        this.declaredNames.add(name.key);
        const global = this.globals?.symbols.find((s) => s.name.key === name.key);
        const constant = this.globals?.constants.get(name.key);
        if (!global && !constant) {
          this.report("global.not-found", { name: name.name }, name.span);
          continue;
        }
        if (!!declaration.constant !== !!constant)
          this.report("global.constant-mismatch", { name: name.name }, name.span);
        if (constant) this.constants.set(name.key, { ...constant, name });
        else if (global) {
          const symbol = { ...global, id: this.symbols.length, name, external: name.key };
          this.symbols.push(symbol);
          this.names.set(name.key, symbol);
          this.references.set(name, { variable: symbol.id });
        }
      }
      return;
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
      } else if (isFunction(name.key) || isReservedStandardName(name.key)) {
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
    if (declaration.section === "VAR_EXTERNAL") {
      const descriptor = this.descriptor(
        declaration.typeName,
        declaration.subrange,
        declaration.stringLength,
        declaration.array,
        declaration.reference,
      );
      for (const name of declaration.names) {
        const global = this.globals?.symbols.find((s) => s.name.key === name.key);
        const constant = this.globals?.constants.get(name.key);
        if (!global && !constant) continue;
        const actual = global?.descriptor ?? constant?.descriptor ?? global?.type ?? constant!.type;
        const type = declarationType(declaration.typeName.key);
        const block = isBlock(type) || this.blockIds.has(type);
        const same =
          block && !declaration.array
            ? !global?.aggregateValues && type === global?.type
            : descriptor && this.sameExternalType(descriptor, actual as TypeDescriptor);
        if (!same)
          this.report("global.type-mismatch", { name: name.name }, declaration.typeName.span);
      }
      return;
    }
    const descriptor = this.descriptor(
      declaration.typeName,
      declaration.subrange,
      declaration.stringLength,
      declaration.array,
      declaration.reference,
    );
    if (declaration.array && !descriptor) return;
    for (const name of declaration.names) {
      const symbol = this.names.get(name.key),
        constant = this.constants.get(name.key);
      if (descriptor && symbol?.name === name) {
        symbol.descriptor = descriptor;
        symbol.initialValue = this.defaultValue(descriptor);
      }
      if (descriptor && constant?.name === name) constant.descriptor = descriptor;
    }
    if (descriptor && isAggregateType(descriptor, this.types)) {
      const element = arrayType(descriptor, this.types)?.element;
      const block = element && typeof element !== "string" && element.kind === "functionBlock";
      if (block && declaration.initializer)
        this.report(
          "decl.fb-initializer",
          { name: declaration.names[0].name },
          declaration.initializer.span,
        );
      const values = block
        ? Array.from({ length: arraySize(arrayType(descriptor, this.types)!) }, () => 0)
        : this.aggregateInitial(descriptor, declaration.initializer);
      for (const name of declaration.names) {
        const symbol = this.names.get(name.key);
        if (symbol?.name === name) symbol.aggregateValues = cloneInitialValue(values);
      }
      return;
    }
    const value = declaration.initializer;
    if (descriptor && referenceLike(descriptor, this.types)) {
      if (value && value.kind !== "null") this.report("type.reference-initializer", {}, value.span);
      return;
    }
    if (!value) {
      for (const name of declaration.names) {
        const constant = this.constants.get(name.key);
        if (constant?.name === name)
          constant.value = this.defaultValue(constant.descriptor ?? constant.type) as ScalarValue;
      }
      return;
    }
    const type = descriptor
      ? this.base(descriptor, this.types)
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

  private memberAccessible(name: AST.Identifier): boolean {
    const owner = this.ast.owner ?? this.ast;
    const declaration = owner.declarations.find((d) => d.names.some((n) => n.key === name.key));
    if (
      declaration?.declaringType &&
      !declaration.section &&
      !accessible(declaration.access, declaration.declaringType, this.initializerOwner ?? owner)
    ) {
      this.report("access.hidden", { name: name.name }, name.span);
      return false;
    }
    return true;
  }

  private resolve(name: AST.Identifier): VariableSymbol | null {
    if (!this.memberAccessible(name)) return null;
    const symbol = this.names.get(name.key);
    if (!symbol) {
      this.report("name.undeclared", { name: name.name }, name.span);
      return null;
    }
    this.references.set(name, { variable: symbol.id });
    return symbol;
  }

  private bitIndex(type: TypeDescriptor, member: AST.Identifier): number | null {
    const index = this.constants.get(member.key);
    if (index && !this.memberAccessible(member)) return null;
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
    const base =
      isAggregateType(type, this.types) || referenceLike(type, this.types)
        ? undefined
        : scalarBase(type, this.types);
    if (!base || !isBitType(base) || base === "BOOL" || bit < 0 || bit >= bitWidths[base]) {
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
    if (reference) {
      const symbol = checked!.symbols[reference.variable];
      if (symbol?.descriptor) return symbol.descriptor;
      if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined))
        return {
          kind: "functionBlock",
          name: symbol.type,
          ...(symbol.userBlock !== undefined ? { block: symbol.userBlock } : {}),
        };
    }
    return this.descriptor(
      declaration.typeName,
      declaration.subrange,
      declaration.stringLength,
      declaration.array,
      declaration.reference,
    );
  }

  private field(type: TypeDescriptor, member: AST.Identifier): ExpressionInfo | null {
    const structure = structureType(type, this.types);
    if (structure) {
      const index = structure.members.findIndex((item) => item.name.toUpperCase() === member.key);
      if (index < 0) {
        this.report("type.unknown-structure-member", { type, member: member.name }, member.span);
        return null;
      }
      this.references.set(member, { variable: 0, member: index, structure: true });
      const descriptor = structure.members[index]!.dataType;
      return { dataType: this.base(descriptor), descriptor };
    }
    const bit = this.bitIndex(type, member);
    if (bit === null) return null;
    this.references.set(member, { variable: 0, bit });
    return { dataType: "BOOL" };
  }

  private reference(
    node: AST.AssignmentTarget,
    write = false,
    instance = false,
  ): ExpressionInfo | null {
    if (
      (node.kind === "name" && node.name.key === "SUPER") ||
      (node.kind === "member" && node.instance.key === "SUPER")
    ) {
      this.report("inheritance.super-context", {}, node.span);
      return null;
    }
    if (node.kind === "member" && node.instance.key === "THIS") {
      if (!(
        this.ast.owner ??
        (["functionBlock", "class"].includes(this.ast.kind) ? this.ast : undefined)
      )) {
        this.report("method.this-outside", {}, node.instance.span);
        return null;
      }
      const owner = this.ast.owner ?? this.ast;
      if (!owner.declarations.some((d) => d.names.some((n) => n.key === node.member.key))) {
        this.report(
          "fb.unknown-member",
          { name: "THIS", member: node.member.name },
          node.member.span,
        );
        return null;
      }
      const local: AST.NameReference = { kind: "name", name: node.member, span: node.span };
      return this.reference(local, write, instance);
    }
    if (node.kind === "name" && node.name.key === "THIS") {
      const owner =
        this.ast.owner ??
        (["class", "functionBlock"].includes(this.ast.kind) ? this.ast : undefined);
      if (owner && instance)
        return {
          dataType: "INT",
          descriptor: {
            kind: "functionBlock",
            name: owner.name.key,
            block: this.blockIds.get(owner.name.key),
          },
        };
      this.report("method.this-outside", {}, node.span);
      return null;
    }
    if (node.kind === "dereference") {
      const value = this.expression(node.reference);
      if (!value) return null;
      const ref = referenceType(value.descriptor ?? value.dataType, this.types);
      if (!ref) {
        this.report("type.invalid-reference-target", {}, node.span);
        return null;
      }
      if (!instance && typeof ref.target === "object" && ref.target.kind === "functionBlock") {
        this.report("fb.instance-as-value", { name: rootName(node).name }, node.span);
        return null;
      }
      return { dataType: this.base(ref.target), descriptor: ref.target };
    }
    if (node.kind === "field") {
      const object = this.reference(node.object, write, true);
      if (!object) return null;
      if (
        (node.object.kind === "member" || node.object.kind === "field") &&
        this.references.get(node.object.member)?.port &&
        !this.aggregate(object) &&
        !(typeof object.descriptor === "object" && object.descriptor.kind === "functionBlock")
      ) {
        this.report(
          "fb.unknown-member",
          {
            name: rootName(node.object).name,
            member: `${node.object.member.name}.${node.member.name}`,
          },
          node.member.span,
        );
        return null;
      }
      this.expressions.set(node.object, object);
      if (typeof object.descriptor !== "string" && object.descriptor?.kind === "functionBlock") {
        const type = object.descriptor;
        const symbol: VariableSymbol = {
          id: this.references.get(rootName(node.object))?.variable ?? 0,
          name: rootName(node.object),
          type: type.name,
          userBlock: this.blockIds.get(type.name),
          initialValue: null,
        };
        return this.blockMember(symbol, node.member, write);
      }
      return this.field(object.descriptor ?? object.dataType, node.member);
    }
    if (node.kind === "index") {
      const parent = this.reference(node.array, write, true);
      if (!parent) return null;
      this.expressions.set(node.array, parent);
      const parentType = parent.descriptor ?? parent.dataType;
      const array = arrayType(parentType, this.types);
      if (!array) {
        this.report("type.not-array", { type: parentType }, node.array.span);
        return null;
      }
      if (array.dimensions.length !== node.indices.length) {
        this.report(
          "type.array-index-count",
          { expected: array.dimensions.length, found: node.indices.length },
          node.span,
        );
        return null;
      }
      node.indices.forEach((index, i) => {
        const info = this.expression(index);
        if (!info) return;
        const type = info.descriptor ?? info.dataType;
        if (info.nullReference) {
          this.report("type.invalid-reference-target", {}, index.span);
          return;
        }
        if (
          !isIntegerType(info.dataType) ||
          this.enum(info) ||
          isAggregateType(type, this.types) ||
          referenceLike(type, this.types)
        ) {
          this.report("type.array-index-not-integer", { type }, index.span);
          return;
        }
        const d = array.dimensions[i]!;
        if (
          info.constant !== undefined &&
          d !== "*" &&
          (BigInt(info.constant) < BigInt(d.lower) || BigInt(info.constant) > BigInt(d.upper))
        )
          this.report("type.invalid-constant", {}, index.span);
      });
      if (
        !instance &&
        typeof array.element !== "string" &&
        array.element.kind === "functionBlock"
      ) {
        this.report("fb.instance-as-value", { name: rootName(node).name }, node.span);
        return null;
      }
      return { dataType: this.base(array.element), descriptor: array.element };
    }
    if (node.kind === "elementBit") {
      const element = this.reference(node.element, write);
      if (!element) return null;
      this.expressions.set(node.element, element);
      const bit = this.bitIndex(element.descriptor ?? element.dataType, node.member);
      if (bit === null) return null;
      this.references.set(node.member, { variable: 0, bit });
      return { dataType: "BOOL" };
    }
    const name = node.kind === "name" ? node.name : node.instance;
    const constant = this.constants.get(name.key);
    if (constant) {
      if (!this.memberAccessible(name)) return null;
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
    if (
      this.ast.owner?.declarations.some(
        (d) => d.section === "VAR_IN_OUT" && d.names.some((n) => n.key === name.key),
      )
    ) {
      this.report("method.instance-in-out", { name: name.name }, name.span);
      return null;
    }
    if (
      this.ast.owner?.declarations.some(
        (d) => d.section === "VAR_TEMP" && d.names.some((n) => n.key === name.key),
      )
    ) {
      this.report("name.undeclared", { name: name.name }, name.span);
      return null;
    }
    const symbol = this.resolve(name);
    if (!symbol) return null;
    if (node.kind === "name") {
      if (!isScalar(symbol.type) && !instance) {
        this.report("fb.instance-as-value", { name: name.name }, node.span);
        return null;
      }
      return {
        dataType: isScalar(symbol.type) ? symbol.type : "INT",
        descriptor:
          symbol.descriptor ??
          (isScalar(symbol.type) ? undefined : { kind: "functionBlock", name: symbol.type }),
      };
    }
    if (symbol.descriptor && structureType(symbol.descriptor, this.types)) {
      return this.field(symbol.descriptor, node.member);
    }
    if (
      isScalar(symbol.type) &&
      (/^\d+$/.test(node.member.key) || this.constants.has(node.member.key))
    ) {
      const bit = this.bitIndex(symbol.descriptor ?? symbol.type, node.member);
      if (bit === null) return null;
      this.references.set(node.member, { variable: symbol.id, bit });
      return { dataType: "BOOL" };
    }
    if (symbol.descriptor && arrayType(symbol.descriptor, this.types)) {
      this.report("fb.not-function-block", { name: name.name }, name.span);
      return null;
    }
    return this.blockMember(symbol, node.member, write, name);
  }

  private blockMember(
    symbol: VariableSymbol,
    member: AST.Identifier,
    write: boolean,
    name = symbol.name,
  ): ExpressionInfo | null {
    if (symbol.userBlock !== undefined) {
      const pou = this.pous.get(symbol.type)!;
      const parameters = pou.declarations
        .filter((declaration) => !declaration.constant)
        .flatMap((declaration) =>
          declaration.names.map((member) => ({
            name: member,
            type: this.parameterType(pou, declaration),
            section: declaration.section,
            access: declaration.access ?? "PROTECTED",
            declaringType: declaration.declaringType ?? pou,
          })),
        );
      const index = parameters.findIndex(
        (parameter) =>
          parameter.name.key === member.key &&
          !["VAR_TEMP", "VAR_IN_OUT", "VAR_EXTERNAL"].includes(parameter.section ?? ""),
      );
      const parameter = parameters[index];
      if (!parameter?.type) {
        this.report("fb.unknown-member", { name: name.name, member: member.name }, member.span);
        return null;
      }
      if (
        !parameter.section &&
        !accessible(parameter.access, parameter.declaringType, this.ast.owner ?? this.ast)
      ) {
        this.report("fb.unknown-member", { name: name.name, member: member.name }, member.span);
        return null;
      }
      if (write && parameter.section === "VAR_OUTPUT")
        this.report(
          "fb.output-not-writable",
          { name: name.name, member: member.name },
          member.span,
        );
      this.references.set(member, {
        variable: symbol.id,
        member: index,
        port: parameter.section === "VAR_OUTPUT" ? "output" : "input",
        userBlock: true,
      });
      return { dataType: this.base(parameter.type, this.types), descriptor: parameter.type };
    }
    if (!isBlock(symbol.type)) {
      this.report("fb.not-function-block", { name: name.name }, name.span);
      return null;
    }
    const descriptor = blocks[symbol.type];
    for (const port of ["inputs", "outputs"] as const) {
      const index = descriptor[port].findIndex(([key]) => key === member.key);
      if (index < 0) continue;
      if (write && port === "outputs")
        this.report(
          "fb.output-not-writable",
          { name: name.name, member: member.name },
          member.span,
        );
      this.references.set(member, {
        variable: symbol.id,
        port: port === "inputs" ? "input" : "output",
        member: index,
      });
      return { dataType: descriptor[port][index]![1] };
    }
    this.report("fb.unknown-member", { name: name.name, member: member.name }, member.span);
    return null;
  }

  private expression(node: AST.Expression, expected?: TypeDescriptor): ExpressionInfo | null {
    const expectedBase = expected ? this.base(expected, this.types) : undefined;
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
    if (
      expected &&
      interfaceType(expected, this.types) &&
      ["name", "member", "field", "index", "dereference"].includes(node.kind)
    ) {
      const value = this.reference(node as AST.AssignmentTarget, false, true);
      if (
        value &&
        typeof value.descriptor === "object" &&
        value.descriptor.kind === "functionBlock"
      ) {
        const root = rootName(node as AST.AssignmentTarget);
        const declaration = (this.ast.owner?.declarations ?? [])
          .concat(this.ast.declarations)
          .find((d) => d.names.some((n) => n.key === root.key));
        if (
          node.kind !== "dereference" &&
          root.key !== "THIS" &&
          (!declaration ||
            declaration.constant ||
            ["VAR_TEMP", "VAR_IN_OUT"].includes(declaration.section ?? "") ||
            (this.ast.kind === "function" &&
              !this.ast.owner &&
              declaration.section !== "VAR_EXTERNAL"))
        ) {
          this.report("interface.lifetime", {}, node.span);
          return null;
        }
        value.interfaceValue = expected;
        this.expressions.set(node, value);
        return value;
      }
    }
    switch (node.kind) {
      case "null":
        info = {
          dataType: "INT",
          descriptor:
            expected && referenceType(expected, this.types)
              ? expected
              : { kind: "reference", target: "BOOL" },
          nullReference: true,
        };
        break;
      case "dereference":
        info = this.reference(node);
        break;
      case "structureInitializer":
      case "arrayInitializer":
        this.report("type.invalid-constant", {}, node.span);
        return null;
      case "literal": {
        if (node.literalKind === "string") {
          const quote = node.text[node.dataType ? node.text.indexOf("#") + 1 : 0];
          const wide = quote === '"';
          const contextual =
            expectedBase &&
            isCharacterType(expectedBase) &&
            isWideCharacterType(expectedBase) === wide
              ? expectedBase
              : undefined;
          const dataType = node.dataType ?? contextual ?? (wide ? "WSTRING" : "STRING");
          try {
            if (!isCharacterType(dataType) || isWideCharacterType(dataType) !== wide)
              throw new RangeError("Mismatched literal delimiter");
            validateValue(dataType, node.value);
            info = { dataType, constant: node.value, untyped: !node.dataType };
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            this.report("type.invalid-constant", {}, node.span);
            return null;
          }
          break;
        }
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
      case "index":
      case "elementBit":
      case "field":
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
        const dataType =
          this.enum(operand) ||
          referenceLike(operand.descriptor ?? operand.dataType, this.types) ||
          (operand.descriptor && isAggregateType(operand.descriptor, this.types))
            ? null
            : unaryType(node.operator, operand.dataType);
        if (!dataType) {
          if (operand.nullReference) {
            this.report("type.invalid-reference-target", {}, node.span);
            return null;
          }
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
            : () =>
                unaryConstant(node.operator, internalValue(operand.dataType, operand.constant!)),
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
        const li = interfaceType(left.descriptor ?? left.dataType, this.types),
          ri = interfaceType(right.descriptor ?? right.dataType, this.types);
        if (li || ri) {
          if (
            !["=", "<>"].includes(node.operator) ||
            !(li || left.nullReference) ||
            !(ri || right.nullReference)
          ) {
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
          info = { dataType: "BOOL" };
          break;
        }
        const lr = referenceType(left.descriptor ?? left.dataType, this.types),
          rr = referenceType(right.descriptor ?? right.dataType, this.types);
        if (lr || rr) {
          if (
            !lr ||
            !rr ||
            !["=", "<>"].includes(node.operator) ||
            (!left.nullReference &&
              !right.nullReference &&
              !(this.referenceAssignable(lr, rr) || this.referenceAssignable(rr, lr)))
          ) {
            if (left.nullReference || right.nullReference) {
              this.report("type.invalid-reference-target", {}, node.span);
              return null;
            }
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
          info = { dataType: "BOOL" };
          break;
        }
        const enums = this.enum(left) || this.enum(right);
        const dataType =
          (left.descriptor && isAggregateType(left.descriptor, this.types)) ||
          (right.descriptor && isAggregateType(right.descriptor, this.types))
            ? null
            : enums
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
            ? internalValue(
                common,
                convertValue(
                  `${operand.dataType}_TO_${common}` as ConversionFunction,
                  operand.constant!,
                ),
              )
            : internalValue(operand.dataType, operand.constant!);
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

  /** Original typed neighbors supply a type only to whole untyped numeric constants.
   * Quoted literals keep their default STRING/WSTRING type in operand positions.
   * Defaults chosen for other constants never influence this contextual type. TIME scaling
   * has independent operand types, so its numeric factor uses the default. */
  private operands(
    nodes: AST.Expression[],
    independent = false,
    defaultExpected?: TypeDescriptor,
  ): (ExpressionInfo | null)[] {
    const deferred = (node: AST.Expression): boolean =>
      isUntyped(node) ||
      (node.kind === "literal" && node.literalKind === "string" && !node.dataType) ||
      (node.kind === "group" && deferred(node.expression)) ||
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
    // A failed expression is null too; keep deferred operands separate so a
    // failed subtree is never checked again while selecting an enum context.
    const pending = new Set(nodes.flatMap((node, index) => (deferred(node) ? [index] : [])));
    const infos = nodes.map((node, index) =>
      pending.has(index) ? null : this.expression(node, context),
    );
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
        return pending.has(index) ? this.expression(node, enumExpected) : infos[index]!;
      });
    independent = independent && (infos[0]?.dataType === "TIME" || infos[0]?.dataType === "LTIME");
    const common = commonType(infos.filter((info) => info !== null).map((info) => info.dataType));
    for (const index of pending) {
      const node = nodes[index]!;
      const characterLiteral = (value: AST.Expression): boolean =>
        value.kind === "group"
          ? characterLiteral(value.expression)
          : value.kind === "literal" && value.literalKind === "string" && !value.dataType;
      if (characterLiteral(node)) {
        infos[index] = this.expression(node);
        pending.delete(index);
        continue;
      }
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

  private referenceOf(node: AST.FunctionCall): ExpressionInfo | null {
    const invalid = (): null => {
      this.report("type.invalid-reference-target", {}, node.span);
      return null;
    };
    if (node.args.length !== 1 || node.inputNames || node.outputs) return invalid();
    const target = node.args[0]!;
    if (!["name", "member", "field", "index"].includes(target.kind)) return invalid();
    const access = target as AST.AssignmentTarget;
    const noDereference = (value: AST.AssignmentTarget): boolean =>
      value.kind === "dereference"
        ? false
        : value.kind === "index"
          ? noDereference(value.array)
          : value.kind === "field"
            ? noDereference(value.object)
            : true;
    if (!noDereference(access)) return invalid();
    let root = access;
    while (root.kind === "field" || root.kind === "index")
      root = root.kind === "field" ? root.object : root.array;
    const name =
      root.kind === "member" && root.instance.key === "THIS" ? root.member : rootName(root);
    const declaration = (this.ast.owner?.declarations ?? [])
      .concat(this.ast.declarations)
      .find((d) => d.names.some((n) => n.key === name.key));
    const owner =
      this.ast.owner ?? (["class", "functionBlock"].includes(this.ast.kind) ? this.ast : undefined);
    if (
      !(name.key === "THIS" && owner) &&
      (!declaration ||
        declaration.constant ||
        declaration.section === "VAR_TEMP" ||
        declaration.section === "VAR_IN_OUT" ||
        (this.ast.kind === "function" && this.ast.declarations.includes(declaration)))
    )
      return invalid();
    const info = this.reference(access, false, true);
    if (!info) return null;
    const selector =
      access.kind === "member" || access.kind === "field"
        ? this.references.get(access.member)
        : undefined;
    if (selector?.bit !== undefined) return invalid();
    const type = info.descriptor ?? info.dataType;
    if (typeof type !== "string" && type.kind === "functionBlock" && !this.blockIds.has(type.name))
      return invalid();
    this.expressions.set(access, info);
    return { dataType: "INT", descriptor: { kind: "reference", target: type } };
  }

  private functionCall(
    node: AST.FunctionCall,
    statement = false,
    expectedType?: TypeDescriptor,
  ): ExpressionInfo | null {
    if (node.name.key === "SUPER") {
      this.report("inheritance.super-body", {}, node.span);
      return null;
    }
    if (node.name.key === "THIS") {
      this.report("method.this-call", {}, node.span);
      return null;
    }
    const owner =
      this.ast.owner ?? (["functionBlock", "class"].includes(this.ast.kind) ? this.ast : undefined);
    if (node.receiver || owner?.methods?.some((m) => m.name.key === node.name.key))
      return this.methodCall(node, statement, owner);
    if (node.name.key === "REF") {
      if (statement) {
        this.report("type.invalid-reference-target", {}, node.span);
        return null;
      }
      return this.referenceOf(node);
    }
    if (node.name.key === "LOWER_BOUND" || node.name.key === "UPPER_BOUND")
      return this.arrayBound(node);
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
    const enumContext =
      expectedType && enumerationType(expectedType, this.types) ? expectedType : undefined;
    // Preserve independent expression errors and the enclosing enum context on rejection.
    const rejectCall = (): null => {
      for (const argument of node.args) this.expression(argument, enumContext);
      return null;
    };
    const seenOutputs = new Set<number>();
    for (const output of node.outputs ?? []) {
      const port = signature.outputs?.findIndex(([name]) => name === output.name.key) ?? -1;
      if (port < 0 || seenOutputs.has(port)) {
        invalidParameter(output.name);
        return rejectCall();
      }
      seenOutputs.add(port);
    }
    if (node.inputNames) {
      const ordered = new Map<number, AST.Expression>();
      let minimum = signature.min;
      for (const [index, parameter] of node.inputNames.entries()) {
        let port = signature.inputNames?.indexOf(parameter.key) ?? -1;
        if (port < 0 && signature.max === null) {
          const numbered = /^IN(0|[1-9][0-9]*)$/.exec(parameter.key);
          const last = /^IN([0-9]+)$/.exec(signature.inputNames?.at(-1) ?? "");
          if (
            numbered &&
            last &&
            Number.isSafeInteger(Number(numbered[1])) &&
            Number(numbered[1]) > Number(last[1])
          )
            port = signature.inputNames!.length - 1 + (Number(numbered[1]) - Number(last[1]));
        }
        if (port < 0 || !Number.isSafeInteger(port + 1) || ordered.has(port)) {
          invalidParameter(parameter);
          return rejectCall();
        }
        ordered.set(port, node.args[index]!);
        minimum = Math.max(minimum, port + 1);
      }
      // Check gaps before constructing the list, even for very large numbered inputs.
      if (ordered.size !== minimum) {
        this.report(
          "call.argument-count",
          { name: node.name.name, min: minimum, max: signature.max, found: ordered.size },
          node.span,
        );
        return rejectCall();
      }
      inputs.splice(
        0,
        inputs.length,
        ...Array.from({ length: ordered.size }, (_, index) => ordered.get(index)!),
      );
    }
    this.functionArguments.set(node, inputs);
    for (const output of node.outputs ?? []) {
      const port = signature.outputs!.findIndex(([name]) => name === output.name.key);
      const target = this.reference(output.target, true);
      if (!target) return rejectCall();
      this.expressions.set(output.target, target);
      if (
        !this.assignment(
          target.descriptor ?? target.dataType,
          { dataType: signature.outputs![port]![1] },
          output.target.span,
        )
      )
        return rejectCall();
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
      return rejectCall();
    }
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
    const inputArgs =
      start === undefined
        ? inputs.map(parameter)
        : [
            ...inputs.slice(0, start).map(parameter),
            ...this.operands(
              inputs.slice(start, signature.genericEnd),
              false,
              realGroup ? "LREAL" : enumContext,
            ),
            ...inputs
              .slice(signature.genericEnd ?? inputs.length)
              .map((arg, index) => parameter(arg, index + (signature.genericEnd ?? inputs.length))),
          ];
    const args = inputArgs.map((arg, index) => {
      if (!arg) return null;
      const accepted = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
      return { ...arg, dataType: stringArgumentType(arg.dataType, accepted) };
    });
    const reference =
      args.find(
        (arg) =>
          arg && !arg.nullReference && referenceLike(arg.descriptor ?? arg.dataType, this.types),
      ) ?? args.find((arg) => arg?.nullReference);
    if (reference) {
      if (!["MOVE", "SEL", "MUX"].includes(name)) {
        this.report("type.invalid-reference-target", {}, node.span);
        return null;
      }
      const firstValue = name === "MOVE" ? 0 : 1;
      if (
        reference.nullReference &&
        args.slice(firstValue).some((arg) => arg && !arg.nullReference)
      ) {
        this.report("type.invalid-reference-target", {}, node.span);
        return null;
      }
      const descriptor =
        reference.nullReference && expectedType && referenceType(expectedType, this.types)
          ? expectedType
          : reference.descriptor!;
      let valid = args.every((arg) => arg !== null);
      args.forEach((arg, index) => {
        if (!arg) return;
        const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
        const accepted =
          index >= firstValue
            ? arg.nullReference ||
              sameScalarType(descriptor, arg.descriptor ?? arg.dataType, this.types)
            : !referenceLike(arg.descriptor ?? arg.dataType, this.types) &&
              !isAggregateType(arg.descriptor ?? arg.dataType, this.types) &&
              !this.enum(arg) &&
              expected.includes(arg.dataType);
        if (!accepted) {
          valid = false;
          if (arg.nullReference)
            this.report("type.invalid-reference-target", {}, inputs[index]!.span);
          else
            this.report(
              "call.argument-type",
              {
                name,
                index,
                expected: index >= firstValue ? [descriptor] : expected,
                found: arg.descriptor ?? arg.dataType,
              },
              inputs[index]!.span,
            );
        }
      });
      if (!valid) return null;
      return {
        dataType: "INT",
        descriptor,
        ...(args.slice(firstValue).every((arg) => arg?.nullReference)
          ? { nullReference: true }
          : {}),
      };
    }
    const aggregate = args.find(
      (arg) => arg?.descriptor && isAggregateType(arg.descriptor, this.types),
    );
    if (aggregate) {
      const firstValue = name === "SEL" || name === "MUX" ? 1 : 0;
      let valid = args.every((arg) => arg !== null);
      args.forEach((arg, index) => {
        if (!arg) return;
        const accepted =
          ["MOVE", "SEL", "MUX"].includes(name) && index >= firstValue
            ? sameScalarType(aggregate.descriptor!, arg.descriptor ?? arg.dataType, this.types)
            : !isAggregateType(arg.descriptor ?? arg.dataType, this.types) &&
              !this.enum(arg) &&
              signature.arguments[Math.min(index, signature.arguments.length - 1)]!.includes(
                arg.dataType,
              );
        if (!accepted) {
          valid = false;
          this.report(
            "call.argument-type",
            {
              name,
              index,
              expected: [aggregate.descriptor!],
              found: arg.descriptor ?? arg.dataType,
            },
            inputs[index]!.span,
          );
        }
      });
      if (!valid) return null;
      return ["MOVE", "SEL", "MUX"].includes(name)
        ? { dataType: "INT", descriptor: aggregate.descriptor }
        : null;
    }
    const enumeration = args.find((arg) => arg && this.enum(arg));
    if (enumeration) {
      const firstValue = name === "SEL" || name === "MUX" ? 1 : 0;
      let valid = args.every((arg) => arg !== null);
      args.forEach((arg, index) => {
        if (!arg) return;
        const enumValue = ["MOVE", "SEL", "MUX"].includes(name) && index >= firstValue;
        const expected = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
        const accepted = enumValue
          ? sameScalarType(enumeration.descriptor!, arg.descriptor ?? arg.dataType, this.types)
          : !this.enum(arg) && expected.includes(arg.dataType);
        if (!accepted) {
          valid = false;
          this.report(
            "call.argument-type",
            {
              name,
              index,
              expected: enumValue ? [enumeration.descriptor!] : expected,
              found: arg.descriptor ?? arg.dataType,
            },
            inputs[index]!.span,
          );
        }
      });
      if (!valid) return null;
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
      if (!validArguments) return null;
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
      if (arg && (isCharacterType(arg.dataType) || isCharacterType(signature.result)))
        return { dataType: signature.result };
      return this.constant(
        { dataType: signature.result },
        node,
        arg?.constant === undefined || inputs.length !== 1
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
      return arg && validArguments ? { dataType: arg.dataType } : null;
    }
    const values = args.flatMap((arg, index) =>
      arg && index >= (start ?? 0) && index < (signature.genericEnd ?? args.length)
        ? [{ ...arg, index }]
        : [],
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
    if (dataType && validArguments && name === "NOT") {
      const operand = args[0]!;
      return this.constant(
        { dataType },
        node,
        operand.constant === undefined
          ? undefined
          : () => unaryConstant("NOT", internalValue(operand.dataType, operand.constant!)),
      );
    }
    return dataType && validArguments ? { dataType: signature.result ?? dataType } : null;
  }

  private arrayBound(node: AST.FunctionCall): ExpressionInfo | null {
    if (node.args.length !== 2) {
      this.report(
        "call.argument-count",
        { name: node.name.name, min: 2, max: 2, found: node.args.length },
        node.span,
      );
      return null;
    }
    const args = node.inputNames
      ? [
          node.args[node.inputNames.findIndex((n) => n.key === "IN")],
          node.args[node.inputNames.findIndex((n) => n.key === "DIM")],
        ]
      : node.args;
    for (const parameter of [
      ...(node.inputNames ?? []),
      ...(node.outputs ?? []).map((o) => o.name),
    ])
      if (!["IN", "DIM"].includes(parameter.key) || node.outputs?.some((o) => o.name === parameter))
        this.report(
          "call.invalid-parameter",
          { name: node.name.name, parameter: parameter.name },
          parameter.span,
        );
    const [value, dim] = args;
    if (!value || !dim) {
      this.report(
        "call.invalid-parameter",
        { name: node.name.name, parameter: node.name.name },
        node.span,
      );
      return null;
    }
    const info = this.expression(value);
    const dimension = this.expression(dim);
    const type = info?.descriptor ?? info?.dataType;
    const array = type && arrayType(type, this.types);
    if (!array) {
      if (type) this.report("type.not-array", { type }, value.span);
      return null;
    }
    if (
      !dimension ||
      !isIntegerType(dimension.dataType) ||
      this.enum(dimension) ||
      this.aggregate(dimension) ||
      dimension.constant === undefined ||
      BigInt(dimension.constant) < 1n ||
      BigInt(dimension.constant) > BigInt(array.dimensions.length)
    ) {
      this.report("type.invalid-constant", {}, dim.span);
      return null;
    }
    this.arrayBounds.set(node, {
      array: value,
      dimension: Number(dimension.constant) - 1,
      upper: node.name.key === "UPPER_BOUND",
    });
    return { dataType: "DINT" };
  }

  private methodCall(
    node: AST.FunctionCall,
    statement: boolean,
    owner?: AST.Program,
  ): ExpressionInfo | null {
    let target = owner;
    let receiver = node.receiver;
    const superCall = receiver?.kind === "name" && receiver.name.key === "SUPER";
    if (superCall) {
      receiver = undefined;
      target = owner?.baseType;
      if (!target) {
        this.report("inheritance.super-context", {}, node.span);
        return null;
      }
    } else if (receiver?.kind === "name" && receiver.name.key === "THIS") {
      receiver = undefined;
      if (!owner) {
        this.report("method.this-outside", {}, node.span);
        return null;
      }
      const symbol = this.names.get(node.name.key);
      if (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined)) {
        this.report("fb.call-in-expression", { name: node.name.name }, node.span);
        return null;
      }
    } else if (receiver) {
      const info = this.reference(receiver, false, true);
      if (info) this.expressions.set(receiver, info);
      const type =
        info?.descriptor && (interfaceType(info.descriptor, this.types) ?? info.descriptor);
      target =
        typeof type === "object" && (type.kind === "functionBlock" || type.kind === "interface")
          ? this.pous.get(type.name)
          : undefined;
    }
    const index = target?.methods?.findIndex((m) => m.name.key === node.name.key) ?? -1;
    const method = index < 0 ? undefined : target?.methods?.[index];
    if (superCall && (!method || method.abstract || method.access === "PRIVATE")) {
      this.report("inheritance.super-method", { name: node.name.name }, node.name.span);
      return null;
    }
    if (!target || !method) {
      this.report("method.unknown", { name: node.name.name }, node.name.span);
      return null;
    }
    if (!accessible(method.access, method.owner ?? target, owner ?? this.ast)) {
      this.report("access.hidden", { name: node.name.name }, node.name.span);
      return null;
    }
    const info = this.userFunctionCall(node, method, statement);
    const call = this.userCalls.get(node)!;
    call.function = index;
    call.method = {
      block: target.kind === "interface" ? -1 : this.blockIds.get(target.name.key)!,
      ...(receiver ? { receiver } : {}),
      ...(superCall ? { static: true } : {}),
    };
    if (target.kind === "interface") {
      call.method.interface = target.name.key;
      return info;
    }
    const offset = this.interfaces.get(method.owner ?? target)?.symbols.length ?? 0;
    for (const parameter of [...call.inputs, ...call.outputs, ...call.inOuts])
      parameter.variable += offset;
    return info;
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
        this.descriptor(
          pou.resultType,
          pou.resultSubrange,
          pou.resultStringLength,
          pou.resultArray,
          pou.resultReference,
        ) ??
        null)
      : null;
    if (!statement && result === null)
      this.report("call.no-result", { name: node.name.name }, node.span);
    const call: UserCallInfo = {
      function: this.functionIds.get(pou.name.key)!,
      inputs: [],
      outputs: [],
      inOuts: [],
      result: result ? this.base(result, this.types) : null,
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
          dataType: this.base(type, this.types),
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
            { dataType: this.base(parameter.type, this.types), descriptor: parameter.type },
            output.target.span,
          );
          call.outputs.push({ variable: parameter.variable, target: output.target });
        }
      }
    }
    this.requireInOuts(inOuts, seen, node);
    if (result === null) return statement ? { dataType: "BOOL" } : null;
    return { dataType: this.base(result, this.types), descriptor: result };
  }

  private inOutActual(value: AST.Expression, type: TypeDescriptor): value is AST.AssignmentTarget {
    if (!["name", "member", "field", "index", "dereference"].includes(value.kind)) {
      this.report("call.in-out-variable", {}, value.span);
      return false;
    }
    const actual = value as AST.AssignmentTarget;
    const info = this.reference(actual, true);
    if (!info) return false;
    const forbiddenSelector = (node: AST.AssignmentTarget): boolean => {
      if (node.kind === "name") return false;
      if (node.kind === "index") return forbiddenSelector(node.array);
      if (node.kind === "dereference") return false;
      if (node.kind === "elementBit") return true;
      const selector = this.references.get(node.member);
      return (
        !!selector?.port ||
        selector?.bit !== undefined ||
        (node.kind === "field" && forbiddenSelector(node.object))
      );
    };
    if (forbiddenSelector(actual)) {
      this.report("call.in-out-variable", {}, value.span);
      return false;
    }
    this.expressions.set(value, info);
    const formalArray = arrayType(type, this.types);
    const actualArray = arrayType(info.descriptor ?? info.dataType, this.types);
    const matches = formalArray?.dimensions.every((d) => d === "*")
      ? !!actualArray &&
        actualArray.dimensions.length === formalArray.dimensions.length &&
        sameScalarType(actualArray.element, formalArray.element, this.types)
      : sameScalarType(info.descriptor ?? info.dataType, type, this.types);
    if (!matches) {
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

  private superBodyCall(node: AST.FunctionCall | AST.FunctionBlockCall): void {
    if (
      this.ast.kind !== "functionBlock" ||
      this.ast.owner ||
      !this.ast.baseType ||
      (node.kind === "fbCall" ? node.inputs.length : node.args.length || node.outputs?.length)
    ) {
      this.report("inheritance.super-body", {}, node.span);
      return;
    }
    this.superCalls.set(node, this.blockIds.get(this.ast.baseType.name.key)!);
  }

  private blockCall(node: AST.FunctionCall): void {
    let symbol = this.resolve(node.name);
    if (!symbol) return;
    if (isScalar(symbol.type) && node.instance?.kind !== "dereference") {
      this.report("fb.not-function-block", { name: node.name.name }, node.name.span);
      return;
    }
    if (node.instance) {
      const info = this.reference(node.instance, false, true);
      if (!info) return;
      this.expressions.set(node.instance, info);
      if (typeof info.descriptor === "string" || info.descriptor?.kind !== "functionBlock") {
        this.report("fb.not-function-block", { name: node.name.name }, node.span);
        return;
      }
      symbol = {
        ...symbol,
        type: info.descriptor.name,
        descriptor: undefined,
        userBlock: info.descriptor.block,
      };
    } else if (symbol.descriptor && arrayType(symbol.descriptor, this.types)) {
      this.report("fb.not-function-block", { name: node.name.name }, node.span);
      return;
    }
    if (this.pous.get(symbol.type)?.kind === "class") {
      this.report("class.not-callable", { name: node.name.name }, node.span);
      return;
    }
    if (this.ast.kind === "function" && !this.ast.owner && node.instance?.kind !== "dereference")
      this.report("pou.function-block-in-function", {}, node.span);
    if (node.args.length && !node.inputNames) {
      this.report("fb.unsupported-call", { name: node.name.name }, node.span);
      return;
    }
    if (symbol.userBlock !== undefined) this.blockCalls.set(node, symbol.userBlock);
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
      const target = this.blockMember(symbol, name, true);
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
      const source = this.blockMember(symbol, output.name, false);
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

  /** Assignment permits only upward conversion of instance reference targets. */
  private referenceAssignable(target: TypeDescriptor, source: TypeDescriptor): boolean {
    const t = referenceType(target, this.types),
      s = referenceType(source, this.types);
    if (!t || !s) return false;
    const left = resolveType(t.target, this.types),
      right = resolveType(s.target, this.types);
    if (
      typeof left === "object" &&
      left.kind === "functionBlock" &&
      typeof right === "object" &&
      right.kind === "functionBlock"
    ) {
      let actual = this.pous.get(right.name);
      while (actual) {
        if (actual.name.key === left.name) return true;
        actual = actual.baseType;
      }
      return false;
    }
    return sameScalarType(target, source, this.types);
  }

  private instanceReference(type: TypeDescriptor): boolean {
    const ref = referenceType(type, this.types);
    const target = ref && resolveType(ref.target, this.types);
    return typeof target === "object" && target.kind === "functionBlock";
  }

  private assignment(target: TypeDescriptor, info: ExpressionInfo, span: SourceSpan): boolean {
    const source = info.descriptor ?? info.dataType;
    const ti = interfaceType(target, this.types),
      si = interfaceType(source, this.types);
    if (ti || si) {
      if (
        ti &&
        (info.nullReference ||
          (si &&
            (si.name.toUpperCase() === ti.name.toUpperCase() ||
              si.extends.includes(ti.name.toUpperCase()))) ||
          (typeof source === "object" &&
            source.kind === "functionBlock" &&
            this.pous.get(source.name)?.implemented?.includes(ti.name.toUpperCase())))
      )
        return true;
      this.report("type.assign-mismatch", { from: source, to: target }, span);
      return false;
    }
    if (info.nullReference && !referenceType(target, this.types)) {
      this.report("type.invalid-reference-target", {}, span);
      return false;
    }
    if (referenceType(target, this.types) || referenceType(source, this.types)) {
      if (
        referenceType(target, this.types) &&
        (info.nullReference || this.referenceAssignable(target, source))
      )
        return true;
      this.report("type.assign-mismatch", { from: source, to: target }, span);
      return false;
    }
    if (isAggregateType(target, this.types) || isAggregateType(source, this.types)) {
      if (sameScalarType(target, source, this.types)) return true;
      this.report("type.assign-mismatch", { from: source, to: target }, span);
      return false;
    }
    const to = this.base(target, this.types),
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
              failed || node.attempt ? undefined : (target?.descriptor ?? target?.dataType),
            );
          if (target) this.expressions.set(node.target, target);
          if (node.attempt) {
            const variableSource = (value: AST.Expression): boolean =>
              value.kind === "group"
                ? variableSource(value.expression)
                : ["name", "member", "field", "index", "dereference"].includes(value.kind);
            if (
              !target ||
              !value ||
              !(
                interfaceType(target.descriptor ?? target.dataType, this.types) ||
                this.instanceReference(target.descriptor ?? target.dataType)
              ) ||
              !(
                value.nullReference ||
                this.instanceReference(value.descriptor ?? value.dataType) ||
                (variableSource(node.value) &&
                  interfaceType(value.descriptor ?? value.dataType, this.types))
              )
            )
              this.report("interface.assignment-attempt", {}, node.span);
            break;
          }
          if (target && value && !failed)
            this.assignment(target.descriptor ?? target.dataType, value, node.value.span);
          break;
        }
        case "call": {
          if (node.call.name.key === "SUPER") {
            this.superBodyCall(node.call);
            break;
          }
          const symbol = this.names.get(node.call.name.key);
          if (
            (!node.call.receiver ||
              (node.call.receiver.kind === "name" &&
                node.call.receiver.name.key === "THIS" &&
                (this.ast.owner !== undefined ||
                  ["functionBlock", "class"].includes(this.ast.kind)))) &&
            (node.call.instance ||
              (symbol && (isBlock(symbol.type) || symbol.userBlock !== undefined)))
          )
            this.blockCall(node.call);
          else {
            const info = this.functionCall(node.call, true);
            if (info) this.expressions.set(node.call, info);
          }
          break;
        }
        case "fbCall": {
          if (node.instance.key === "SUPER") {
            this.superBodyCall(node);
            break;
          }
          const call: AST.FunctionCall = {
            kind: "functionCall",
            name: node.instance,
            args: node.inputs.map((input) => input.value),
            inputNames: node.inputs.map((input) => input.name),
            span: node.span,
          };
          if (
            this.pous.has(node.instance.key) ||
            (this.ast.owner ?? this.ast).methods?.some((m) => m.name.key === node.instance.key) ||
            node.instance.key === "THIS"
          ) {
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
          if (
            selector &&
            (!isInteger(selector.dataType) ||
              this.aggregate(selector) ||
              referenceLike(selector.descriptor ?? selector.dataType, this.types))
          )
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
            else if (symbol.descriptor && subrangeType(symbol.descriptor, this.types))
              this.report(
                "type.for-variable-subrange",
                { name: node.variable.name, type: symbol.descriptor },
                node.variable.span,
              );
            else if (
              !isInteger(symbol.type) ||
              (symbol.descriptor &&
                (enumerationType(symbol.descriptor, this.types) ||
                  referenceLike(symbol.descriptor, this.types) ||
                  isAggregateType(symbol.descriptor, this.types)))
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
            if (info && type && isInteger(info.dataType) && !this.aggregate(info))
              this.assignment(type, info, value.span);
            if (info && (!isInteger(info.dataType) || this.enum(info) || this.aggregate(info)))
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
  globals?: GlobalScope,
): CheckResult {
  return new Checker(ast, pous, functionIds, blockIds, types, interfaces, globals).run(ast);
}

/** Resolve POU signatures in their own constant scope before checking call sites. */
export function checkDeclarations(
  ast: AST.Program,
  types: TypeTable,
  pous: ReadonlyMap<string, AST.Program>,
  blockIds: ReadonlyMap<string, number>,
  globals?: GlobalScope,
): CheckResult {
  return new Checker(ast, pous, new Map(), blockIds, types, new Map(), globals).run(ast, true);
}

/** Use the ordinary assignment rules in the configuration's global/constant scope. */
export function checkConnection(
  globals: CheckedProgram,
  type: TypeDescriptor,
  value: AST.Expression,
  output: boolean,
) {
  return new Checker(globals.ast, new Map(), new Map(), new Map(), globals.types).connection(
    globals,
    type,
    value,
    output,
  );
}
