# 0018. Debugging: instance selection, breakpoints and stepping

- Status: Accepted
- Date: 2026-10-26
- Related: [0002](0002-tree-shaped-ir-as-plain-data.md),
  [0003](0003-injected-clock.md),
  [0007](0007-react-ui-with-logic-outside-components.md),
  [0009](0009-emergency-stop-overlay.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md),
  [0011](0011-versioning-changelog-and-releases.md),
  [0014](0014-user-defined-pous.md),
  [0015](0015-derived-types-strings-and-references.md),
  [0016](0016-configurations-tasks-and-global-variables.md),
  [0017](0017-classes-methods-interfaces-and-namespaces.md)
- Source: [issue #193](https://github.com/yasukei/benchtop-plc/issues/193)

## Context

Milestone 8 adds debugging. ADR 0014, ADR 0016 and ADR 0017 deferred it explicitly, and
today:

- Snapshots carry annotations keyed by POU name and line. Only `PROGRAM` statements
  are annotated, and only from the first instance of each `PROGRAM` in resource
  declaration order. Function and method variables never appear in snapshots.
- The interpreter runs each task run to completion as nested synchronous calls. The
  Worker handles UI messages only between scheduler passes.
- The operating state is `STOP`, `RUN` or `FAULT`, with no transitional states
  (ADR 0010). The emergency stop is a flag laid over it (ADR 0009). The finest
  control is a single scan, which runs one pass in `STOP`.
- Time comes from the injected clock (ADR 0003). Function block timers read the start
  time of their task run, and conformance traces use a virtual clock.
- Scheduling is non-preemptive (ADR 0016): no task run ever observes another task
  run's partial work.
- The app is hosted on GitHub Pages, which cannot send the
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers. Without
  them a page is not cross-origin isolated, so `SharedArrayBuffer` and `Atomics.wait`
  are unavailable and a Worker cannot simply block until the UI tells it to go on.

IEC 61131-3 does not define debugging. The decisions below follow the behavior of
vendor tools where it fits benchtop-plc's contracts (CODESYS and TwinCAT, which share
the CODESYS debugger, and Siemens S7-1500 with TIA Portal), and say where they
differ. The implementation issues under
[#192](https://github.com/yasukei/benchtop-plc/issues/192) need one model, because
the features change the runtime, the core protocol and the web app together.

## Decision

### Terms

- An **instance path** is the display path the monitor already uses for an
  instance: a `PROGRAM` instance name (`Line1`, or the implicit instance name under
  the implicit configuration), followed by member names and indices (`Line1.M2`,
  `Line1.Pumps[2]`, `Line1.Gate.Motor`). A global function block or class instance is
  named by its own name (`gConveyor`). References and interface variables are not
  instances; they point to instances that have paths.
- A **body** is the statement list of a `PROGRAM`, a function, a function block, or a
  method of a function block or class. A class has no body of its own, only methods.
- A **halt point** is the start of a statement in a body. Compound statements (`IF`,
  `CASE`, `FOR`, `WHILE`, `REPEAT`) are halt points once, when they start; their
  conditions are not halt points when they are evaluated again. The statements inside
  them are halt points of their own.
- A **frame** is one running invocation of a body: a `PROGRAM` instance run, a
  function block body call, a method call or a function call.

### Instances and inline values

- The user chooses the instance whose values a body shows. The choice belongs to the
  source:

  | Source           | Instances offered                                               | Default                                                          |
  | ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
  | `PROGRAM`        | Its configured instances                                        | The first in resource declaration order, as ADR 0016 shows today |
  | `FUNCTION_BLOCK` | Every instance of the type, and of every type derived from it   | The first in monitor order                                       |
  | Class            | Every instance of the class, and of every class derived from it | The first in monitor order                                       |
  | Function         | None                                                            | –                                                                |

  Monitor order lists the instances inside each `PROGRAM` instance, in resource
  declaration order, then global instances in declaration order. Within an instance,
  members follow declaration order, base members first (ADR 0017), and array elements
  follow index order. The list names each instance by its path, shows its type when it
  is a derived type, and has a text filter, since an array of instances lists every
  element. Instance selection is how CODESYS works too: an editor opened from an
  instance monitors that instance.

- The body of a function block, and the methods of a function block or class, show the
  selected instance. Example: in the motor starters example, whose `Main` runs as
  `mainInstance` and declares `M1, M2 : MotorStarter;`, selecting `mainInstance.M2` in
  the `MotorStarter` source shows the values `M2` computed, and its method bodies show
  `M2`'s calls.
- A base type's body and methods show a derived instance when the derived instance
  runs them: through an inherited body (a derived body without statements, ADR 0017),
  through `SUPER()` and `SUPER.M()`, or by calling a method the derived type does not
  override. Example: `Servo1 : Servo;` with `Servo EXTENDS Motor` and no override of
  `Motor.Start`; selecting `mainInstance.Servo1` in the `Motor` source shows
  `Servo1`'s call of `Start`. An overridden base method shows nothing for a call it did
  not run.
- A function body has no instance. It shows its last call in the latest pass in which
  it ran, and names that call's caller: its POU, its instance path when it has one,
  and the line of the call (`Called from Main (mainInstance), line 12`).
- A method body shows the last call of that method on the selected instance.
- Values follow the existing annotation rules (core protocol): one entry per executed
  assignment, function or method call statement, or function block call, holding its
  last execution in that invocation. A body's values for an instance are cleared when
  that body starts running for that instance, and are kept until then, so a body that
  is skipped in a pass keeps its older values. Each annotated body carries the pass
  number (`scanCount`) it comes from, and the editor marks values older than the
  latest pass (`from scan 41`). A faulting run keeps the statements it completed.
- A body with no instance to show (a `PROGRAM` without instances, a type nobody
  declares) shows no values and says so. A function that never ran shows no values.

### Watching bodies

- The runtime annotates only the bodies the UI watches, so unwatched bodies cost
  nothing. A watch names a POU and an instance path (`null` for a function); a watch on
  a function block or class instance covers its body and all its methods. The UI
  watches the selected instance of every `PROGRAM`, which keeps today's behavior of
  `PROGRAM` editors, and the selected instance of the source open in the editor.
- A new watch takes effect from the next task run. In `STOP` the values appear with
  the next single scan. Example: opening the `MotorStarter` source in `STOP` shows no
  values for `mainInstance.M2` until the next single scan, while `Main` keeps showing
  the values of its latest run.
- While debugging is active, meaning at least one breakpoint is set or a step is
  pending, every frame also records the annotations of its own invocation, watched or
  not, so a halt can show the values of every frame on the call stack (see Call stack).
  The switch happens at task-run boundaries.

### Halting

- A halt stops execution before a halt point and keeps the interrupted task run, with
  its whole call stack, until the user continues, steps or abandons it.
- **Halt is a flag laid over the operating state**, as the emergency stop is
  (ADR 0009). The operating state underneath stays `RUN` or `STOP`, so ADR 0010's
  states and transitions are unchanged and it is not superseded. Outputs still follow
  the operating state, as ADR 0010 requires (see Inputs, outputs and time).
- This extends ADR 0009's reporting rule: the public state reports `ESTOP` while the
  emergency stop is active, otherwise `HALT` while halted, otherwise the operating
  state. A halt never coexists with an active emergency stop or with `FAULT`, because
  both end it (see the table).
- A halt can start only while a task run executes: in `RUN`, or during a single scan
  in `STOP`.
- **The whole resource halts**, not only the task that reached the halt point: no
  other task runs while halted. CODESYS halts only the task that reached the
  breakpoint and lets the others run. benchtop-plc schedules non-preemptively
  (ADR 0016), so letting other tasks run while one is halted in the middle of its run
  would create interleavings the program never sees without the debugger.

| Halted over | Event                          | Result                                                                                 |
| ----------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| RUN         | continue                       | The halted run resumes; cyclic execution continues in `RUN`                            |
| STOP        | continue                       | The halted single scan resumes and completes; the state stays `STOP`                   |
| RUN, STOP   | step over, into or out         | The run resumes until the step's target (see Stepping)                                 |
| RUN         | stop                           | The rest of the halted run is abandoned; `STOP`                                        |
| STOP        | stop                           | The rest of the halted single scan is abandoned; `STOP`                                |
| RUN, STOP   | run, single scan, set cycle    | Rejected (`runtime.halted`); nothing changes                                           |
| RUN, STOP   | warm restart, cold reset, load | The halted run is abandoned, then the command acts as in ADR 0010 and ADR 0016; `STOP` |
| RUN, STOP   | emergency stop                 | The halted run is abandoned and the flag is set; release gives `STOP` (ADR 0009)       |
| RUN, STOP   | run-time error while resuming  | `FAULT`, as in ADR 0010; the halt ends                                                 |
| RUN, STOP   | set or clear breakpoints       | Accepted; take effect from the next halt point                                         |
| RUN, STOP   | watch bodies                   | Accepted; takes effect from the next task run (see Watching bodies)                    |

- Single scan while halted is rejected rather than ignored, as it is in `RUN`
  (core protocol), because a user who presses it while halted expects a step and
  should learn that it did nothing.
- **Abandoning** a halted run means the statements after the halt point do not run in
  that task run, and the run publishes no outputs. Variables keep what the run wrote
  before the halt, and function block state can be partly updated, as when an
  emergency stop interrupts a host callback today. Forces and pending writes stay.
  The next task run starts from the beginning of its first instance.

### Inputs, outputs and time while halted

- **Outputs** keep the image published by the last completed task run while halted
  over `RUN`, and stay OFF over `STOP` (ADR 0010). The halted run publishes its
  outputs only when it completes. CODESYS likewise does not update the I/O of the
  task halted at a breakpoint, so its outputs keep their values.
- **Inputs**: the host keeps accepting panel and `setInput` changes into the input
  image, but the halted run does not read the image again; the next task run reads it
  as usual. Event inputs are sampled only by passes (ADR 0016), so an edge that rises
  and falls entirely during a halt is not seen, as during `STOP`.
- **Time**: the injected clock keeps running. A function block timer uses the start
  time of its task run (ADR 0003), so the halted run's timers are unaffected, and the
  next runs see the time that passed: a `TON` whose `PT` elapsed during the halt
  reports `Q` in the next run. This matches vendor PLCs, whose system time continues
  at a breakpoint.
- **Activations**: no scheduler pass runs while halted, and each cyclic task keeps its
  due time. A task whose due time has passed when the halt ends runs once, in the next
  pass, as after a late tick (ADR 0016); one overdue activation is kept, not one per
  missed interval. After every run the due time moves forward by whole intervals as
  ADR 0016 describes, and the activations it skips are not caught up. A skipped
  activation that came due while halted is not counted as an overrun; any other
  skipped activation is. Examples for one halt from 12 ms to 5,012 ms, in a resource
  with a 10 ms task `Fast` and a 100 ms task `Slow`:
  - `Fast` halted in its run that started at 10 ms; the run finishes at 5,013 ms. It
    counts no overruns and is next due at 5,020 ms.
  - `Slow` was first due at 100 ms, during the halt. That overdue activation is kept,
    so `Slow` runs once in the pass at 5,020 ms and finishes at 5,021 ms. Its due time
    then moves from 100 ms to 5,100 ms, skipping the activations from 200 ms to
    5,000 ms; they came due while halted, so it counts no overruns.
- **Execution times**: a halted run's execution time, and the execution time of the
  scheduler pass that contains it (the snapshot's scan time shown in the toolbar),
  exclude the time it was halted, so a halt changes neither a task's last or maximum
  execution time nor the scan time.
- **Loop limit**: ADR 0010's 200,000 loop iterations still count per task run,
  including iterations before and after a halt.
- **Retentive values** are not stored during a halt; a page reload during a halt
  restores the values stored before it (ADR 0016). When the halt ends, storing
  resumes with whatever the variables then hold, including values that an abandoned
  run or a write while halted left behind.

### Breakpoints

- A breakpoint is identified by a source and a line: the POU's name (qualified when it
  is in a namespace) and a one-based line number. It can be set in a `PROGRAM`,
  function, function block or class source. Data types, interfaces and the
  configuration source have no halt points.
- A breakpoint on a line halts before every halt point that starts on that line, every
  time execution reaches it, in every instance and every task. It halts in derived
  instances that run the base code it is in. A step that ends on a line with a
  breakpoint halts once.
- A breakpoint on a line where no statement starts is **inactive**: it is kept and
  shown differently, but never halts. It becomes active again if the text changes so
  that a statement starts on its line, after RUN applies the changes.
- The halt reports its location: the POU, the statement's span, the instance path
  (`null` in a function), and the task whose run halted.

Example, with a breakpoint on the line of `Count := Count + 1;` in a function block
called from a `FOR` loop four times per pass:

```
FOR i := 1 TO 4 DO
  counters[i](Pulse := pulses[i]);
END_FOR
```

The resource halts four times per pass, once per call, each time reporting that
call's instance path (`mainInstance.counters[1]` to `mainInstance.counters[4]`).
Continuing after each halt yields the same variables and outputs as a run without the
breakpoint.

### Stepping

Steps are available only while halted. Each step resumes the halted run and halts
again at a halt point:

- **Step into** halts before the next halt point that executes anywhere. It enters
  the bodies of user functions, function blocks and methods, including methods called
  through interface variables, references and `THIS`, and `SUPER` calls. Standard
  functions and function blocks have no body to enter and run as one step.
- **Step over** halts before the next halt point that executes in the current frame or
  in a frame that called it. It does not halt in the frames the current statement
  calls, but a breakpoint in them still halts. On a compound statement it halts at
  the first statement of the branch or loop body that runs, since those statements are
  in the same frame; if none runs, at the statement after it.
- **Step out** halts before the next halt point in a frame that called the current
  one, after the current frame returns. A `PROGRAM` frame has no caller, so step out
  there runs to the end of the instance's body and continues as a step past its end
  (below).
- A statement with several calls is entered call by call: step into enters the first
  user call in evaluation order, and a step into past the end of that callee enters
  the next one. A return into the middle of a statement is not a halt point.
- A step that passes the end of a `PROGRAM` instance's body halts at the next halt
  point that executes: in the next instance of the same task run, in the next task
  run of the same pass, or in a later pass. While it waits for a later pass the
  public state is the operating state (`RUN`), and the step stays pending until it
  halts. Over `STOP`, a step that passes the end of the single scan completes it and
  is cancelled; the state stays `STOP`.
- A pending step ends when it halts. A breakpoint reached before the step's target
  halts there and cancels the step. Stop, warm restart, cold reset, load, emergency
  stop and a fault cancel a pending step. While a step is pending and the resource is
  not halted, continue and further steps are rejected with `runtime.not-halted`.
- A run-time error during a step faults as in ADR 0010.

Example: halted at `y := Scale(x) + Offset(x);` in `Main`, where both are user
functions, step into halts at the first statement of `Scale`. Steps into past the last
statement of `Scale` halt at the first statement of `Offset`, and step out from there
halts at the statement after `y := ...` in `Main`. Step out from `Scale` instead would
run `Offset` without halting and also halt at the statement after `y := ...`.

Example on a loop, halted at `FOR i := 1 TO 2 DO` with `a := a + i;` as its only body
statement and `b := a;` after `END_FOR`: step over halts at `a := a + i;` (i = 1),
then again at `a := a + i;` (i = 2), then at `b := a;`.

Stepping in CODESYS offers the same three steps. It stays within the halted task;
here a step past the end of a `PROGRAM` instance can halt in another task, because
the whole resource halts and the next statement that executes may belong to it.

### Call stack

- A halt reports its call stack, innermost frame first. Each frame has its kind
  (`PROGRAM`, function block, method, function), its POU (a method as
  `Type.Method`, with the type that declares the running code), its instance path
  (`null` for a function), and its current statement's span: the halted statement for
  the innermost frame, the statement making the call for the others. The outermost
  frame names the task.
- Each frame carries the values that snapshots omit (ADR 0014, ADR 0017), and only
  while halted:
  - A function or method frame: its inputs, outputs, `VAR`, `VAR_TEMP` (interface
    variables only, ADR 0017), the result, and each `VAR_IN_OUT`.
  - A `PROGRAM` or function block frame: its `VAR_TEMP` and each `VAR_IN_OUT`. Its
    other variables have paths and come from the snapshot.
- A `VAR_IN_OUT` always reports its current value, read through the alias, and where
  its actual lives. An actual with a variable path (ADR 0016) reports that path. An
  actual without one (a caller's `VAR_TEMP`, a function or method local, or a member
  or element of one, which the runtime contract allows) reports the index of the frame
  that holds it, counted from 0 for the innermost frame, and its name there, with
  members and indices.

  Examples: halted inside `FOR i := 1 TO 4 DO` in a `PROGRAM` that declares `i` in
  `VAR_TEMP`, the `PROGRAM` frame reports `i`; halted in a function `Scale(v := x)`, the
  function frame reports `v` and `Scale`. Halted in `F`, called by the function `G` as
  `F(x := tmp)` with `tmp` a local of `G`, the frame of `F` reports `x` as `7` held by
  `tmp` in frame 1 (`G`); called as `F(x := Line1.Level)`, it reports `x` as `7` held
  by `Line1.Level`.

- Each frame also carries the annotations of its current invocation, from the
  statements it completed so far (see Watching bodies).
- Selecting a frame in the web app opens its source, selects its instance, marks its
  current statement and shows its values inline. It changes nothing in the runtime.

### Monitor, writes and forces while halted

- Snapshots taken while halted show the variables as they are at the halt point, in
  the middle of the run. The Worker sends a snapshot with every halt.
- Writes while halted act immediately, as writes in `STOP` do (runtime contract), so
  the rest of the halted run sees them. A write to an output-mapped variable changes the
  variable but reaches the output image only when a run publishes it in `RUN`.
- Forces set or cleared while halted take effect at the next force stage of the run
  (runtime contract), as during `RUN`.
- A force keeps priority over a write while halted, as in `RUN` (runtime contract): a
  write to a forced variable is consumed and changes nothing, so the halted run keeps
  seeing the forced value.
- Example: halted before `IF Level > 80 THEN`, writing `Level := 90` makes the halted
  run take the `THEN` branch; the snapshot sent after the write shows 90. With `Level`
  forced to 50, the same write changes nothing and the run skips the branch.

### Resumable execution

- The runtime executes a form of each body that can stop between any two halt
  points, at any call depth, and later continue or be abandoned, while the Worker
  keeps handling messages. Pausing and resuming changes nothing: a run that is
  halted and resumed produces the same variables, outputs and annotations as an
  uninterrupted run with the same clock readings and inputs.
- **One engine** runs programs with and without debugging. A separate debug
  interpreter would let the two drift apart, and every conformance trace would have to
  run on both.
- The tree IR stays the contract between compiler and runtime (ADR 0002). At load the
  runtime lowers each body into an internal instruction form executed by a loop with
  an explicit frame stack, so a halt only has to keep the frame stack. The lowered
  form evaluates operands and arguments left to right, as the runtime does today,
  including expressions that contain calls.
- Alternatives measured for this ADR, with a small tree-walking interpreter running a
  2,000-iteration loop that calls a user function each iteration:
  - Generators at statement and call boundaries took 5 to 6 times as long as plain
    recursion.
  - A first, unoptimized loop with an explicit frame stack took about twice as long.
  - `Atomics.wait` needs cross-origin isolation, which GitHub Pages cannot provide.
    It also blocks the Worker, which then cannot answer writes, watches or snapshot
    requests while halted.
- **Budget**: with no breakpoint set and no step pending, the median task-run time of
  each benchmark program is at most twice its median before resumable execution,
  measured on the same machine and Node version. While debugging is active there is no
  budget, but the benchmark records the cost. #194 adds the benchmark (the sorting
  conveyor and a loop-heavy program) and records the results in the runtime
  documentation. If the lowered form cannot meet the budget, a new ADR revisits this
  section before debugging ships.
