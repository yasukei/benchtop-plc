import {
  coerceValue,
  arrayType,
  isAggregateType,
  type AssignmentTarget,
  internalValue,
  scalarBase,
  referenceType,
  type StorageReference,
  type InlineValue,
  SubrangeViolation,
  convertValue,
  isCalendarType,
  calendarBinary,
  isIntegerType,
  isLongType,
  timeBinary,
  ltimeBinary,
  binaryValue,
  unaryValue,
  validateValue,
} from "@benchtop-plc/core";
import type {
  Diagnostic,
  TypeDescriptor,
  Expression,
  ScalarValue,
  SourceSpan,
  Statement,
  StatementAnnotation,
  TypedValue,
  UserFunctionCall,
  UserFunctionIR,
  ConversionFunction,
  FunctionBlockCallStatement,
  UserFunctionBlockCallStatement,
} from "@benchtop-plc/core";
import type { RuntimeLibrary } from "./library.js";
import {
  isReferenceAddress,
  type ReferenceAddress,
  type StoredValue,
  isAggregateValue,
  type Memory,
  type MemoryFrame,
  type AggregateValue,
} from "./memory.js";

export const WATCHDOG_LIMIT = 200_000;
export class RuntimeFault extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}

type Flow = "exit" | "return" | "abort" | undefined;

export class Interpreter {
  private memory: MemoryFrame;
  private iterations = 0;
  private readonly annotations = new Map<Statement, StatementAnnotation>();
  private readonly functions: readonly UserFunctionIR[];
  private pou: string;
  private callDepth = 0;
  private instancePath?: string;

  constructor(
    private readonly programMemory: Memory,
    private readonly scanStart: number,
    private readonly active: () => boolean,
    private readonly library?: RuntimeLibrary,
  ) {
    this.memory = programMemory.programFrame();
    this.functions = programMemory.ir.functions ?? [];
    this.pou = programMemory.ir.name;
  }

  private base(type: TypeDescriptor) {
    return scalarBase(type, this.programMemory.ir.types);
  }

  private invalidValue(error: RangeError, span: SourceSpan): RuntimeFault {
    return new RuntimeFault({
      severity: "error",
      span,
      pou: this.pou,
      ...(this.instancePath ? { instance: this.instancePath } : {}),
      ...(error instanceof SubrangeViolation
        ? {
            code: "runtime.subrange-violation",
            args: {
              value:
                typeof error.value === "bigint" || typeof error.value === "string"
                  ? error.value.toString()
                  : Number(error.value),
              lower: error.range.lower,
              upper: error.range.upper,
            },
          }
        : { code: "runtime.invalid-value", args: {} }),
    });
  }

  private fault(
    code: "runtime.division-by-zero" | "runtime.for-by-zero" | "runtime.null-reference",
    span: SourceSpan,
  ): never {
    throw new RuntimeFault({
      code,
      severity: "error",
      span,
      pou: this.pou,
      ...(this.instancePath ? { instance: this.instancePath } : {}),
      args: {},
    });
  }

  private iteration(span: SourceSpan): void {
    if (++this.iterations > WATCHDOG_LIMIT) {
      throw new RuntimeFault({
        code: "runtime.watchdog",
        severity: "error",
        span,
        pou: this.pou,
        ...(this.instancePath ? { instance: this.instancePath } : {}),
        args: { limit: WATCHDOG_LIMIT },
      });
    }
  }

  expression(expr: Expression): ScalarValue {
    try {
      return internalValue(this.base(expr.dataType), this.evaluate(expr));
    } catch (error) {
      if (error instanceof RangeError) throw this.invalidValue(error, expr.span);
      throw error;
    }
  }

