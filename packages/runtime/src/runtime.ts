import type {
  BodyWatch,
  AnnotatedBody,
  Statement,
  StatementAnnotation,
  RetentiveRecord,
  CommandRejectionCode,
  Diagnostic,
  IoImage,
  ProgramIR,
  ConfigurationIR,
  RuntimeSnapshot,
  RuntimeState,
  TypedValue,
  VariableId,
} from "@benchtop-plc/core";
import {
  readDirectValue,
  isCharacterType,
  isLongType,
  scalarBase,
  validateScalar,
} from "@benchtop-plc/core";
import { checkInterval } from "./clock.js";
import type { Clock, Ticker } from "./clock.js";
import type { PauseHook, PauseLocation } from "./interpreter.js";
import { Interpreter, RuntimeFault } from "./interpreter.js";
import type { RuntimeLibrary } from "./library.js";
import { emptyImage, Memory, typed } from "./memory.js";
import type { ScanMemory } from "./memory.js";
import { standardLibrary } from "./standard-library.js";
import { TaskScheduler } from "./task-scheduler.js";

export interface ScanStages {
  readInputs?(): IoImage;
  applyPendingWrites?(memory: ScanMemory): void;
  applyForces?(memory: ScanMemory): void;
  writeOutputs?(outputs: IoImage): void;
}

export interface RuntimeOptions {
  clock: Clock;
  ticker: Ticker;
  intervalMs?: number;
  library?: RuntimeLibrary;
  stages?: ScanStages;
  /** Internal statement-boundary hook; no protocol or operating-state change. */
  pause?: PauseHook;
}

export interface Runtime {
  readonly state: RuntimeState;
  readonly diagnostic: Diagnostic | null;
  readonly pauseLocation: PauseLocation | null;
  resume(): RuntimeSnapshot;
  load(ir: ProgramIR | ConfigurationIR): void;
  setCycle(ms: number): void;
  run(): void;
  stop(): void;
  setEmergencyStop(active: boolean): void;
  coldReset(): void;
  warmRestart(): void;
  retentiveRecords(): RetentiveRecord[];
  restoreRetentive(records: readonly RetentiveRecord[]): string[];
  watch(variables: readonly VariableId[]): void;
  watchBodies(bodies: readonly BodyWatch[]): void;
  force(variable: VariableId, value: TypedValue | null): void;
  write(variable: VariableId, value: TypedValue): void;
  step(): RuntimeSnapshot;
  scanOnce(): RuntimeSnapshot;
  snapshot(): RuntimeSnapshot;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  return new PlcRuntime(options);
}

type OperatingState = Exclude<RuntimeState, "ESTOP">;

/** Expected validation failures, distinguished from host/library programming errors. */
export class RuntimeCommandRejected extends Error {
  constructor(readonly diagnostic: Diagnostic<CommandRejectionCode>) {
    super(diagnostic.code);
    this.name = "RuntimeCommandRejected";
  }
}

class PlcRuntime implements Runtime {
  private operatingState: OperatingState = "STOP";
  private emergencyStop = false;
  private fault: Diagnostic | null = null;
  private memory: Memory | undefined;
  private cancel: (() => void) | undefined;
  private scanning = false;
  private pass?: Generator<void, void, void>;
  private location: PauseLocation | null = null;
  get pauseLocation(): PauseLocation | null {
    return this.location ? { ...this.location, span: { ...this.location.span } } : null;
  }
  private generation = 0;
  private count = 0;
  private duration = 0;
  private inputs = emptyImage();
  private outputs = emptyImage();
  private readonly annotations = new Map<
    string,
    { body: Omit<AnnotatedBody, "lines">; entries: Map<Statement, StatementAnnotation> }
  >();
  private bodyWatches: readonly BodyWatch[] = [];
  private readonly forces = new Map<VariableId, TypedValue>();
  private watched = new Set<VariableId>();
  private pendingWrites = new Map<VariableId, TypedValue>();
  private interval: number;
  private scheduler?: TaskScheduler;
  private readonly library: RuntimeLibrary;

  constructor(private readonly options: RuntimeOptions) {
    this.interval = options.intervalMs ?? 10;
    this.library = options.library ?? standardLibrary;
    checkInterval(this.interval);
  }

  get state(): RuntimeState {
    return this.emergencyStop ? "ESTOP" : this.operatingState;
  }
  get diagnostic(): Diagnostic | null {
    return this.fault
      ? ({
          ...this.fault,
          args: { ...this.fault.args },
          ...(this.fault.span ? { span: { ...this.fault.span } } : {}),
        } as Diagnostic)
      : null;
  }

