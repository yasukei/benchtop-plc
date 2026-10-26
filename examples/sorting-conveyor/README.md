# Sorting conveyor reference project

Open `project.xml` with **Open project** in the web app, press **RUN**, wait for an
idle scan, then press and release **START**. **BELT RUN** lights. Hold **PART A**
to simulate a part at the first bin: **DIVERT A** lights and **BIN A TOTAL**
increments once. Release the sensor to retract the diverter. **PART B** similarly
operates the second bin. Both sensors may be active together; each bin counts
independently. This is a manual sensor simulation, with no transport delay or
physical plant model.

**STOP BELT** stops the motor and retracts both diverters. STOP wins simultaneous
START; release START and press it again to resume. A sensor held across START
operates its diverter but does not count another part. **RESET TOTALS** clears
both counts and wins simultaneous sensor edges. Counts saturate at 65,535.

| Address  | Panel control | Behavior                                              |
| -------- | ------------- | ----------------------------------------------------- |
| `%IX0.0` | START         | Latch the belt on at a fresh rising edge              |
| `%IX0.1` | STOP BELT     | Clear the running latch                               |
| `%IX0.2` | PART A        | Bin A sensor, one count per rising edge while running |
| `%IX0.3` | PART B        | Bin B sensor, one count per rising edge while running |
| `%IX0.4` | RESET TOTALS  | Clear both counters                                   |
| `%QX0.0` | BELT RUN      | Motor speed is nonzero                                |
| `%QX0.1` | DIVERT A      | First diverter is at 90 degrees                       |
| `%QX0.2` | DIVERT B      | Second diverter is at 90 degrees                      |
| `%QW1`   | BIN A TOTAL   | Retained UINT count for the first bin                 |
| `%QW2`   | BIN B TOTAL   | Retained UINT count for the second bin                |

The panel places START, STOP, RESET and belt status on the top row, sensors and
diverter lamps in the middle, and the two numeric totals below.

Seven exact ST texts accompany the XML, one declaration per source:

- `iactuator.st`: `Devices.IActuator` prototypes for `Apply()` and `IsActive()`.
- `actuator.st`: abstract `Devices.Actuator`, with protected state, abstract
  `Apply()` and inherited `IsActive()`.
- `conveyor-motor.st`: `Devices.ConveyorMotor` overrides `Apply()` to set speed to
  0 or 100 percent.
- `diverter.st`: `Devices.Diverter` overrides the same method to set angle to
  0 or 90 degrees.
- `main.st`: `SortingConveyor` imports `Devices` with `USING`, binds the belt and
  two diverters to an array of `IActuator`, and drives all three with the same
  `Actuators[Index].Apply()` call in a loop. Device types never forward calls
  through their implemented interface, avoiding ADR 0017's conservative recursion
  check.
- `is-actuator-active.st`: a function takes `REF_TO Actuator`, accepting the derived
  belt instance through `REF(Belt)` and reading its state through the base method.
- `part-counter.st`: `PartCounter` is a function block with `Count()`, `Reset()`
  and `Total()` methods and a `RETAIN` member `Parts`. Its body copies
  `Total()` into the `Value` output on each call; the PROGRAM calls both blocks
  after handling sensor edges to publish the bin totals.

One implicit 10 ms cyclic task runs `mainInstance`. The monitor shows `BinATotal`
and `BinBTotal` directly. Expand `BinA` and `BinB` to inspect `Parts`, `Belt` for
`SpeedPercent`, and the gates for `AngleDegrees`. Expand `Actuators` to see the
interface targets `mainInstance.BELT`, `mainInstance.GATEA` and `mainInstance.GATEB`.

**Warm restart** preserves both counters, clears interface targets, disarms the
belt and zeros outputs. Press RUN to rebind devices and republish totals; a fresh
START edge is required to move again. A held sensor or START does not invent an
edge on the first scan after restart. Toolbar STOP followed by page reload also
preserves the latest counters in browser storage. **Cold reset** and opening a
project initialize counts. XML saves source and panel, not live values; save/reopen
preserves all seven texts unchanged.

`pnpm test tests/conformance/sorting-conveyor.test.ts` runs a virtual-clock trace
against the standalone ST, XML and saved/reopened XML. It covers both bins,
interface dispatch to motor speed and gate angles, held inputs, stop priority,
warm restart retention, saturation, reset and cold reset.
`pnpm exec playwright test sorting-conveyor.spec.ts` checks sensor operation,
lamps, numeric displays, monitor totals, warm restart, panel spacing and exact
source preservation through browser save/reopen.

The XML's `fileHeader.productVersion` represents the current release; update it
alongside package versions when releasing, as for the other examples.