  private location(ref: StorageReference): {
    frame: MemoryFrame;
    variable: number;
  } {
    if (ref.kind === "dereference") {
      const address = this.referenceExpression(ref.reference);
      if (!address) this.fault("runtime.null-reference", ref.span);
      return address;
    }
    if (ref.kind === "variable") return { frame: this.memory, variable: ref.variable };
    if (ref.kind === "userFbMember") {
      const parent = ref.instance
        ? this.location(ref.instance)
        : { frame: this.memory, variable: ref.variable };
      return { frame: parent.frame.userBlock(parent.variable).frame, variable: ref.member };
    }
    if (ref.kind === "structureMember") {
      const parent = this.location(ref.object);
      return { frame: parent.frame.element(parent.variable, ref.member), variable: 0 };
    }
    const parent = this.location(ref.array);
    const array = arrayType(parent.frame.descriptor(parent.variable), this.programMemory.ir.types)!;
    let offset = 0;
    const indices: string[] = [];
    ref.indices.forEach((index, i) => {
      const value = BigInt(this.expression(index)),
        d = array.dimensions[i]!;
      indices.push(value.toString());
      if (d === "*") throw new Error("Open array dimension");
      if (value < BigInt(d.lower) || value > BigInt(d.upper))
        throw new RuntimeFault({
          code: "runtime.index-out-of-range",
          severity: "error",
          span: index.span,
          pou: this.pou,
          ...(typeof ref.dataType !== "string" && ref.dataType.kind === "functionBlock"
            ? {
                instance: `${this.instancePath ? this.instancePath + "." : ""}${ref.instanceName}[${indices.join(",")}]`,
              }
            : this.instancePath
              ? { instance: this.instancePath }
              : {}),
          args: { index: value.toString(), lower: d.lower, upper: d.upper },
        });
      offset = offset * (d.upper - d.lower + 1) + Number(value) - d.lower;
    });
    return { frame: parent.frame.element(parent.variable, offset), variable: 0 };
  }

  private referenceExpression(expr: Expression): ReferenceAddress | null {
    if (expr.kind === "null") return null;
    if (expr.kind === "referenceOf") {
      if (expr.target.kind === "fbMember") {
        const target = expr.target;
        const location = target.instance
          ? this.location(target.instance)
          : { frame: this.memory, variable: target.variable };
        return location.frame.portFrame(location.variable, target.port, target.member).address(0);
      }
      const location = this.location(expr.target);
      return location.frame.address(location.variable);
    }
    if (expr.kind === "functionCall") {
      const args: (ReferenceAddress | null | ScalarValue)[] = [];
      for (const i of expr.evaluationOrder ?? expr.args.map((_, i) => i)) {
        const arg = expr.args[i]!;
        args[i] = referenceType(arg.dataType, this.programMemory.ir.types)
          ? this.referenceExpression(arg)
          : this.expression(arg);
      }
      if (expr.function === "MOVE") return args[0] as ReferenceAddress | null;
      if (expr.function === "SEL") return args[args[0] ? 2 : 1] as ReferenceAddress | null;
      const selector = BigInt(args[0] as ScalarValue);
      if (selector < 0n || selector >= BigInt(args.length - 1))
        throw new RangeError("MUX selector");
      return args[Number(selector) + 1] as ReferenceAddress | null;
    }
    if (expr.kind === "userFunctionCall") {
      const value = this.userCall(expr);
      if (value === null || isReferenceAddress(value)) return value;
      throw new Error("Expected reference result");
    }
    if (
      expr.kind === "variable" ||
      expr.kind === "index" ||
      expr.kind === "structureMember" ||
      expr.kind === "userFbMember" ||
      expr.kind === "dereference"
    ) {
      const location = this.location(expr);
      return location.frame.readReference(location.variable);
    }
    throw new Error("Unsupported reference expression");
  }
  private aggregateExpression(expr: Expression): AggregateValue {
    if (
      expr.kind === "variable" ||
      expr.kind === "index" ||
      expr.kind === "structureMember" ||
      expr.kind === "userFbMember" ||
      expr.kind === "dereference"
    ) {
      const { frame, variable } = this.location(expr);
      return frame.aggregateValue(variable);
    }
    if (expr.kind === "userFunctionCall") {
      const value = this.userCall(expr);
      if (!isAggregateValue(value)) throw new Error("Expected aggregate function result");
      return value;
    }
    if (expr.kind === "functionCall") {
      const args: (AggregateValue | ScalarValue)[] = [];
      for (const i of expr.evaluationOrder ?? expr.args.map((_, i) => i)) {
        const arg = expr.args[i]!;
        args[i] = isAggregateType(arg.dataType, this.programMemory.ir.types)
          ? this.aggregateExpression(arg)
          : this.expression(arg);
      }
      if (expr.function === "MOVE") return args[0] as AggregateValue;
      if (expr.function === "SEL") return args[args[0] ? 2 : 1] as AggregateValue;
      const selector = BigInt(args[0] as ScalarValue);
      if (selector < 0n || selector >= BigInt(args.length - 1))
        throw new RangeError("MUX selector");
      return args[Number(selector) + 1] as AggregateValue;
    }
    throw new Error("Unsupported aggregate expression");
  }