  private halt(state: OperatingState): void {
    this.operatingState = state;
    this.generation++;
    if (!this.scanning) {
      this.pass?.return();
      this.pass = undefined;
      this.location = null;
    }
    const cancel = this.cancel;
    this.cancel = undefined;
    cancel?.();
    this.memory?.clearOutputs();
    this.outputs = emptyImage();
    this.options.stages?.writeOutputs?.([...this.outputs]);
  }

  load(ir: ProgramIR | ConfigurationIR): void {
    if (this.scanning) throw new Error("Cannot load during a scan");
    const memory = new Memory(ir, this.library);
    Interpreter.prepare(ir);
    this.halt("STOP");
    this.memory = memory;
    const implicitTask =
      ir.kind === "configuration" && !ir.explicit ? ir.resource.tasks[0] : undefined;
    this.interval =
      implicitTask && "intervalMs" in implicitTask
        ? implicitTask.intervalMs
        : (this.options.intervalMs ?? 10);
    this.watched.clear();
    this.bodyWatches =
      ir.kind === "configuration"
        ? ir.programs.flatMap((program, index) => {
            const instance = ir.resource.programs.find((instance) => instance.program === index);
            return instance ? [{ pou: program.name, instance: instance.name }] : [];
          })
        : [{ pou: ir.name, instance: ir.name }];
    this.initialize();
  }

  private initialize(): void {
    const ir = this.memory?.ir;
    this.scheduler = ir
      ? new TaskScheduler(
          ir.kind === "configuration"
            ? ir.resource.tasks.map((task) =>
                !ir.explicit && "intervalMs" in task
                  ? { ...task, intervalMs: this.interval }
                  : { ...task },
              )
            : [{ name: "Cyclic", intervalMs: this.interval, priority: 1 }],
        )
      : undefined;
    this.interval = this.scheduler?.intervalMs ?? this.options.intervalMs ?? 10;
    this.forces.clear();
    this.pendingWrites.clear();
    this.count = 0;
    this.duration = 0;
    this.fault = null;
    this.annotations.clear();
    this.inputs = emptyImage();
    this.memory?.clearOutputs();
  }

  setCycle(ms: number): void {
    if (this.location) return;
    if (this.memory?.ir.kind === "configuration" && this.memory.ir.explicit)
      throw new RuntimeCommandRejected({
        code: "runtime.configured-cycle",
        severity: "error",
        args: {},
      });
    checkInterval(ms);
    const running = this.state === "RUN";
    if (running) {
      this.generation++;
      this.cancel?.();
      this.cancel = undefined;
    }
    this.interval = ms;
    const task = this.scheduler?.tasks[0];
    if (task && "intervalMs" in task) task.intervalMs = ms;
    if (running) this.startTicker();
  }

  run(): void {
    if (this.state !== "STOP" || !this.memory || this.scanning || this.pass) return;
    this.operatingState = "RUN";
    this.startTicker();
  }

  private startTicker(): void {
    const generation = ++this.generation;
    this.scheduler?.resume(this.options.clock.now());
    try {
      const cancel = this.options.ticker.start(this.interval, () => {
        if (this.state === "RUN" && generation === this.generation) this.scanPass(false);
      });
      if (this.isRunning() && generation === this.generation) this.cancel = cancel;
      else cancel();
    } catch (error) {
      this.halt("STOP");
      throw error;
    }
  }

  private isRunning(): boolean {
    return !this.emergencyStop && this.operatingState === "RUN";
  }

  stop(): void {
    this.halt(this.operatingState === "RUN" ? "STOP" : this.operatingState);
  }

  setEmergencyStop(active: boolean): void {
    if (active === this.emergencyStop) return;
    this.emergencyStop = active;
    this.halt(!active && this.operatingState === "RUN" ? "STOP" : this.operatingState);
  }

  coldReset(): void {
    if (this.scanning) throw new Error("Cannot reset during a scan");
    this.halt("STOP");
    if (this.memory) this.memory = new Memory(this.memory.ir, this.library);
    this.initialize();
  }

  warmRestart(): void {
    const records = this.retentiveRecords();
    this.coldReset();
    this.memory?.restoreRetentive(records);
  }

  retentiveRecords(): RetentiveRecord[] {
    return this.memory?.retentiveRecords() ?? [];
  }

  restoreRetentive(records: readonly RetentiveRecord[]): string[] {
    this.coldReset();
    return this.memory?.restoreRetentive(records) ?? records.map((record) => record.path);
  }

  private debugVariable(variable: VariableId) {
    const declaration = Number.isInteger(variable) && this.memory?.ir.variables[variable];
    if (!declaration || declaration.kind !== "scalar")
      throw new RuntimeCommandRejected({
        code: "runtime.debug-target",
        severity: "error",
        args: {},
      });
    return declaration;
  }

