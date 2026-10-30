import {
  coerceValue,
  arrayType,
  isAggregateType,
  type AssignmentTarget,
  internalValue,
  scalarBase,
  referenceLike,
  referenceType,
  resolveType,
  interfaceType,
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
  AnnotatedBody,
  CallFrame,
  CallVariable,
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
  ProgramIR,
  ConfigurationIR,
  ConversionFunction,
  FunctionBlockCallStatement,
  UserFunctionBlockCallStatement,
} from "@benchtop-plc/core";
import type { RuntimeLibrary } from "./library.js";
import { annotationLines } from "./annotations.js";
import {
  typed,
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

type Location = { frame: MemoryFrame; variable: number };
export interface PauseLocation {
  task: string;
  span: SourceSpan;
  pou: string;
  instancePath: string | null;
}
export type PauseHook = (location: PauseLocation) => boolean;
type Instruction = { statement?: Statement; run: (vm: Interpreter, frame: ExecutionFrame) => void };
interface FrameLocal {
  slot: number;
  name: string;
  inOut?: true;
}
interface ExecutionFrame {
  debug?: { kind: CallFrame["kind"]; memory: MemoryFrame; locals: readonly FrameLocal[] };
  annotations?: Map<Statement, StatementAnnotation>;
  body?: Omit<AnnotatedBody, "lines" | "scanCount">;
  code: Instruction[];
  pc: number;
  statement?: Statement;
  values: Map<Expression | UserFunctionCall, StoredValue>;
  locations: Map<StorageReference, Location>;
  loops: Map<Statement, { to: bigint; step: bigint }>;
  receivers?: Map<UserFunctionCall, Interpreter["receiver"]>;
  blockAnnotations?: Map<FunctionBlockCallStatement, InlineValue[]>;
  completed?: Map<
    | UserFunctionCall
    | import("@benchtop-plc/core").FunctionCallExpression
    | FunctionBlockCallStatement
    | UserFunctionBlockCallStatement,
    (index: number) => () => void
  >;
  copies?: (() => void)[];
  finish?: (abandoned: boolean) => void;
}
const lowered = new WeakMap<readonly Statement[], Instruction[]>();

export class Interpreter {
  private memory: MemoryFrame;
  private readonly stack: ExecutionFrame[] = [];
  private skipPause = false;
  private get frame(): ExecutionFrame | undefined {
    return this.stack.at(-1);
  }
  private push(
    body: readonly Statement[],
    finish?: (abandoned: boolean) => void,
    annotateBody = false,
    caller?: AnnotatedBody["caller"],
    debug?: { kind: CallFrame["kind"]; locals: readonly FrameLocal[] },
  ): void {
    const instance = this.instancePath ?? (caller ? null : this.programMemory.ir.name);
    const annotations = annotateBody ? this.startBody?.(this.pou, instance, caller) : undefined;
    this.stack.push({
      debug: this.recordFrames && debug ? { ...debug, memory: this.memory } : undefined,
      annotations: annotations ?? (this.recordFrames ? new Map() : undefined),
      body: this.recordFrames
        ? { pou: this.pou, instance, ...(caller ? { caller } : {}) }
        : undefined,
      code: Interpreter.lower(body),
      pc: 0,
      values: new Map(),
      locations: new Map(),
      loops: new Map(),
      finish,
    });
  }

  /** Invocation-local annotations, outermost first; empty unless debugging was active at task start. */
  get frameAnnotations(): Omit<AnnotatedBody, "scanCount">[] {
    return this.stack.flatMap((frame) =>
      frame.body
        ? [
            {
              ...frame.body,
              ...(frame.body.caller ? { caller: { ...frame.body.caller } } : {}),
              lines: annotationLines(frame.annotations!),
            },
          ]
        : [],
    );
  }

  /** Frame identities survive a pause; depth alone cannot distinguish sibling calls. */
  get frameStack(): readonly object[] {
    return this.stack;
  }

  callFrames(): CallFrame[] {
    const frames = [...this.stack].reverse();
    return frames.flatMap((frame, index): CallFrame[] => {
      if (!frame.debug || !frame.body) return [];
      const { kind, memory, locals } = frame.debug;
      const span = (index === 0 ? frame.code[frame.pc]?.statement : frame.statement)?.span;
      if (!span) throw new Error("Missing call stack statement");
      const values = locals.map((local): CallVariable => {
        let actual: CallVariable["actual"];
        if (local.inOut) {
          const path = memory.debugPath(local.slot);
          if (path !== undefined) actual = { path };
          else {
            // Follow shared cells through any intermediate in-out aliases to the owner.
            for (const [callerIndex, caller] of frames.entries()) {
              if (!caller.debug) continue;
              for (const candidate of caller.debug.locals) {
                if (candidate.inOut) continue;
                const suffix = caller.debug.memory.debugSuffix(
                  candidate.slot,
                  memory.address(local.slot),
                );
                if (suffix !== undefined) {
                  actual = { frame: callerIndex, name: candidate.name + suffix };
                  break;
                }
              }
              if (actual) break;
            }
            if (!actual) throw new Error("Missing in-out actual on call stack");
          }
        }
        return {
          name: local.name,
          value: memory.debugValue(local.slot),
          ...(actual ? { actual } : {}),
        };
      });
      return [
        {
          kind,
          pou: frame.body.pou,
          instance: frame.body.instance,
          span: { ...span },
          ...(index === frames.length - 1 ? { task: this.task } : {}),
          values,
          ...(frame.body.caller ? { caller: { ...frame.body.caller } } : {}),
          annotations: annotationLines(frame.annotations!),
        },
      ];
    });
  }

  private blockLocals(definition: import("@benchtop-plc/core").UserFunctionBlockIR): FrameLocal[] {
    return [...definition.temporaries, ...(definition.inOuts ?? [])].map((slot) => ({
      slot,
      name: definition.variables[slot]!.name,
      ...(definition.inOuts?.includes(slot) ? { inOut: true as const } : {}),
    }));
  }

  static prepare(ir: ProgramIR | ConfigurationIR): void {
    for (const program of ir.kind === "configuration" ? ir.programs : [ir])
      Interpreter.lower(program.body);
    for (const fn of ir.functions ?? []) Interpreter.lower(fn.body);
    for (const block of ir.functionBlocks ?? []) {
      Interpreter.lower(block.body);
      for (const method of block.methods ?? []) Interpreter.lower(method.body);
    }
  }

  private static lower(body: readonly Statement[]): Instruction[] {
    const cached = lowered.get(body);
    if (cached) return cached;
    const code: Instruction[] = [];
    lowered.set(body, code);
    const emit = (run: Instruction["run"]) => {
      code.push({ run });
    };
    const address = (ref: StorageReference): void => {
      if (ref.kind === "index") {
        address(ref.array);
        for (const index of ref.indices) valueAlways(index);
      } else if (ref.kind === "dereference") value(ref.reference);
      else if (ref.kind === "structureMember") address(ref.object);
      else if (ref.kind === "userFbMember" && ref.instance) address(ref.instance);
      emit((vm, frame) => {
        frame.locations.set(ref, vm.location(ref));
      });
    };
    const target = (ref: AssignmentTarget): void => {
      if (ref.kind === "elementBit") address(ref.element);
      else if (ref.kind === "fbMember") {
        if (ref.instance) address(ref.instance);
      } else if (ref.kind !== "bit") address(ref);
    };
    const argumentsFor = (
      inputs: { value: Expression }[],
      inOuts: readonly import("@benchtop-plc/core").InOutBinding[],
    ): void => {
      const args = [
        ...inputs.map((input) => ({ span: input.value.span, run: () => valueAlways(input.value) })),
        ...inOuts.map((binding) => ({
          span: binding.actual.span,
          run: () => address(binding.actual),
        })),
      ].sort((a, b) => a.span.line - b.span.line || a.span.column - b.span.column);
      for (const arg of args) arg.run();
    };
    const emitExpression = (expr: Expression | UserFunctionCall, run: Instruction["run"]): void => {
      emit((vm, frame) => {
        try {
          run(vm, frame);
        } catch (error) {
          if (error instanceof RangeError && expr.dataType !== null)
            throw vm.invalidValue(error, expr.span);
          throw error;
        }
      });
    };
    const value = (expr: Expression | UserFunctionCall): void => {
      // Call-free expressions stay tree operations; only paths that can enter a body
      // need operand slots and continuations.
      if (!Interpreter.hasCall(expr)) return;
      switch (expr.kind) {
        case "userFunctionCall":
          if (expr.method?.receiver) address(expr.method.receiver);
          // Capture the receiver before evaluating arguments, which may change references.
          emitExpression(expr, (vm, frame) => {
            vm.captureReceiver(expr, frame);
          });
          argumentsFor(expr.inputs, expr.inOuts ?? []);
          emitExpression(expr, (vm) => {
            vm.userCall(expr);
          });
          for (const [index, output] of expr.outputs.entries()) {
            emitExpression(expr, (_vm, frame) => {
              (frame.copies ??= []).push(frame.completed!.get(expr)!(index));
            });
            target(output.target);
            emitExpression(expr, (_vm, frame) => {
              frame.copies!.pop()!();
            });
          }
          emitExpression(expr, (_vm, frame) => {
            frame.completed?.delete(expr);
          });
          return;
        case "binary":
          valueAlways(expr.left);
          valueAlways(expr.right);
          break;
        case "unary":
          valueAlways(expr.operand);
          break;
        case "functionCall":
          for (const index of expr.evaluationOrder ?? expr.args.map((_, index) => index))
            valueAlways(expr.args[index]!);
          emitExpression(expr, (vm, frame) => {
            frame.values.set(
              expr,
              referenceLike(expr.dataType, vm.programMemory.ir.types) ||
                isAggregateType(expr.dataType, vm.programMemory.ir.types)
                ? vm.argumentValue(expr)
                : vm.standardCall(expr, true),
            );
          });
          for (const [index, output] of (expr.outputs ?? []).entries()) {
            emitExpression(expr, (_vm, frame) => {
              (frame.copies ??= []).push(frame.completed!.get(expr)!(index));
            });
            target(output.target);
            emitExpression(expr, (_vm, frame) => {
              frame.copies!.pop()!();
            });
          }
          emitExpression(expr, (_vm, frame) => {
            frame.completed?.delete(expr);
          });
          return;
        case "index":
        case "dereference":
        case "structureMember":
        case "userFbMember":
          address(expr);
          break;
        case "fbMember":
          if (expr.instance) address(expr.instance);
          break;
        case "elementBit":
          address(expr.element);
          break;
        case "referenceOf":
          if (expr.target.kind === "fbMember") {
            if (expr.target.instance) address(expr.target.instance);
          } else address(expr.target);
          break;
        case "instanceReference":
          if (expr.target) address(expr.target);
          break;
        case "arrayBound":
          if (["variable", "index", "structureMember", "userFbMember"].includes(expr.array.kind))
            address(expr.array as StorageReference);
          else valueAlways(expr.array);
          break;
      }
      emitExpression(expr, (vm, frame) => {
        frame.values.set(expr, vm.argumentValue(expr));
      });
    };
    const valueAlways = (expr: Expression): void => {
      value(expr);
      if (!Interpreter.hasCall(expr))
        emit((vm, frame) => {
          frame.values.set(expr, vm.argumentValue(expr));
        });
    };
    const jump = (destination: () => number) =>
      emit((_vm, frame) => {
        frame.pc = destination();
      });
    const list = (statements: readonly Statement[], exit?: () => number): void => {
      for (const statement of statements) {
        code.push({ statement, run: () => {} });
        switch (statement.kind) {
          case "if": {
            const ends: { destination: number }[] = [];
            for (const branch of statement.branches) {
              value(branch.condition);
              const next = { destination: 0 };
              emit((vm, frame) => {
                if (!vm.expression(branch.condition)) frame.pc = next.destination;
              });
              list(branch.body, exit);
              const end = { destination: 0 };
              ends.push(end);
              jump(() => end.destination);
              next.destination = code.length;
            }
            list(statement.elseBody, exit);
            for (const end of ends) end.destination = code.length;
            break;
          }
          case "case": {
            value(statement.selector);
            const starts: number[] = [];
            let otherwise = 0;
            emit((vm, frame) => {
              const selector = BigInt(vm.expression(statement.selector));
              const index = statement.branches.findIndex((branch) =>
                branch.labels.some((label) =>
                  label.kind === "value"
                    ? selector === BigInt(label.value)
                    : selector >= BigInt(label.lower) && selector <= BigInt(label.upper),
                ),
              );
              frame.pc = index < 0 ? otherwise : starts[index]!;
            });
            const ends: { destination: number }[] = [];
            for (const branch of statement.branches) {
              starts.push(code.length);
              list(branch.body, exit);
              const end = { destination: 0 };
              ends.push(end);
              jump(() => end.destination);
            }
            otherwise = code.length;
            list(statement.elseBody, exit);
            for (const end of ends) end.destination = code.length;
            break;
          }
          case "for": {
            valueAlways(statement.from);
            valueAlways(statement.to);
            valueAlways(statement.step);
            emit((vm, frame) => {
              const from = vm.expression(statement.from),
                to = BigInt(vm.expression(statement.to)),
                step = BigInt(vm.expression(statement.step));
              if (step === 0n) vm.fault("runtime.for-by-zero", statement.step.span);
              vm.assign(statement.variable, from);
              frame.loops.set(statement, { to, step });
            });
            const check = code.length;
            let end = 0;
            emit((vm, frame) => {
              const { to, step } = frame.loops.get(statement)!;
              const current = BigInt(vm.memory.read(statement.variable.variable));
              if (step > 0n ? current > to : current < to) frame.pc = end;
              else vm.iteration(statement.span);
            });
            list(statement.body, () => end);
            emit((vm, frame) => {
              vm.assign(
                statement.variable,
                BigInt(vm.memory.read(statement.variable.variable)) +
                  frame.loops.get(statement)!.step,
              );
            });
            jump(() => check);
            end = code.length;
            break;
          }
          case "while":
          case "repeat": {
            let end = 0;
            const check = code.length;
            if (statement.kind === "while") {
              emit((_vm, frame) => {
                frame.statement = statement;
                frame.values.clear();
                frame.locations.clear();
              });
              value(statement.condition);
              emit((vm, frame) => {
                if (!vm.expression(statement.condition)) frame.pc = end;
              });
            }
            emit((vm) => {
              vm.iteration(statement.span);
            });
            list(statement.body, () => end);
            if (statement.kind === "repeat") {
              emit((_vm, frame) => {
                frame.statement = statement;
                frame.values.clear();
                frame.locations.clear();
              });
              value(statement.until);
              emit((vm, frame) => {
                if (!vm.expression(statement.until)) frame.pc = check;
              });
            } else jump(() => check);
            end = code.length;
            break;
          }
          case "exit":
            if (exit) jump(exit);
            break;
          case "return":
            emit((_vm, frame) => {
              frame.pc = frame.code.length;
            });
            break;
          case "superCall":
            emit((vm) => {
              vm.superCall(statement.block);
            });
            break;
          case "userFbCall":
          case "fbCall":
            if (statement.instance) address(statement.instance);
            if (statement.kind === "userFbCall")
              argumentsFor(statement.inputs, statement.inOuts ?? []);
            else for (const input of statement.inputs) valueAlways(input.value);
            emit((vm) => {
              vm.blockCall(statement);
            });
            for (const [index, output] of (statement.outputs ?? []).entries()) {
              emit((_vm, frame) => {
                (frame.copies ??= []).push(frame.completed!.get(statement)!(index));
              });
              if (Interpreter.hasCall(output.target)) target(output.target);
              emit((_vm, frame) => {
                frame.copies!.pop()!();
              });
            }
            emit((vm, frame) => {
              vm.annotateBlock(statement);
              frame.completed?.delete(statement);
            });
            break;
          default:
            if (statement.kind === "assignment") {
              if (Interpreter.hasCall(statement.target)) {
                valueAlways(statement.value);
                target(statement.target);
              } else value(statement.value);
            } else if (statement.kind === "call") value(statement.call);
            emit((vm) => {
              vm.statement(statement);
            });
        }
      }
    };
    list(body);
    return code;
  }

  private static hasCall(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    if ("kind" in value && value.kind === "userFunctionCall") return true;
    return Object.entries(value).some(
      ([key, child]) => key !== "dataType" && key !== "span" && Interpreter.hasCall(child),
    );
  }

  private iterations = 0;
  private readonly functions: readonly UserFunctionIR[];
  private pou: string;
  private task = "Cyclic";
  private instancePath?: string;
  private receiver?: {
    frame: MemoryFrame;
    block: number;
    path: string;
    referenceAddress: () => ReferenceAddress;
  };

  constructor(
    private readonly programMemory: Memory,
    private readonly scanStart: number,
    private readonly active: () => boolean,
    private readonly library?: RuntimeLibrary,
    private readonly startBody?: (
      pou: string,
      instance: string | null,
      caller?: AnnotatedBody["caller"],
    ) => Map<Statement, StatementAnnotation> | undefined,
    private readonly recordFrames = false,
  ) {
    this.memory = programMemory.programFrame();
    this.functions = programMemory.ir.functions ?? [];
    this.pou = programMemory.ir.name;
  }

  transfer(index: number, output: boolean): void {
    const ir = this.programMemory.ir;
    if (ir.kind !== "configuration") return;
    const instance = ir.resource.programs[index]!;
    this.pou = ir.programs[instance.program]!.name;
    this.instancePath = instance.name;
    for (const connection of (output ? instance.outputs : instance.inputs) ?? []) {
      try {
        const parameter = this.programMemory.frame([connection.parameter]);
        const endpoint = connection.endpoint;
        const read = (frame: MemoryFrame): StoredValue => {
          const type = frame.descriptor(0);
          return referenceLike(type, ir.types)
            ? frame.readReference(0)
            : isAggregateType(type, ir.types)
              ? frame.aggregateValue(0)
              : frame.read(0);
        };
        if (output) {
          const value = read(parameter);
          if (endpoint.kind === "storage")
            this.store(this.programMemory.frame([endpoint.storage]), 0, value);
          else if (endpoint.kind === "address")
            this.programMemory.writeAddress(
              endpoint.address,
              typed(this.base(parameter.descriptor(0)), value as ScalarValue),
            );
        } else {
          const value =
            endpoint.kind === "storage"
              ? read(this.programMemory.frame([endpoint.storage]))
              : endpoint.kind === "address"
                ? this.programMemory.readAddress(
                    endpoint.address,
                    this.base(parameter.descriptor(0)),
                  )
                : endpoint.value;
          this.store(parameter, 0, value);
        }
      } catch (error) {
        if (error instanceof RangeError) {
          const fault = this.invalidValue(error, connection.span);
          throw new RuntimeFault({
            ...fault.diagnostic,
            pou: ir.name,
            sourceKind: "configuration",
            sourceIndex: 0,
          });
        }
        throw error;
      }
    }
  }

  /** Reuse the task budget while switching to an instance's persistent storage. */
  executeProgram(index = 0, pause?: PauseHook): boolean {
    const ir = this.programMemory.ir;
    this.memory = this.programMemory.programFrame(index);
    if (ir.kind === "configuration") {
      const instance = ir.resource.programs[index]!;
      const definition = ir.programs[instance.program]!;
      this.task = ir.resource.tasks[instance.task]!.name;
      this.pou = definition.name;
      this.instancePath = instance.name;
      this.push(definition.body, undefined, true, undefined, {
        kind: "PROGRAM",
        locals: definition.locals ?? [],
      });
    } else {
      this.pou = ir.name;
      this.instancePath = undefined;
      this.push(ir.body, undefined, true, undefined, {
        kind: "PROGRAM",
        locals:
          ir.storage?.flatMap((storage, slot) =>
            storage.kind === "temporary" ? [{ slot, name: storage.variable.name }] : [],
          ) ?? [],
      });
    }
    return this.resume(pause);
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
    const cached = this.frame?.values;
    if (cached?.has(expr)) return cached.get(expr) as ScalarValue;
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
    const cached = this.frame?.locations.get(ref);
    if (cached) return cached;
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
    if (this.frame?.values.has(expr)) return this.frame.values.get(expr) as ReferenceAddress | null;
    if (expr.kind === "null") return null;
    if (expr.kind === "instanceReference") {
      if (!expr.target) return this.receiver!.referenceAddress();
      const location = this.location(expr.target);
      return location.frame.address(location.variable);
    }
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
        args[i] = referenceLike(arg.dataType, this.programMemory.ir.types)
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
    if (this.frame?.values.has(expr)) return this.frame.values.get(expr) as AggregateValue;
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
      case "instanceReference":
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
          referenceLike(expr.left.dataType, this.programMemory.ir.types) ||
          referenceLike(expr.right.dataType, this.programMemory.ir.types)
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
      case "functionCall":
        return this.standardCall(expr);
      case "userFunctionCall": {
        const result = this.userCall(expr);
        if (result === null || isAggregateValue(result) || isReferenceAddress(result))
          throw new Error("Expected scalar function result");
        return result;
      }
    }
  }

  private standardCall(
    expr: import("@benchtop-plc/core").FunctionCallExpression,
    defer = false,
  ): ScalarValue {
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
    const copy = (index: number) => {
      const binding = expr.outputs![index]!;
      const value = outputs.get(binding.output);
      if (value === undefined) throw new Error("Missing function output");
      return () => {
        this.assign(binding.target, value);
      };
    };
    if (defer) (this.frame!.completed ??= new Map()).set(expr, copy);
    else for (let index = 0; index < (expr.outputs?.length ?? 0); index++) copy(index)();
    return result;
  }

  private annotate(statement: Statement, values: InlineValue[]): void {
    this.frame?.annotations?.set(statement, {
      span: { ...statement.span },
      values: values.map((value) => ({ ...value })),
    });
  }

  execute(body: readonly Statement[]): void {
    this.push(body);
    this.resume();
    return undefined;
  }

  /** Runs until completion or a statement hook requests a pause. */
  resume(pause?: PauseHook): boolean {
    while (this.stack.length && this.active()) {
      const frame = this.frame!;
      if (frame.pc >= frame.code.length) {
        this.stack.pop();
        try {
          frame.finish?.(false);
        } catch (error) {
          if (error instanceof RangeError && this.frame?.statement)
            throw this.invalidValue(error, this.frame.statement.span);
          throw error;
        }
        continue;
      }
      const instruction = frame.code[frame.pc]!;
      if (instruction.statement) {
        if (
          !this.skipPause &&
          pause?.({
            task: this.task,
            span: { ...instruction.statement.span },
            pou: this.pou,
            instancePath: this.instancePath ?? null,
          })
        ) {
          this.skipPause = true;
          return false;
        }
        this.skipPause = false;
        frame.statement = instruction.statement;
        frame.values.clear();
        frame.locations.clear();
      }
      frame.pc++;
      try {
        instruction.run(this, frame);
      } catch (error) {
        if (error instanceof RangeError && frame.statement)
          throw this.invalidValue(error, frame.statement.span);
        throw error;
      }
    }
    if (!this.active()) this.abandon();
    return true;
  }

  abandon(): void {
    while (this.stack.length) {
      const frame = this.stack.pop()!;
      frame.finish?.(true);
    }
    this.skipPause = false;
  }

  private statement(statement: Statement): void {
    switch (statement.kind) {
      case "assignment":
        if (referenceLike(statement.target.dataType, this.programMemory.ir.types)) {
          let value = this.referenceExpression(statement.value);
          if (statement.attempt && value) {
            const types = this.programMemory.ir.types;
            const target = interfaceType(statement.target.dataType, types);
            const blocks = this.programMemory.ir.functionBlocks!;
            let block: number | undefined = value.frame.userBlock(value.variable).block;
            if (target) {
              if (!blocks[block]!.interfaces?.includes(target.name)) value = null;
            } else {
              const ref = referenceType(statement.target.dataType, types)!;
              const type = resolveType(ref.target, types);
              if (typeof type !== "object" || type.kind !== "functionBlock")
                throw new Error("Invalid assignment attempt target");
              while (
                block !== undefined &&
                blocks[block]!.name.toUpperCase() !== type.name.toUpperCase()
              )
                block = blocks[block]!.base;
              if (block === undefined) value = null;
            }
          }
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
          const result = this.frame!.values.get(statement.call)!;
          if (
            statement.call.dataType !== null &&
            referenceLike(statement.call.dataType, this.programMemory.ir.types)
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
            this.annotate(statement, [typed(this.base(statement.call.dataType), result)]);
          break;
        }
        if (referenceLike(statement.call.dataType, this.programMemory.ir.types)) {
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
          typed(this.base(statement.call.dataType), this.expression(statement.call)),
        ]);
        break;
      }
      case "superCall":
        this.superCall(statement.block);
        break;
      case "fbCall":
      case "userFbCall":
        this.blockCall(statement);
        break;
      case "if":
      case "case":
      case "for":
      case "while":
      case "repeat":
      case "exit":
      case "return":
        throw new Error("Control flow must use lowered instructions");
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
    if (referenceLike(expr.dataType, this.programMemory.ir.types))
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

  /** Capture value outputs before target evaluation, which can call user code.
   * Reference outputs retain the existing order: resolve the target, then read the reference.
   */
  private prepareOutput(
    target: AssignmentTarget,
    frame: MemoryFrame,
    slot: number,
    type: TypeDescriptor,
  ): () => void {
    if (referenceLike(type, this.programMemory.ir.types))
      return () => {
        const destination = this.location(target as StorageReference);
        destination.frame.writeReference(destination.variable, frame.readReference(slot));
      };
    if (isAggregateType(type, this.programMemory.ir.types)) {
      const value = frame.aggregateValue(slot);
      return () => {
        this.assignAggregate(target, value);
      };
    }
    const to = this.base(target.dataType),
      from = this.base(type),
      value = frame.read(slot);
    const converted =
      isLongType(to) && from !== to
        ? convertValue(`${from}_TO_${to}` as ConversionFunction, value)
        : value;
    return () => {
      this.assign(target, converted);
    };
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
      (this.frame!.blockAnnotations ??= new Map()).set(call, outputs);
      (this.frame!.completed ??= new Map()).set(call, (index: number) => {
        const binding = call.outputs![index]!;
        const value = outputs[binding.output]!;
        const to = this.base(binding.target.dataType);
        const converted =
          isLongType(to) && value.dataType !== to
            ? convertValue(`${value.dataType}_TO_${to}` as ConversionFunction, value.value)
            : value.value;
        return () => {
          this.assign(binding.target, converted);
        };
      });
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
    const callerFrame = this.frame!;
    const caller = this.memory,
      callerPou = this.pou,
      callerPath = this.instancePath;
    const callerReceiver = this.receiver;
    this.receiver = instance;
    this.memory = instance.frame;
    this.pou =
      definition.bodyOwner === undefined
        ? definition.name
        : this.programMemory.ir.functionBlocks![definition.bodyOwner]!.name;
    this.instancePath = instance.path;
    this.push(
      definition.body,
      (abandoned) => {
        this.receiver = callerReceiver;
        instance.frame.unbind(definition.inOuts ?? []);
        this.memory = caller;
        this.pou = callerPou;
        this.instancePath = callerPath;
        if (abandoned) return;
        (callerFrame.completed ??= new Map()).set(call, (index: number) => {
          const binding = call.outputs![index]!;
          const variable = definition.variables[binding.output]!;
          if (!("dataType" in variable)) throw new Error("Invalid output type");
          return this.prepareOutput(
            binding.target,
            instance.frame,
            binding.output,
            variable.dataType,
          );
        });
      },
      true,
      undefined,
      this.recordFrames
        ? { kind: "FUNCTION_BLOCK", locals: this.blockLocals(definition) }
        : undefined,
    );
  }

  private annotateBlock(call: FunctionBlockCallStatement | UserFunctionBlockCallStatement): void {
    const location = call.instance
      ? this.location(call.instance)
      : { frame: this.memory, variable: call.variable };
    if (call.kind === "fbCall") {
      this.annotate(call, this.frame!.blockAnnotations!.get(call)!);
      this.frame!.blockAnnotations!.delete(call);
      return;
    }
    const instance = location.frame.userBlock(location.variable);
    const definition = this.programMemory.ir.functionBlocks![instance.block]!;
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

  private superCall(block: number): void {
    const definition = this.programMemory.ir.functionBlocks![block]!;
    const callerPou = this.pou;
    this.pou =
      definition.bodyOwner === undefined
        ? definition.name
        : this.programMemory.ir.functionBlocks![definition.bodyOwner]!.name;
    this.push(
      definition.body,
      () => {
        this.pou = callerPou;
      },
      true,
      undefined,
      this.recordFrames
        ? { kind: "FUNCTION_BLOCK", locals: this.blockLocals(definition) }
        : undefined,
    );
  }

  private captureReceiver(call: UserFunctionCall, frame: ExecutionFrame): void {
    // Resolve the receiver before any arguments, including indexed instance calls.
    let location = call.method?.receiver ? this.location(call.method.receiver) : undefined;
    if (call.method?.interface && location) {
      const address = location.frame.readReference(location.variable);
      if (!address) this.fault("runtime.null-reference", call.span);
      location = address;
    }
    const receiver = call.method
      ? location
        ? location.frame.userBlock(location.variable)
        : this.receiver
      : undefined;
    (frame.receivers ??= new Map()).set(call, receiver);
  }

  private userCall(call: UserFunctionCall): StoredValue {
    if (this.frame?.values.has(call)) return this.frame.values.get(call)!;
    const callerFrame = this.frame!;
    const receiver = callerFrame.receivers?.get(call);
    const staticMethod = call.method
      ? call.method.interface
        ? this.programMemory.ir.interfaces!.find((i) => i.name === call.method!.interface)!.methods[
            call.function
          ]
        : this.programMemory.ir.functionBlocks![call.method.block]!.methods![call.function]
      : undefined;
    const definition = call.method
      ? call.method.static
        ? staticMethod
        : this.programMemory.ir.functionBlocks![receiver!.block]!.methods![
            call.method.interface
              ? this.programMemory.ir.functionBlocks![receiver!.block]!.methodTable![
                  staticMethod!.name.toUpperCase()
                ]!
              : call.function
          ]
      : this.functions[call.function];
    if (!definition) throw new Error("Missing function body");
    // Signature order is stable across overrides; locals and receiver sizes are not.
    const parameterSlot = (slot: number, section: "inputs" | "outputs" | "inOuts"): number => {
      if (!staticMethod) return slot;
      const index = staticMethod[section]?.indexOf(slot) ?? -1;
      const target = definition[section]?.[index];
      if (target === undefined) throw new Error("Missing method parameter");
      return target;
    };
    const args = this.arguments(call.inputs, call.inOuts ?? []);
    const caller = this.memory,
      callerPou = this.pou,
      callerPath = this.instancePath;
    const callerReceiver = this.receiver;
    const locals = call.method
      ? receiver!.frame.methodFrame(definition as import("@benchtop-plc/core").UserMethodIR)
      : this.programMemory.functionFrame(call.function);
    for (const [slot, value] of args.values)
      this.store(locals, parameterSlot(slot, "inputs"), value);
    for (const [slot, actual] of args.aliases)
      locals.bind(parameterSlot(slot, "inOuts"), actual.frame, actual.variable);
    this.memory = locals;
    this.receiver = receiver;
    this.pou = receiver
      ? `${this.programMemory.ir.functionBlocks![(definition as import("@benchtop-plc/core").UserMethodIR).declaringType ?? receiver.block]!.name}.${definition.name}`
      : definition.name;
    this.instancePath = receiver?.path;
    this.push(
      definition.body,
      (abandoned) => {
        let result: StoredValue = null;
        try {
          if (!abandoned && definition.result !== undefined) {
            result = referenceLike(
              locals.descriptor(definition.result),
              this.programMemory.ir.types,
            )
              ? locals.readReference(definition.result)
              : isAggregateType(locals.descriptor(definition.result), this.programMemory.ir.types)
                ? locals.aggregateValue(definition.result)
                : locals.read(definition.result);
          }
        } finally {
          this.receiver = callerReceiver;
          this.memory = caller;
          this.pou = callerPou;
          this.instancePath = callerPath;
        }
        if (abandoned) return;
        callerFrame.values.set(call, result);
        (callerFrame.completed ??= new Map()).set(call, (index: number) => {
          const output = call.outputs[index]!;
          const slot = parameterSlot(output.variable, "outputs");
          return this.prepareOutput(output.target, locals, slot, locals.descriptor(slot));
        });
      },
      true,
      call.method
        ? undefined
        : {
            pou: callerPou,
            instance:
              callerPath ??
              (this.programMemory.ir.kind === "program" && callerPou === this.programMemory.ir.name
                ? this.programMemory.ir.name
                : null),
            line: call.span.line,
          },
      this.recordFrames
        ? {
            kind: call.method ? "METHOD" : "FUNCTION",
            locals: definition.variables.map((variable, index) => {
              const slot =
                index +
                (call.method
                  ? (definition as import("@benchtop-plc/core").UserMethodIR).memberCount
                  : 0);
              return {
                slot,
                name: variable.name,
                ...(definition.inOuts?.includes(slot) ? { inOut: true as const } : {}),
              };
            }),
          }
        : undefined,
    );
    return null;
  }
}