  private assign(target: AssignmentTarget, value: ScalarValue): TypedValue {
    if (
      target.kind === "dereference" ||
      target.kind === "index" ||
      target.kind === "structureMember" ||
      target.kind === "elementBit"
    ) {
      const { frame, variable } = this.location(
        target.kind !== "elementBit" ? target : target.element,
      );
      return frame.assign(
        target.kind !== "elementBit"
          ? { ...target, kind: "variable", variable }
          : {
              kind: "bit",
              variable,
              bit: target.bit,
              dataType: "BOOL",
              span: target.span,
            },
        value,
      );
    }
    if ((target.kind === "fbMember" || target.kind === "userFbMember") && target.instance) {
      const { frame, variable } = this.location(target.instance);
      return frame.assign({ ...target, variable }, value);
    }
    return this.memory.assign(target, value);
  }

  private evaluate(expr: Expression): ScalarValue {
    switch (expr.kind) {
      case "arrayBound": {
        const array = expr.array;
        let type: TypeDescriptor;
        if (
          array.kind === "variable" ||
          array.kind === "index" ||
          array.kind === "structureMember" ||
          array.kind === "userFbMember"
        ) {
          const { frame, variable } = this.location(array);
          type = frame.descriptor(variable);
        } else type = this.aggregateExpression(array).dataType;
        const dimension = arrayType(type, this.programMemory.ir.types)!.dimensions[expr.dimension]!;
        if (dimension === "*") throw new Error("Unbound open array");
        return expr.upper ? dimension.upper : dimension.lower;
      }
      case "null":
      case "referenceOf":
        throw new Error("Reference used as scalar");
      case "dereference":
      case "structureMember":
      case "index": {
        const { frame, variable } = this.location(expr);
        return frame.read(variable);
      }
      case "elementBit": {
        const { frame, variable } = this.location(expr.element);
        return (BigInt(frame.read(variable)) & (1n << BigInt(expr.bit))) !== 0n;
      }
      case "literal":
        if (isLongType(this.base(expr.dataType)) || isCalendarType(this.base(expr.dataType)))
          validateValue(this.base(expr.dataType), expr.value);
        return expr.value;
      case "variable":
      case "bit":
        return this.memory.value(expr).value;
      case "fbMember":
      case "userFbMember": {
        if (!expr.instance) return this.memory.value(expr).value;
        const { frame, variable } = this.location(expr.instance);
        return frame.value({ ...expr, variable }).value;
      }
      case "unary": {
        const value = this.expression(expr.operand);
        const result = unaryValue(expr.operator, value);
        return coerceValue(this.base(expr.dataType), result);
      }
      case "binary": {
        if (
          referenceType(expr.left.dataType, this.programMemory.ir.types) ||
          referenceType(expr.right.dataType, this.programMemory.ir.types)
        ) {
          const left = this.referenceExpression(expr.left),
            right = this.referenceExpression(expr.right);
          const equal =
            left === null
              ? right === null
              : right !== null && left.frame.sameLocation(left.variable, right);
          return expr.operator === "=" ? equal : !equal;
        }
        const left = this.expression(expr.left),
          right = this.expression(expr.right);
        if (expr.operator === "/" && Number(right) === 0) {
          this.fault("runtime.division-by-zero", expr.span);
        }
        const leftType = this.base(expr.left.dataType);
        if (isCalendarType(leftType))
          return calendarBinary(
            expr.operator,
            leftType,
            left,
            this.base(expr.right.dataType),
            right,
          );
        return this.base(expr.dataType) === "LTIME"
          ? ltimeBinary(
              expr.operator as "+" | "-" | "*" | "/",
              BigInt(left),
              this.base(expr.right.dataType) === "REAL" ||
                this.base(expr.right.dataType) === "LREAL"
                ? Number(right)
                : BigInt(right),
              this.base(expr.right.dataType),
            )
          : this.base(expr.dataType) === "TIME"
            ? timeBinary(
                expr.operator as "+" | "-" | "*" | "/",
                Number(left),
                typeof right === "bigint" ? BigInt(right) : Number(right),
                this.base(expr.right.dataType),
              )
            : coerceValue(
                this.base(expr.dataType),
                expr.operator === "*" &&
                  isIntegerType(this.base(expr.dataType)) &&
                  !isLongType(this.base(expr.dataType))
                  ? Math.imul(Number(left), Number(right))
                  : binaryValue(expr.operator, left, right),
              );
      }
      case "functionCall": {
        if (!this.library) throw new Error("A runtime library is required for functions");
        const args: ScalarValue[] = [];
        for (const index of expr.evaluationOrder ?? expr.args.map((_, index) => index))
          args[index] = this.expression(expr.args[index]!);
        if (["DIV", "DIV_TIME", "DIV_LTIME"].includes(expr.function) && Number(args[1]) === 0)
          this.fault("runtime.division-by-zero", expr.span);
        const outputs = new Map<number, ScalarValue>();
        const result = coerceValue(
          this.base(expr.dataType),
          this.library.callFunction(expr.function, args, this.base(expr.dataType), {
            argumentTypes: expr.args.map((arg) => this.base(arg.dataType)),
            output: (index, value) => outputs.set(index, value),
          }),
        );
        for (const binding of expr.outputs ?? []) {
          const value = outputs.get(binding.output);
          if (value === undefined) throw new Error("Missing function output");
          this.assign(binding.target, value);
        }
        return result;
      }
      case "userFunctionCall": {
        const result = this.userCall(expr);
        if (result === null || isAggregateValue(result) || isReferenceAddress(result))
          throw new Error("Expected scalar function result");
        return result;
      }
    }
  }

