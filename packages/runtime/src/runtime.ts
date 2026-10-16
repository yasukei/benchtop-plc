import type {
  Diagnostic,
  IoImage,
  ProgramIR,
  RuntimeSnapshot,
  RuntimeState,
} from "@benchtop-plc/core";
import { checkInterval } from "./clock.js";
import type { Clock, Ticker } from "./clock.js";
import { Interpreter, RuntimeFault } from "./interpreter.js";
import type { RuntimeLibrary } from "./library.js";
import { emptyImage, Memory } from "./memory.js";
import type { ScanMemory } from "./memory.js";

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
  scanOnce(): RuntimeSnapshot;
  snapshot(): RuntimeSnapshot;
}

export function createRuntime(options: RuntimeOptions): Runtime {
  return new PlcRuntime(options);
}

type OperatingState = Exclude<RuntimeState, "ESTOP">;

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
  private readonly interval: number;

  constructor(private readonly options: RuntimeOptions) {
    this.interval = options.intervalMs ?? 10;
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
    const memory = new Memory(ir, this.options.library);
    this.halt("STOP");
    this.memory = memory;
    this.initialize();
  }

  private initialize(): void {
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
    if (this.memory) this.memory = new Memory(this.memory.ir, this.options.library);
    this.initialize();
  }

  scanOnce(): RuntimeSnapshot {
    const memory = this.memory;
    if (!memory || this.scanning || this.state === "FAULT" || this.state === "ESTOP")
      return this.snapshot();
    const start = this.options.clock.now();
    const generation = this.generation;
    const active = () => generation === this.generation;
    const interpreter = new Interpreter(memory, start, active, this.options.library);
    this.scanning = true;
    this.annotations = {};
    try {
      this.inputs = [...(this.options.stages?.readInputs?.() ?? this.inputs)];
      if (active()) memory.readInputs(this.inputs);
      if (active()) this.options.stages?.applyPendingWrites?.(memory);
      if (active()) this.options.stages?.applyForces?.(memory);
      if (active()) interpreter.execute(memory.ir.body);
      if (active()) this.options.stages?.applyForces?.(memory);
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
      forced: [],
      annotations,
    };
  }
}