- Conformance tests control halts without the UI: they set breakpoints and steps
  through the runtime API and advance the virtual clock explicitly, so a test
  simulates a 5 s halt by advancing the clock 5,000 ms between the halt and continue.
- A future graphical language can lower to the same form, since ADR 0002 lets ST and
  Ladder share one runtime.

### Protocol

These changes to the core protocol are breaking, and the changelog lists them
(ADR 0011):

- `RuntimeState` gains `HALT`.
- UI to runtime:
  - `{ type: "watchBodies"; bodies: { pou: string; instance: string | null }[] }`
    replaces the set of watched bodies.
  - `{ type: "setBreakpoints"; breakpoints: { pou: string; line: number }[] }`
    replaces the set of breakpoints. Breakpoints that match no halt point are ignored.
  - `{ type: "continue" }`.
  - `{ type: "debugStep"; kind: "over" | "into" | "out" }`. The existing `step`
    message keeps its meaning, one single-scan pass, and the web app keeps calling it
    "single scan".
- Runtime to UI:
  - `{ type: "halted"; operatingState: "RUN" | "STOP"; task: string; frames: CallFrame[] }`,
    where a `CallFrame` holds the kind, POU, instance path, span, call-local values
    (for a `VAR_IN_OUT`, its value and its actual's path or frame index and name) and
    annotations described in Call stack.
  - Snapshot annotations become a list of annotated bodies. Each names its POU, its
    instance path (`null` for a function), the pass it comes from, the caller for a
    function, and its annotations by line, sorted by column as today.
- Command rejections gain `runtime.halted` (run, single scan or set cycle while
  halted) and `runtime.not-halted` (continue or a step while not halted), sent as
  non-fatal `rejected` events like the existing ones. The event's `command` gains
  `run`, `step`, `continue` and `debugStep`.
- A halt is not a run-time error. ADR 0010's table of run-time error reactions gets no
  rows.

### Editing and persistence

- Breakpoints and instance choices belong to the user's workspace, not to the project:
  - Browser autosave keeps them per source, so they survive a reload.
  - The PLCopen XML file does not carry them. Opening a project or restoring the
    example starts without them.
- While the user edits, a breakpoint stays on its statement as lines are inserted or
  deleted above it. It is removed with its line. Renaming a POU keeps its breakpoints.
- The runtime only knows the loaded text. While a source has unapplied changes, the UI
  sends each of its breakpoints at the line it had in the loaded text, mapped back
  through the edits; a breakpoint on a line added since the load is sent after the next
  load. While the halted source has unapplied changes, the banner still shows the
  halt, but the editor shows no highlight or inline values, as it already hides
  inline values and fault locations in changed text.
- RUN applies changes by loading, as today. The UI then sends the breakpoints again and
  shows the inactive ones. A remembered instance that no longer exists falls back to
  the default.
- Applying changes while halted is allowed. While halted with unapplied changes, Run
  stays enabled and does what it does today with changes: it loads, which abandons the
  halted run and initializes the program as ADR 0010 says, and then runs. There is no
  online change.
- Example: with a breakpoint on line 12, inserting two lines above it moves its
  marker to line 14 while `setBreakpoints` still sends line 12; after RUN applies the
  change, it sends line 14.

### Web app

- Clicking the gutter of a `PROGRAM`, function, function block or class source toggles
  a breakpoint on that line. Active breakpoints are filled markers; inactive ones are
  hollow.
- While halted, the editor opens the halted source, selects the halted instance and
  highlights the current statement. A banner names the POU, line, instance path and
  task. Continue and the three steps appear next to the existing controls; Single scan
  is disabled, Run is enabled only to apply unapplied changes, and Stop stays
  available.
- Keyboard shortcuts must reach the app in Chromium, Firefox and WebKit on Windows,
  macOS and Linux, so they avoid function keys, which browsers and operating systems
  claim (F5 reloads, F10 opens the Firefox menu bar, F11 toggles full screen, and
  macOS maps function keys to media keys). #198 chooses the bindings under that rule,
  tests them in the Playwright browsers, and shows them in the buttons' tooltips. They
  act only while the app has focus and the runtime is halted.
- The instance picker sits above the editor for `PROGRAM`, function block and class
  sources and lists the instances described above. Function sources show the caller of
  the call they display instead.
- The call stack panel appears while halted. Selecting a frame shows it as described
  in Call stack.
- The panel stays operable while halted. Its lamps show the output image, so they keep
  the last published values.
- Logic for instance lists, breakpoint mapping and step state lives in plain TS
  modules with unit tests (ADR 0007). New strings go through the en/ja catalog.

### Points to check

IEC 61131-3 does not define debugging, so nothing here rests on the standard's text
and nothing is added to [#92](https://github.com/yasukei/benchtop-plc/issues/92).
These choices differ from vendor tools on purpose:

- The whole resource halts (CODESYS halts only the task that reached the
  breakpoint).
- Breakpoints are per line, not per statement position on a line, and apply to every
  task and instance. CODESYS can limit a breakpoint to one task or instance.
- A step past the end of a `PROGRAM` instance can halt in another task (CODESYS steps
  within the halted task).
- Activations missed while halted are not counted as overruns. As after a late tick
  (ADR 0016), a task that came due runs once after the halt and the rest are skipped
  without catch-up execution.

### Deferred scope

This ADR does not introduce conditional breakpoints, hit counts, execution points or
logpoints, data breakpoints (halting on a write), breakpoints limited to a task or an
instance, run to cursor, set next statement, flow control (highlighting executed
statements), trace and trend recording, watch expressions, or online change.

## Consequences

- Every body can show inline values for an instance the user picks, and a program can
  be stopped at a statement, inspected, stepped through and continued without
  changing what it computes.
- ADR 0010 stays valid, and ADR 0009 is extended by one reported state. The halt flag
  adds a public state and a table of its own, in the same way the emergency stop did.
  The overview's statement that every reported state except `RUN` keeps outputs OFF
  (`docs/architecture.md`) becomes "every operating state except `RUN`" when #197
  implements the halt.
- Halting the whole resource keeps the non-preemptive model intact, but differs from
  CODESYS: a fast task does not keep running while a slow one is examined.
- Outputs hold their last values while halted. On a real machine this would keep
  motors running; in the simulator it lets the panel show the state the program left.
- The runtime's execution core is rewritten for resumable execution (#194). This is the
  largest piece of the milestone and puts every conformance trace at stake; the
  budget bounds its cost, and the pause-and-resume test checks that it changes no
  results.
- The core protocol changes in breaking ways (`HALT`, annotated bodies), and every
  consumer moves in the same PRs.
- Breakpoints are not shared through project files. Teachers who want to hand out a
  project with prepared breakpoints cannot do so yet.