  private debugValue(variable: VariableId, value: TypedValue): TypedValue {
    const declaration = this.debugVariable(variable);
    if (scalarBase(declaration.dataType, this.memory?.ir.types) !== value.dataType)
      throw new RuntimeCommandRejected({
        code: "runtime.debug-type-mismatch",
        severity: "error",
        args: { from: value.dataType, to: declaration.dataType },
      });
    if (
      typeof value.value !==
      (value.dataType === "BOOL"
        ? "boolean"
        : isLongType(value.dataType) || isCharacterType(value.dataType)
          ? "string"
          : "number")
    )
      throw new RuntimeCommandRejected({
        code: "runtime.debug-value",
        severity: "error",
        args: {},
      });
    try {
      validateScalar(declaration.dataType, value.value, this.memory?.ir.types);
      return typed(value.dataType, value.value);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new RuntimeCommandRejected({
        code: "runtime.debug-value",
        severity: "error",
        args: {},
      });
    }
  }

  watch(variables: readonly VariableId[]): void {
    this.watched = new Set(
      variables.filter((id) => Number.isInteger(id) && this.memory?.ir.variables[id]),
    );
  }

  watchBodies(bodies: readonly BodyWatch[]): void {
    this.bodyWatches = bodies.map((body) => ({ ...body }));
  }

  force(variable: VariableId, value: TypedValue | null): void {
    this.debugVariable(variable);
    if (value === null) this.forces.delete(variable);
    else this.forces.set(variable, this.debugValue(variable, value));
  }

  write(variable: VariableId, value: TypedValue): void {
    const declaration = this.debugVariable(variable);
    if (declaration.address?.area === "I" || declaration.connectedInput)
      throw new RuntimeCommandRejected({
        code: declaration.connectedInput
          ? "runtime.write-connected-input"
          : "runtime.write-input-mapped",
        severity: "error",
        args: { name: declaration.name },
      });
    const checked = this.debugValue(variable, value);
    if (this.state === "RUN" || this.scanning) this.pendingWrites.set(variable, checked);
    else {
      this.pendingWrites.delete(variable);
      this.memory?.write(variable, checked.value);
      // Debug commands cannot energize outputs outside RUN (ADR 0009).
      this.memory?.clearOutputs();
    }
  }

  step(): RuntimeSnapshot {
    return this.state === "STOP" ? this.scanOnce() : this.snapshot();
  }

  private applyForces(memory: Memory): void {
    for (const [variable, value] of this.forces) memory.write(variable, value.value);
  }

  scanOnce(): RuntimeSnapshot {
    return this.scanPass(true);
  }

  private scanPass(singleScan: boolean): RuntimeSnapshot {
    if (this.pass || this.scanning) return this.snapshot();
    this.pass = this.executePass(singleScan);
    return this.advancePass();
  }

  resume(): RuntimeSnapshot {
    return !this.scanning && this.pass && this.location ? this.advancePass() : this.snapshot();
  }

  private advancePass(): RuntimeSnapshot {
    this.location = null;
    this.scanning = true;
    try {
      if (this.pass?.next().done) this.pass = undefined;
    } catch (error) {
      this.pass = undefined;
      throw error;
    } finally {
      this.scanning = false;
    }
    return this.snapshot();
  }

