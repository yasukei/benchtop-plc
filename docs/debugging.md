# Debugging the sorting conveyor

This browser walkthrough combines instance selection, inline values, breakpoints,
stepping and the call stack using the [sorting conveyor](../examples/sorting-conveyor/).
Use the [hosted app](https://yasukei.github.io/benchtop-plc/) or run `pnpm dev`.
The instructions use the English labels; select English in **Language** if needed.

## 1. Open a fresh project

Use **Open project** to load
[`examples/sorting-conveyor/project.xml`](../examples/sorting-conveyor/project.xml).
Opening replaces the current workspace, initializes both bin totals and clears
workspace breakpoints and instance choices. Save any work you want to keep first.
Expect **Program applied**, **No diagnostics**, state **STOP** and both totals at 0.
Select **SortingConveyor** in the POU list: its **Instance** is `mainInstance`.
There is one implicit 10 ms task, `Cyclic`.

The panel simulates sensors manually. To press a momentary button reliably, focus
it and hold Space until the indicated response, then release Space. A quick tap
can fall between scans. **START** latches the belt on; **PART A** and **PART B**
count rising sensor edges while the belt runs. They are not automatic moving parts.

## 2. Choose a function block instance

1. Select **PartCounter**. **Instance** defaults to `mainInstance.BINA`.
   There are no inline values yet: opening a source starts watching its next run.
2. Click **Single scan**. Beside `Value := THIS.Total();` (line 24), the block
   body's inline value is 0; `Total := Parts;` (line 21), inside the `Total` method,
   also shows 0. The PROGRAM calls both blocks after handling sensor edges and
   maps their `Value` outputs to the panel totals. Outputs remain OFF in STOP.
3. Enter `binb` in **Filter instances** and choose `mainInstance.BINB`.
   The new instance has no recorded values until its next run. Clear the filter
   and click **Single scan** again; both lines now show 0 for Bin B.
4. Click **RUN**, wait for Scans to advance, then hold **START** until **BELT RUN**
   lights and release it. Hold **PART B** until **DIVERT B** lights, then release.
   **BIN B TOTAL** becomes 1. In `PartCounter.Count`, `Parts := Parts + 1;`
   (line 12) shows 1 for the selected Bin B. After later scans, that method's value
   is marked **from scan N**: `Count` runs only on an edge, so it keeps its last
   call. The block body and `Total` run every scan.

The picker chooses whose values you inspect; it does not limit where a breakpoint
can halt. PROGRAM sources offer their configured instances; function block and
class sources offer instances of that type and its derived types. A source with
none says **No instance to show**. A method shows its last call on the selected
instance, while a block body shows its last body invocation. Selecting a source
or instance never restarts the PLC.

## 3. Inspect class methods and a function

1. Select **Devices.Diverter**, choose `mainInstance.GATEB` and wait for values.
   `AngleDegrees := SEL(Enable, UINT#0, UINT#90);` (line 9) shows 0.
   Hold **PART B**: it becomes 90 and **DIVERT B** lights. Release: it returns to 0
   and the lamp goes out. **BIN B TOTAL** is now 2.
2. Select **Devices.Actuator**. The picker offers `mainInstance.BELT`
   (`Devices.ConveyorMotor`), `mainInstance.GATEA` and `mainInstance.GATEB`
   (both `Devices.Diverter`). Choose BELT: the inherited `IsActive := Active;`
   (line 12) shows TRUE. Choose GATEB: it shows FALSE after the next scan.
   A base method only has values when that implementation actually runs;
   an override does not populate the base implementation's values.
3. Select **IsActuatorActive** and wait for its next call. Functions have no
   instance picker. The label reads **Called from SortingConveyor (mainInstance),
   line 43**, and `IsActuatorActive := Device^.IsActive();` (line 7) shows TRUE.
   A function displays its last watched call and immediate caller, not a separate
   history for each caller. Before its first watched call it says
   **No call recorded yet**.

## 4. Halt only when a part arrives

1. Return to **PartCounter**, leaving **Instance** on `mainInstance.BINB`.
   Click the breakpoint gutter beside `Parts : UINT;` (line 3). Its hollow circle
   is **inactive**: a declaration is not an executable statement. Scans continue.
   Click it again to remove it.
2. Click the gutter beside `Parts := Parts + 1;` (line 12). The filled circle is
   active. The belt keeps running without halting while no new part arrives.
3. Focus **PART A** and hold Space until the runtime reports **HALT**, then
   release Space. The banner reads **PartCounter.Count, line 12
   (mainInstance.BINA), task Cyclic**. The editor opens that source, switches to
   BINA and highlights the assignment _before_ it runs. Although BINB was selected,
   the breakpoint applies to every instance of this source.

Do not put a breakpoint in `Devices.Diverter.Apply` or
`Devices.ConveyorMotor.Apply` for this event walkthrough: the PROGRAM calls
`Apply` for every actuator on every scan, including while idle. Such a breakpoint
will halt repeatedly unless you clear it before continuing.

While halted, observe:

- **BIN A TOTAL** stays 0, **BELT RUN** stays lit and **DIVERT A** stays OFF.
  The halted scan has changed internal device state but has not published its
  outputs. Over RUN, all panel lamps and numeric displays keep the last completed
  output image. Over STOP (a halted Single scan), outputs stay OFF instead.
- The whole resource pauses, including other tasks. **Scans** does not advance
  while you wait. RUN and Single scan are disabled while halted with no edits;
  Continue and the three steps are available. Toolbar STOP abandons the rest of
  the scan and turns outputs OFF; it does not finish the interrupted scan.
- The panel stays usable. Releasing PART A changes `%IX0.2` in the **I/O image**
  to OFF, but `SensorA` in the variable monitor is still TRUE: this task run uses
  the inputs it sampled at its start. The next task run reads the new input image.
  A press and release entirely inside a halt is not sampled as a sensor edge.
- Time keeps passing even though execution pauses. Timers use the task run's
  start time, so the interrupted run's timers do not advance while stepping;
  subsequent runs see the elapsed time. Overdue cyclic tasks run once when
  execution resumes, without replaying every missed activation. This conveyor
  has no timer, so its frozen Scans and outputs do not demonstrate timer expiry.

## 5. Inspect the stack and step through publication

The **Call stack** lists the executing invocation first, then its callers.
At the Count breakpoint it has two entries: `PartCounter.Count` at line 12
(`mainInstance.BINA`) and `SortingConveyor` at line 54 (`mainInstance`).
Persistent `BINA.PARTS` is 0 in the variable monitor.

1. Select the SortingConveyor frame. The editor highlights `BinA.Count();`
   inside the `IF` on line 54 and selects `mainInstance`.
   Select the Count frame again. Frame selection only changes inspection; the
   banner still names the actual halt and execution has not advanced.
2. Focus **Step over** and press **N**. The assignment runs; `BINA.PARTS` becomes 1.
   Count returns and the next statement is the `IF` for Bin B at line 55 in
   SortingConveyor. **BIN A TOTAL** on the panel is still 0.
3. Press **N** again. The false Bin B condition is skipped, reaching
   `BinA(Value => BinATotal);` at line 57. Step over executes a statement and its
   calls without entering them; a breakpoint inside can still interrupt it.
4. Press **I** (**Step into**). Execution enters PartCounter's body for BINA,
   stopping at `Value := THIS.Total();` (line 24). The stack now has block and
   PROGRAM frames. Press **I** again to enter `PartCounter.Total` at line 21.
   Three frames are visible: Total, the block body and SortingConveyor.
   **Frame values** shows the method's return variable `Total`, initially 0.
   Call-local inputs, temporaries, results and in-out locations appear here;
   persistent instance members remain in the variable monitor.
5. Select the outer SortingConveyor frame. Press **O** (**Step out**).
   Selection was inspection only: this finishes the executing Total method and
   the enclosing assignment/block call, reaching `BinB(Value => BinBTotal);`
   at line 58. The stack has only the PROGRAM frame again. `BinATotal` in the
   monitor is now 1, but the panel still shows 0 until the run completes.
6. Focus **Continue** and press **C**. The selected stack entry disappeared
   when stepping out, so refocus a runtime control before the next shortcut.
   The scan finishes, **BIN A TOTAL** becomes 1,
   the state returns to RUN and the stack and statement highlight disappear.
   DIVERT A may briefly light from the interrupted run's sampled TRUE input;
   the next run sees the released PART A and turns it OFF. Scans advance again
   without another halt. Select PartCounter and remove the line 12 breakpoint.
   Toolbar **STOP** ends the session.

Step into enters user functions, block bodies and methods in evaluation order.
Standard functions and standard blocks execute as one step. Step out finishes the
innermost invocation and stops at the next statement in a caller; if no statement
remains in this scheduler pass, the pass completes. Stepping after the last
PROGRAM statement can reach another instance or task in the same pass.

## Keyboard shortcuts and workspace notes

| Action    | Key |
| --------- | --- |
| Continue  | C   |
| Step over | N   |
| Step into | I   |
| Step out  | O   |

Use plain letters with no Shift, Ctrl, Alt or Command. They act only while halted,
with focus in the app outside the source editor, text inputs and selects. Focus a
runtime control or a call stack button. Runtime controls retain focus across
steps; refocus a control when a selected stack entry disappears.
Button tooltips show the keys. Function keys are avoided because browsers and
operating systems reserve them. Held-key repeats and IME composition are ignored.

Browser autosave keeps breakpoints and instance choices. Project XML does not;
opening a project clears them. Markers follow edits and POU renames. Edits are
unapplied until RUN loads them; editing the halted source hides its inline values
and statement highlight while the banner remains. RUN with unapplied changes
abandons the halted scan, loads the program and starts it again. Save a project
for source exchange, not to share a halted session.

The automated acceptance walkthrough is
[`packages/web/e2e/debugging-guide.spec.ts`](../packages/web/e2e/debugging-guide.spec.ts).
Run `pnpm exec playwright test debugging-guide.spec.ts`. The existing
[conveyor conformance trace](../tests/conformance/sorting-conveyor.test.ts) and
[conveyor browser test](../packages/web/e2e/sorting-conveyor.spec.ts) independently
check its behavior and project round-trip. See [web-app.md](web-app.md#breakpoints)
for workbench details and [ADR 0018](adr/0018-debugging.md) for debugger semantics.
