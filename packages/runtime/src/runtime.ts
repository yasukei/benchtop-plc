import type {
  CommandRejectionCode,
  Diagnostic,
  IoImage,
  ProgramIR,
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
  load(ir: ProgramIR): void;
  run(): void;
  stop(): void;
  setEmergencyStop(active: boolean): void;
  coldReset(): void;
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
  private pendingWrites = new Map<VariableId, TypedValue>();
  private readonly interval: number;
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

  load(ir: ProgramIR): void {
    if (this.scanning) throw new Error("Cannot load during a scan");
    const memory = new Memory(ir, this.library);
    this.halt("STOP");
    this.memory = memory;
    this.initialize();
  }

  private initialize(): void {
    this.forces.clear();
    this.pendingWrites.clear();
    this.count = 0;
    this.duration = 0;
    this.fault = null;
    this.annotations = {};
    this.inputs = emptyImage();
    this.memory?.clearOutputs();
  }

  run(): void {
    if (this.state !== "STOP" || !this.memory || this.scanning) return;
    this.operatingState = "RUN";
    const generation = ++this.generation;
    try {
      const cancel = this.options.ticker.start(this.interval, () => {
        if (this.state === "RUN" && generation === this.generation) this.scanOnce();
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

  force(variable: VariableId, value: TypedValue | null): void {
    this.debugVariable(variable);
    if (value === null) this.forces.delete(variable);
    else this.forces.set(variable, this.debugValue(variable, value));
  }

  write(variable: VariableId, value: TypedValue): void {
    const declaration = this.debugVariable(variable);
    if (declaration.address?.area === "I")
      throw new RuntimeCommandRejected({
        code: "runtime.write-input-mapped",
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
    const memory = this.memory;
    if (!memory || this.scanning || this.state === "FAULT" || this.state === "ESTOP")
      return this.snapshot();
    const start = this.options.clock.now();
    const generation = this.generation;
    const active = () => generation === this.generation;
    const interpreter = new Interpreter(memory, start, active, this.library);
    this.scanning = true;
    this.annotations = {};
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
      if (active()) interpreter.execute(memory.ir.body);
      if (active()) this.options.stages?.applyForces?.(memory);
      if (active()) this.applyForces(memory);
      if (active() && this.state === "RUN") {
        this.outputs = memory.outputImage();
        this.options.stages?.writeOutputs?.([...this.outputs]);
      }
    } catch (error) {
      if (error instanceof RuntimeFault) {
        if (active()) {
          this.fault = error.diagnostic;
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
      this.annotations = interpreter.annotationSnapshot();
      this.count++;
      this.duration = this.options.clock.now() - start;
      this.scanning = false;
    }
    return this.snapshot();
  }

  snapshot(): RuntimeSnapshot {
    const annotations: RuntimeSnapshot["annotations"] = {};
    for (const [line, entries] of Object.entries(this.annotations)) {
      annotations[Number(line)] = entries.map((entry) => ({
        span: { ...entry.span },
        values: entry.values.map((value) => ({ ...value })),
      }));
    }
    return {
      scanCount: this.count,
      lastExecutionTimeMs: this.duration,
      inputs: [...this.inputs],
      outputs: [...this.outputs],
      variables: this.memory?.snapshot() ?? [],
      forced: [...this.forces.keys()].sort((left, right) => left - right),
      annotations,
    };
  }
}