  private annotate(statement: Statement, values: InlineValue[]): void {
    if (this.callDepth) return;
    this.annotations.set(statement, {
      span: { ...statement.span },
      values: values.map((value) => ({ ...value })),
    });
  }

  execute(body: readonly Statement[]): Flow {
    for (const statement of body) {
      if (!this.active()) return "abort";
      let flow: Flow;
      try {
        flow = this.statement(statement);
      } catch (error) {
        if (error instanceof RangeError) throw this.invalidValue(error, statement.span);
        throw error;
      }
      if (flow) return flow;
    }
    return undefined;
  }

  private statement(statement: Statement): Flow {
    switch (statement.kind) {
      case "assignment":
        if (referenceType(statement.target.dataType, this.programMemory.ir.types)) {
          const value = this.referenceExpression(statement.value);
          const location = this.location(statement.target as StorageReference);
          this.annotate(statement, [location.frame.writeReference(location.variable, value)]);
          break;
        }
        if (isAggregateType(statement.target.dataType, this.programMemory.ir.types)) {
          const values = this.aggregateExpression(statement.value);
          this.assignAggregate(statement.target, values);
          break;
        }
        this.annotate(statement, [this.assign(statement.target, this.expression(statement.value))]);
        break;
      case "call": {
        if (statement.call.kind === "userFunctionCall") {
          const result = this.userCall(statement.call);
          if (
            statement.call.dataType !== null &&
            referenceType(statement.call.dataType, this.programMemory.ir.types)
          ) {
            if (result !== null && !isReferenceAddress(result))
              throw new Error("Expected reference result");
            this.annotate(statement, [this.memory.referenceValue(result)]);
            break;
          }
          if (
            statement.call.dataType !== null &&
            result !== null &&
            !isAggregateValue(result) &&
            !isReferenceAddress(result)
          )
            this.annotate(statement, [
              { dataType: this.base(statement.call.dataType), value: result } as TypedValue,
            ]);
          break;
        }
        if (referenceType(statement.call.dataType, this.programMemory.ir.types)) {
          this.annotate(statement, [
            this.memory.referenceValue(this.referenceExpression(statement.call)),
          ]);
          break;
        }
        if (isAggregateType(statement.call.dataType, this.programMemory.ir.types)) {
          this.aggregateExpression(statement.call);
          break;
        }
        this.annotate(statement, [
          {
            dataType: this.base(statement.call.dataType),
            value: this.expression(statement.call),
          } as TypedValue,
        ]);
        break;
      }
      case "fbCall":
      case "userFbCall":
        this.blockCall(statement);
        break;
      case "if": {
        const branch = statement.branches.find((branch) => this.expression(branch.condition));
        return this.execute(branch?.body ?? statement.elseBody);
      }
      case "case": {
        const selector = BigInt(this.expression(statement.selector));
        const branch = statement.branches.find((branch) =>
          branch.labels.some((label) =>
            label.kind === "value"
              ? selector === BigInt(label.value)
              : selector >= BigInt(label.lower) && selector <= BigInt(label.upper),
          ),
        );
        return this.execute(branch?.body ?? statement.elseBody);
      }
      case "for": {
        const from = this.expression(statement.from);
        const to = BigInt(this.expression(statement.to));
        const step = BigInt(this.expression(statement.step));
        if (step === 0n) this.fault("runtime.for-by-zero", statement.step.span);
        this.assign(statement.variable, from);
        while (
          step > 0n
            ? BigInt(this.memory.read(statement.variable.variable)) <= to
            : BigInt(this.memory.read(statement.variable.variable)) >= to
        ) {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
          this.assign(
            statement.variable,
            BigInt(this.memory.read(statement.variable.variable)) + step,
          );
        }
        break;
      }
      case "while":
        while (this.expression(statement.condition)) {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
        }
        break;
      case "repeat":
        do {
          if (!this.active()) return "abort";
          this.iteration(statement.span);
          const flow = this.execute(statement.body);
          if (flow === "exit") break;
          if (flow) return flow;
        } while (!this.expression(statement.until));
        break;
      case "exit":
        return "exit";
      case "return":
        return "return";
    }
    return undefined;
  }

