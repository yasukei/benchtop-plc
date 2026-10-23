import {
  coerceValue,
  arrayType,
  type AssignmentTarget,
  type IndexReference,
  type VariableReference,
  internalValue,
  scalarBase,
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
import { typed, type Memory, type MemoryFrame, type ArrayValue } from "./memory.js";

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

  private fault(code: "runtime.division-by-zero" | "runtime.for-by-zero", span: SourceSpan): never {
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

  private location(ref: VariableReference | IndexReference): {
    frame: MemoryFrame;
    variable: number;
  } {
    if (ref.kind === "variable") return { frame: this.memory, variable: ref.variable };
    const parent = this.location(ref.array);
    const array = arrayType(ref.array.dataType, this.programMemory.ir.types)!;
    let offset = 0;
    ref.indices.forEach((index, i) => {
      const value = BigInt(this.expression(index)),
        d = array.dimensions[i]!;
      if (d === "*") throw new Error("Open array dimension");
      if (value < BigInt(d.lower) || value > BigInt(d.upper))
        throw new RuntimeFault({
          code: "runtime.index-out-of-range",
          severity: "error",
          span: index.span,
          pou: this.pou,
          ...(this.instancePath ? { instance: this.instancePath } : {}),
          args: { index: value.toString(), lower: d.lower, upper: d.upper },
        });
      offset = offset * (d.upper - d.lower + 1) + Number(value) - d.lower;
    });
    return { frame: parent.frame.element(parent.variable, offset), variable: 0 };
  }

  private arrayExpression(expr: Expression): ArrayValue {
    if (expr.kind === "variable" || expr.kind === "index") {
      const { frame, variable } = this.location(expr);
      return frame.arrayValue(variable);
    }
    if (expr.kind === "functionCall") {
      const args: (ArrayValue | ScalarValue)[] = [];
      for (const i of expr.evaluationOrder ?? expr.args.map((_, i) => i)) {
        const arg = expr.args[i]!;
        args[i] = arrayType(arg.dataType, this.programMemory.ir.types)
          ? this.arrayExpression(arg)
          : this.expression(arg);
      }
      if (expr.function === "MOVE") return args[0] as ArrayValue;
      if (expr.function === "SEL") return args[args[0] ? 2 : 1] as ArrayValue;
      const selector = BigInt(args[0] as ScalarValue);
      if (selector < 0n || selector >= BigInt(args.length - 1))
        throw new RangeError("MUX selector");
      return args[Number(selector) + 1] as ArrayValue;
    }
    throw new Error("Unsupported array expression");
  }

  private assign(target: AssignmentTarget, value: ScalarValue): TypedValue {
    if (target.kind === "index" || target.kind === "elementBit") {
      const { frame, variable } = this.location(target.kind === "index" ? target : target.element);
      return frame.assign(
        target.kind === "index"
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
    return this.memory.assign(target, value);
  }

  private evaluate(expr: Expression): ScalarValue {
    switch (expr.kind) {
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
      case "fbMember":
      case "userFbMember":
        return this.memory.value(expr).value;
      case "unary": {
        const value = this.expression(expr.operand);
        const result = unaryValue(expr.operator, value);
        return coerceValue(this.base(expr.dataType), result);
      }
      case "binary": {
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
        if (result === null) throw new Error("Expression function has no result");
        return result;
      }
    }
  }

  private annotate(statement: Statement, values: TypedValue[]): void {
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
        if (arrayType(statement.target.dataType, this.programMemory.ir.types)) {
          const values = this.arrayExpression(statement.value);
          const target = statement.target;
          if (target.kind !== "variable" && target.kind !== "index")
            throw new Error("Invalid array target");
          const { frame, variable } = this.location(target);
          frame.assignArray(variable, values);
          break;
        }
        this.annotate(statement, [this.assign(statement.target, this.expression(statement.value))]);
        break;
      case "call": {
        if (statement.call.kind === "userFunctionCall") {
          const result = this.userCall(statement.call);
          if (statement.call.dataType !== null && result !== null)
            this.annotate(statement, [
              { dataType: this.base(statement.call.dataType), value: result } as TypedValue,
            ]);
          break;
        }
        if (arrayType(statement.call.dataType, this.programMemory.ir.types)) {
          this.arrayExpression(statement.call);
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

  private blockCall(call: FunctionBlockCallStatement | UserFunctionBlockCallStatement): void {
    const inputs = call.inputs.map((input) => ({
      input: input.input,
      value: this.expression(input.value),
    }));
    let outputs: TypedValue[];
    let outputSlots: number[];
    if (call.kind === "fbCall") {
      for (const input of inputs) this.memory.input(call.variable, input.input, input.value);
      const instance = this.memory.block(call.variable);
      instance.execute(this.scanStart);
      outputs = instance.outputs.map((output) => {
        output.value = coerceValue(output.dataType, output.value);
        return { ...output };
      });
      outputSlots = outputs.map((_, index) => index);
    } else {
      const instance = this.memory.userBlock(call.variable);
      const definition = this.programMemory.ir.functionBlocks![instance.block]!;
      instance.resetTemporaries();
      for (const binding of call.inOuts ?? [])
        instance.frame.bind(binding.variable, this.memory, binding.actual.variable);
      for (const input of inputs) instance.frame.write(input.input, input.value);
      const caller = this.memory,
        callerPou = this.pou,
        callerPath = this.instancePath;
      this.memory = instance.frame;
      this.pou = definition.name;
      this.instancePath = instance.path;
      this.callDepth++;
      try {
        this.execute(definition.body);
        outputs = definition.outputs.map((slot) => {
          const variable = definition.variables[slot]!;
          if (variable.kind !== "scalar") throw new Error("Non-scalar output");
          return typed(this.base(variable.dataType), instance.frame.read(slot));
        });
      } finally {
        instance.frame.unbind(definition.inOuts ?? []);
        this.callDepth--;
        this.memory = caller;
        this.pou = callerPou;
        this.instancePath = callerPath;
      }
      outputSlots = definition.outputs;
    }
    for (const binding of call.outputs ?? []) {
      const value = outputs[outputSlots.indexOf(binding.output)]!;
      const to = this.base(binding.target.dataType);
      this.assign(
        binding.target,
        isLongType(to) && value.dataType !== to
          ? convertValue(`${value.dataType}_TO_${to}` as ConversionFunction, value.value)
          : value.value,
      );
    }
    this.annotate(call, outputs);
  }

  private userCall(call: UserFunctionCall): ScalarValue | null {
    const definition = this.functions[call.function];
    if (!definition) throw new Error("Missing function body");
    // Evaluate all actual inputs in caller storage and in source order before entering.
    const inputs = call.inputs.map((input) => ({
      variable: input.variable,
      value: this.expression(input.value),
    }));
    const caller = this.memory,
      callerPou = this.pou,
      callerPath = this.instancePath;
    const locals = this.programMemory.functionFrame(call.function);
    for (const input of inputs) locals.write(input.variable, input.value);
    for (const binding of call.inOuts ?? [])
      locals.bind(binding.variable, caller, binding.actual.variable);
    let result: ScalarValue | null;
    this.memory = locals;
    this.pou = definition.name;
    this.instancePath = undefined;
    this.callDepth++;
    try {
      this.execute(definition.body);
      result = definition.result === undefined ? null : locals.read(definition.result);
    } finally {
      this.callDepth--;
      this.memory = caller;
      this.pou = callerPou;
      this.instancePath = callerPath;
    }
    for (const output of call.outputs) {
      const variable = definition.variables[output.variable]!;
      const to = this.base(output.target.dataType);
      const value = locals.read(output.variable);
      this.assign(
        output.target,
        isLongType(to) && this.base(variable.dataType) !== to
          ? convertValue(`${this.base(variable.dataType)}_TO_${to}` as ConversionFunction, value)
          : value,
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