  private *executePass(singleScan: boolean): Generator<void, void, void> {
    const memory = this.memory;
    const scheduler = this.scheduler;
    if (!memory || !scheduler || this.state === "FAULT" || this.state === "ESTOP") return;
    const start = this.options.clock.now();
    const generation = this.generation;
    const active = () => generation === this.generation;
    let ran = false;
    let executingInstance: string | undefined;
    let executingTask: string | undefined;
    try {
      // Event inputs use the live image without moving the task's image/write/force boundary.
      const eventImage = scheduler.tasks.some((task) => "single" in task)
        ? [...(this.options.stages?.readInputs?.() ?? this.inputs)]
        : this.inputs;
      const ready = scheduler.ready(start, singleScan, (input) => {
        if (input.kind === "address")
          return Boolean(readDirectValue(eventImage, input.address, "BOOL"));
        const force = this.forces.get(input.variable);
        if (force) return Boolean(force.value);
        const declaration = memory.ir.variables[input.variable];
        return declaration?.kind === "scalar" && declaration.address?.area === "I"
          ? Boolean(readDirectValue(eventImage, declaration.address, "BOOL"))
          : Boolean(memory.read(input.variable));
      });
      const ir = memory.ir;
      const instances =
        ir.kind === "configuration" ? ir.resource.programs : [{ program: 0, task: 0 }];
      for (const taskIndex of ready) {
        if (!active()) break;
        ran = true;
        executingTask = scheduler.tasks[taskIndex]!.name;
        executingInstance = undefined;
        const taskStart = this.options.clock.now();
        // Capture the watch set at the task boundary, including for resumable runs.
        const watches = new Set(
          this.bodyWatches.map((body) =>
            JSON.stringify([body.pou.toUpperCase(), body.instance?.toUpperCase()]),
          ),
        );
        for (const key of this.annotations.keys())
          if (!watches.has(key)) this.annotations.delete(key);
        const interpreter = new Interpreter(
          memory,
          taskStart,
          active,
          this.library,
          (pou, instance) => {
            const key = JSON.stringify([pou.toUpperCase(), instance.toUpperCase()]);
            if (!watches.has(key)) return undefined;
            const entries = new Map<Statement, StatementAnnotation>();
            this.annotations.set(key, {
              body: { pou, instance, scanCount: this.count + 1 },
              entries,
            });
            return entries;
          },
        );
        try {
          this.inputs = [...(this.options.stages?.readInputs?.() ?? this.inputs)];
          if (active()) memory.readInputs(this.inputs);
          if (active()) {
            const writes = this.pendingWrites;
            this.pendingWrites = new Map();
            for (const [variable, value] of writes) memory.write(variable, value.value);
          }
          if (active()) this.options.stages?.applyPendingWrites?.(memory);
          if (active()) this.applyForces(memory);
          if (active()) this.options.stages?.applyForces?.(memory);
          let instanceCount = 0;
          for (const [index, instance] of instances.entries()) {
            if (!active()) break;
            if (instance.task !== taskIndex) continue;
            executingInstance =
              ir.kind === "configuration" ? ir.resource.programs[index]!.name : undefined;
            interpreter.transfer(index, false);
            if (active()) this.applyForces(memory);
            if (
              active() &&
              (instanceCount > 0 ||
                (ir.kind === "configuration" && ir.resource.programs[index]!.inputs?.length))
            )
              this.options.stages?.applyForces?.(memory);
            if (active()) {
              const pause: PauseHook | undefined = this.options.pause
                ? (location) => {
                    if (!this.options.pause!(location)) return false;
                    this.location = location;
                    return true;
                  }
                : undefined;
              let completed = interpreter.executeProgram(index, pause);
              while (!completed && active()) {
                yield;
                if (active()) completed = interpreter.resume(pause);
              }
            }
            if (active()) this.options.stages?.applyForces?.(memory);
            if (active()) this.applyForces(memory);
            if (active()) interpreter.transfer(index, true);
            if (active()) this.applyForces(memory);
            if (
              active() &&
              ir.kind === "configuration" &&
              ir.resource.programs[index]!.outputs?.length
            )
              this.options.stages?.applyForces?.(memory);
            instanceCount++;
          }
          if (active() && this.state === "RUN") {
            this.outputs = memory.outputImage();
            this.options.stages?.writeOutputs?.([...this.outputs]);
          }
        } finally {
          interpreter.abandon();
          scheduler.finish(taskIndex, taskStart, this.options.clock.now(), singleScan);
        }
      }
    } catch (error) {
      if (error instanceof RuntimeFault) {
        if (active()) {
          this.fault = {
            ...error.diagnostic,
            ...(memory.ir.kind === "configuration"
              ? { task: executingTask, instance: error.diagnostic.instance ?? executingInstance }
              : {}),
          };
          this.halt("FAULT");
        }
      } else {
        // Host/library programming errors also de-energize outputs, then reach the host.
        if (active()) this.halt("FAULT");
        throw error;
      }
    } finally {
      if (this.state !== "RUN" || !active()) {
        memory.clearOutputs();
        this.outputs = emptyImage();
      }
      if (ran) {
        this.count++;
        this.duration = this.options.clock.now() - start;
      }
      this.location = null;
    }
  }

  snapshot(): RuntimeSnapshot {
    const annotations: AnnotatedBody[] = [];
    for (const { body, entries } of this.annotations.values()) {
      if (!entries.size) continue;
      const lines: AnnotatedBody["lines"] = {};
      for (const entry of entries.values())
        (lines[entry.span.line] ??= []).push({
          span: { ...entry.span },
          values: entry.values.map((value) => ({ ...value })),
        });
      for (const line of Object.values(lines)) line.sort((a, b) => a.span.column - b.span.column);
      annotations.push({ ...body, lines });
    }
    const compact = this.memory?.ir.variables.some((variable) => variable.watched);
    const ids = compact
      ? this.memory!.ir.variables.flatMap((variable, id) =>
          !variable.watched || this.watched.has(id) || this.forces.has(id) ? [id] : [],
        )
      : undefined;
    return {
      ...(ids ? { variableIds: ids } : {}),
      tasks: this.scheduler?.snapshot() ?? [],
      scanCount: this.count,
      lastExecutionTimeMs: this.duration,
      inputs: [...this.inputs],
      outputs: [...this.outputs],
      variables: this.memory?.snapshot(ids) ?? [],
      forced: [...this.forces.keys()].sort((left, right) => left - right),
      annotations,
    };
  }
}
