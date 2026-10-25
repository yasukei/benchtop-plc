import type {
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
import { isCharacterType, isLongType, scalarBase, validateScalar } from "@benchtop-plc/core";
import { checkInterval } from "./clock.js";
import type { Clock, Ticker } from "./clock.js";
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
}

export interface Runtime {
  readonly state: RuntimeState;
  readonly diagnostic: Diagnostic | null;
  load(ir: ProgramIR | ConfigurationIR): void;
  setCycle(ms: number): void;
  run(): void;
  stop(): void;
  setEmergencyStop(active: boolean): void;
  coldReset(): void;
  watch(variables: readonly VariableId[]): void;
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
  private generation = 0;
  private count = 0;
  private duration = 0;
  private inputs = emptyImage();
  private outputs = emptyImage();
  private annotations: RuntimeSnapshot["annotations"] = {};
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
    this.halt("STOP");
    this.memory = memory;
    const implicitTask =
      ir.kind === "configuration" && !ir.explicit ? ir.resource.tasks[0] : undefined;
    this.interval =
      implicitTask && "intervalMs" in implicitTask
        ? implicitTask.intervalMs
        : (this.options.intervalMs ?? 10);
    this.watched.clear();
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
    this.annotations = {};
    this.inputs = emptyImage();
    this.memory?.clearOutputs();
  }

  setCycle(ms: number): void {
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
    if (this.state !== "STOP" || !this.memory || this.scanning) return;
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
    const memory = this.memory;
    const scheduler = this.scheduler;
    if (!memory || !scheduler || this.scanning || this.state === "FAULT" || this.state === "ESTOP")
      return this.snapshot();
    const start = this.options.clock.now();
    const generation = this.generation;
    const active = () => generation === this.generation;
    this.scanning = true;
    let ran = false;
    let executingInstance: string | undefined;
    let executingTask: string | undefined;
    try {
      // Event inputs use the live image without moving the task's image/write/force boundary.
      const eventImage = scheduler.tasks.some((task) => "single" in task)
        ? [...(this.options.stages?.readInputs?.() ?? this.inputs)]
        : this.inputs;
      const ready = scheduler.ready(start, singleScan, (input) => {
        if (input.kind === "address") return eventImage[input.address.bit]!;
        const force = this.forces.get(input.variable);
        if (force) return Boolean(force.value);
        const declaration = memory.ir.variables[input.variable];
        return declaration?.kind === "scalar" && declaration.address?.area === "I"
          ? eventImage[declaration.address.bit]!
          : Boolean(memory.read(input.variable));
      });
      if (ready.length) this.annotations = {};
      const ir = memory.ir;
      const instances =
        ir.kind === "configuration" ? ir.resource.programs : [{ program: 0, task: 0 }];
      for (const taskIndex of ready) {
        if (!active()) break;
        ran = true;
        executingTask = scheduler.tasks[taskIndex]!.name;
        executingInstance = undefined;
        const taskStart = this.options.clock.now();
        const interpreter = new Interpreter(memory, taskStart, active, this.library);
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
            try {
              if (active()) interpreter.executeProgram(index);
            } finally {
              // Only the first instance in resource declaration order supplies editor annotations.
              if (instances.findIndex((other) => other.program === instance.program) === index) {
                const name =
                  ir.kind === "configuration" ? ir.programs[instance.program]!.name : ir.name;
                const lines = interpreter.annotationSnapshot();
                if (Object.keys(lines).length)
                  Object.defineProperty(this.annotations, name, {
                    value: lines,
                    enumerable: true,
                    configurable: true,
                    writable: true,
                  });
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
      this.scanning = false;
    }
    return this.snapshot();
  }

  snapshot(): RuntimeSnapshot {
    const annotations = Object.fromEntries(
      Object.entries(this.annotations).map(([pou, lines]) => [
        pou,
        Object.fromEntries(
          Object.entries(lines).map(([line, entries]) => [
            line,
            entries.map((entry) => ({
              span: { ...entry.span },
              values: entry.values.map((value) => ({ ...value })),
            })),
          ]),
        ),
      ]),
    );
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
