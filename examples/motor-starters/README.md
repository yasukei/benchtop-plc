# Motor starters reference project

`project.xml` is a PLCopen TC6 v2.01 project with three Structured Text POUs:
`Main` (`PROGRAM`), `MotorStarter` (`FUNCTION_BLOCK`) and `CanStart` (`FUNCTION`).
The exact sources are checked against
[`tests/conformance/motor-starters/`](../../tests/conformance/motor-starters/).
One 10 ms cyclic task calls two independent instances, `M1` and `M2`, of the same
block. Each instance owns its start/stop latch and nested `TON` timer.

Open the web app, choose **Open project**, and select this `project.xml`. The POU
list shows all three texts. Press **RUN**, then hold **M1 START** briefly: the amber
**M1 STARTING** lamp lights immediately, followed by the green **M1 RUN** lamp
after 500 ms. Releasing START preserves the latch. Press **M1 STOP** to clear it,
then use **M2 START** to run the other motor after its own 500 ms delay.

Each motor has START and STOP push buttons, an OVERLOAD switch, and STARTING, RUN
and TRIP lamps. Motor 1 occupies the left two panel columns; motor 2 the right
two. START/STOP are at the top, OVERLOAD/TRIP in the middle and STARTING/RUN at
the bottom.

| Address  | Name      | Behavior                                 |
| -------- | --------- | ---------------------------------------- |
| `%IX0.0` | Start1    | Request motor 1 start                    |
| `%IX0.1` | Stop1     | Stop motor 1, including during its delay |
| `%IX0.2` | Overload1 | Trip motor 1 while ON                    |
| `%IX0.3` | Start2    | Request motor 2 start                    |
| `%IX0.4` | Stop2     | Stop motor 2, including during its delay |
| `%IX0.5` | Overload2 | Trip motor 2 while ON                    |
| `%QX0.0` | Run1      | Motor 1 delay complete                   |
| `%QX0.1` | Starting1 | Motor 1 latched, waiting for its delay   |
| `%QX0.2` | Trip1     | Motor 1 overload input is ON             |
| `%QX0.3` | Run2      | Motor 2 delay complete                   |
| `%QX0.4` | Starting2 | Motor 2 latched, waiting for its delay   |
| `%QX0.5` | Trip2     | Motor 2 overload input is ON             |

Input and output bits 6 and 7 are unused. STOP and overload take priority over
START and reset the timer immediately. Switch an overload OFF and press START
again to restart; clearing it alone does not restart a motor when START is
released. TRIP follows the overload switch rather than latching a separate fault.

`Main` calls `CanStart` for each motor to allow its START only when the other
instance's `Active` latch is clear. The latch reserves the interlock throughout
the start delay and while running, so the two motors cannot run together.
`M1` is called first: simultaneous STARTs while idle give motor 1 priority. A
blocked START is not queued after release; a held START remains a request and can
be accepted when the other motor stops. Because of call order, a held motor 2
request can be accepted in the scan that stops motor 1; the reverse handoff takes
one more scan. A motor can stop or trip independently of its start permission.

The variable monitor exposes members such as `M1.ACTIVE`, `M2.RUNNING` and each
instance's `STARTTIMER` ports. **Save project** and **Open project** preserve all
three POU texts and the panel. Runtime state is not saved; reopening starts in STOP.

`pnpm test tests/conformance/traces.test.ts` runs this XML through the same
virtual-time trace as the ST fixtures, including delay boundaries, both interlock
directions, simultaneous starts, stop/overload priority and timer resets.
`pnpm exec playwright test motor-starters.spec.ts` checks both motors' lamps, the
POU list, overload operation and exact text preservation through browser save/reopen.

The checked-in `fileHeader.productVersion` represents the current release. Update
it alongside package versions when releasing, as for the other examples.