  private assignAggregate(target: AssignmentTarget, values: AggregateValue): void {
    if (
      target.kind !== "variable" &&
      target.kind !== "index" &&
      target.kind !== "structureMember" &&
      target.kind !== "userFbMember" &&
      target.kind !== "dereference"
    )
      throw new Error("Invalid aggregate target");
    const { frame, variable } = this.location(target);
    frame.assignAggregate(variable, values);
  }

  private argumentValue(expr: Expression): StoredValue {
    if (referenceType(expr.dataType, this.programMemory.ir.types))
      return this.referenceExpression(expr);
    return isAggregateType(expr.dataType, this.programMemory.ir.types)
      ? this.aggregateExpression(expr)
      : this.expression(expr);
  }

  private store(frame: MemoryFrame, variable: number, value: StoredValue): void {
    if (isAggregateValue(value)) frame.assignAggregate(variable, value);
    else if (value === null || isReferenceAddress(value)) frame.writeReference(variable, value);
    else frame.write(variable, value);
  }

  private arguments(
    inputs: { variable: number; value: Expression }[],
    inOuts: readonly import("@benchtop-plc/core").InOutBinding[],
  ) {
    const values = new Map<number, StoredValue>();
    const aliases = new Map<number, { frame: MemoryFrame; variable: number }>();
    const argumentsInOrder = [
      ...inputs.map((input) => ({
        span: input.value.span,
        evaluate: () => {
          values.set(input.variable, this.argumentValue(input.value));
        },
      })),
      ...inOuts.map((binding) => ({
        span: binding.actual.span,
        evaluate: () => {
          aliases.set(binding.variable, this.location(binding.actual));
        },
      })),
    ].sort((a, b) => a.span.line - b.span.line || a.span.column - b.span.column);
    for (const arg of argumentsInOrder) arg.evaluate();
    return { values, aliases };
  }

  private copyOutput(
    target: AssignmentTarget,
    frame: MemoryFrame,
    slot: number,
    type: import("@benchtop-plc/core").TypeDescriptor,
  ): void {
    if (referenceType(type, this.programMemory.ir.types)) {
      const destination = this.location(target as StorageReference);
      destination.frame.writeReference(destination.variable, frame.readReference(slot));
      return;
    }
    if (isAggregateType(type, this.programMemory.ir.types)) {
      this.assignAggregate(target, frame.aggregateValue(slot));
      return;
    }
    const to = this.base(target.dataType),
      from = this.base(type),
      value = frame.read(slot);
    this.assign(
      target,
      isLongType(to) && from !== to
        ? convertValue(`${from}_TO_${to}` as ConversionFunction, value)
        : value,
    );
  }

  private blockCall(call: FunctionBlockCallStatement | UserFunctionBlockCallStatement): void {
    const location = call.instance
      ? this.location(call.instance)
      : { frame: this.memory, variable: call.variable };
    if (call.kind === "fbCall") {
      const inputs = call.inputs.map((input) => ({
        ...input,
        value: this.expression(input.value),
      }));
      for (const input of inputs) location.frame.input(location.variable, input.input, input.value);
      const instance = location.frame.block(location.variable);
      instance.execute(this.scanStart);
      const outputs = instance.outputs.map((output) => {
        output.value = coerceValue(output.dataType, output.value);
        return { ...output };
      });
      for (const binding of call.outputs ?? []) {
        const value = outputs[binding.output]!;
        const to = this.base(binding.target.dataType);
        this.assign(
          binding.target,
          isLongType(to) && value.dataType !== to
            ? convertValue(`${value.dataType}_TO_${to}` as ConversionFunction, value.value)
            : value.value,
        );
      }
      this.annotate(call, outputs);
      return;
    }
    const args = this.arguments(
      call.inputs.map((input) => ({ variable: input.input, value: input.value })),
      call.inOuts ?? [],
    );
    const instance = location.frame.userBlock(location.variable);
    const definition = this.programMemory.ir.functionBlocks![instance.block]!;
    instance.resetTemporaries();
    for (const [slot, actual] of args.aliases)
      instance.frame.bind(slot, actual.frame, actual.variable);
    for (const [slot, value] of args.values) this.store(instance.frame, slot, value);
    const caller = this.memory,
      callerPou = this.pou,
      callerPath = this.instancePath;
    this.memory = instance.frame;
    this.pou = definition.name;
    this.instancePath = instance.path;
    this.callDepth++;
    try {
      this.execute(definition.body);
    } finally {
      instance.frame.unbind(definition.inOuts ?? []);
      this.callDepth--;
      this.memory = caller;
      this.pou = callerPou;
      this.instancePath = callerPath;
    }
    for (const binding of call.outputs ?? []) {
      const variable = definition.variables[binding.output]!;
      if (!("dataType" in variable)) throw new Error("Invalid output type");
      this.copyOutput(binding.target, instance.frame, binding.output, variable.dataType);
    }
    this.annotate(
      call,
      definition.outputs.flatMap((slot) => {
        const variable = definition.variables[slot]!;
        return variable.kind === "scalar" || variable.kind === "reference"
          ? [instance.frame.inlineValue(slot)]
          : [];
      }),
    );
  }

  private userCall(call: UserFunctionCall): StoredValue {
    const definition = this.functions[call.function];
    if (!definition) throw new Error("Missing function body");
    const args = this.arguments(call.inputs, call.inOuts ?? []);
    const caller = this.memory,
      callerPou = this.pou,
      callerPath = this.instancePath;
    const locals = this.programMemory.functionFrame(call.function);
    for (const [slot, value] of args.values) this.store(locals, slot, value);
    for (const [slot, actual] of args.aliases) locals.bind(slot, actual.frame, actual.variable);
    let result: StoredValue;
    this.memory = locals;
    this.pou = definition.name;
    this.instancePath = undefined;
    this.callDepth++;
    try {
      this.execute(definition.body);
      result =
        definition.result === undefined
          ? null
          : referenceType(
                definition.variables[definition.result]!.dataType,
                this.programMemory.ir.types,
              )
            ? locals.readReference(definition.result)
            : isAggregateType(
                  definition.variables[definition.result]!.dataType,
                  this.programMemory.ir.types,
                )
              ? locals.aggregateValue(definition.result)
              : locals.read(definition.result);
    } finally {
      this.callDepth--;
      this.memory = caller;
      this.pou = callerPou;
      this.instancePath = callerPath;
    }
    for (const output of call.outputs) {
      this.copyOutput(
        output.target,
        locals,
        output.variable,
        definition.variables[output.variable]!.dataType,
      );
    }
    return result;
  }

  annotationSnapshot(): Record<number, StatementAnnotation[]> {
    const result: Record<number, StatementAnnotation[]> = {};
    for (const annotation of this.annotations.values()) {
      (result[annotation.span.line] ??= []).push(annotation);
    }
    for (const entries of Object.values(result))
      entries.sort((a, b) => a.span.column - b.span.column);
    return result;
  }
}
