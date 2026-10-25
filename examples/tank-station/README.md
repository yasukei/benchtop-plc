# Tank station reference project

`project.xml` is the Milestone 6 acceptance example. One configuration connects
two independent instances of `TankControl` to their own level, START, pump and
alarm addresses, with one shared STOP input. Both import the same global setpoint and constant high-level
limit through `VAR_EXTERNAL`. `StationStatistics` samples pump flags in `%MW0`,
and an event task acknowledges alarms on a rising ACK input.

Open the web app, choose **Open project**, and select `project.xml`. The panel has two
tank rows and shared STOP, ACK and alarm controls below them.
Set **SETPOINT (%)** to 50, **LEVEL 1 (%)** to 20 and **LEVEL 2 (%)** to 60.
Press **RUN**, let the first idle scan run, then press and release **START 1**
and **START 2**. Only **PUMP 1** lights: tank 2 is already above the setpoint.
Lower level 2 below 50 to start its pump; raise either level to 50 to stop that
pump. The example does not simulate liquid: change the level inputs yourself.
Changing the setpoint affects both controllers on their next activation.
Inputs start at zero, including the setpoint; set them before starting a tank.

Each controller latches its enable on a START edge and fills whenever its level
is below the setpoint. **STOP TANKS** disarms both tanks;
STOP wins over START. Release START and press it again to enable the tank.
The START edge detector ignores a held input on its first call after load or
restart, so allow an idle activation first. The toolbar STOP pauses the whole
resource and keeps physical outputs off; it is separate from the panel STOP TANKS button.

At level 90 or above, the constant `cHighLevel` trips a latched **ALARM** and
disarms that tank. Lower the level below 90, then press and release **ACK**.
The `OnAck` event increments `gAckCount` once per rising edge; both controllers
observe it on their next control activation. A held ACK cannot clear a later
alarm. An acknowledgement while the level is unsafe leaves the alarm latched;
release ACK and press again after the level becomes safe. Acknowledging does
not restart a pump: a fresh START edge is required.

| Task       | Trigger         | Priority | Instances         |
| ---------- | --------------- | -------- | ----------------- |
| Control    | Every 100 ms    | 1        | Tank1, then Tank2 |
| Statistics | Every 500 ms    | 5        | Stats             |
| OnAck      | Rising `%IX0.4` | 0        | Ack               |

Lower numbers run first when tasks are ready together. Five control activations
correspond to one statistics activation. Each controller publishes a running bit
in `%M`; statistics reads their shared word and publishes `ActivePumps` to
`%QW3`. This value updates every 500 ms, so it can lag the pump lamps. The task
table shows run counts; expand Stats in the monitor to inspect `ActivePumps`
and its `Samples` counter.

**RUN 1 (0.1 s)** and **RUN 2 (0.1 s)** show the respective non-located `RETAIN`
`RunTicks` counters, copied to output words. Each pump-on control activation adds
one tick, representing 100 ms: a display of 25 means 2.5 seconds of nominal run
time. The counters saturate at 65,535 (6,553.5 seconds) rather than wrapping.
They count program activations, not wall-clock elapsed time; missed activations
in a throttled browser do not add time. No timer is retained.

**Warm restart** returns to STOP, keeps both counters, and initializes enables,
alarms, edge history, globals and statistics. A page reload restores the counters
from browser autosave and starts in STOP with both tanks disarmed. Timer state
would also be initialized by these operations. Output displays show zero in
STOP; press RUN to publish retained counters without starting either pump.
Allow the first idle activation before pressing START again. A **Cold reset**,
opening a project or restoring the startup example initializes the counters.
Save/reopen preserves all four source texts and the panel exactly, but does not
save live counter values in XML. Reload retention uses browser storage, which
updates at most once per second during RUN and after state changes; use toolbar
STOP before reloading to preserve the latest counts.

| Address            | Meaning                                         |
| ------------------ | ----------------------------------------------- |
| `%IX0.0`           | Tank 1 START                                    |
| `%IX0.2`           | Tank 2 START                                    |
| `%IX0.1`           | Shared STOP TANKS                               |
| `%IX0.4`           | Shared ACK event input                          |
| `%IW1`, `%IW2`     | Tank 1 and 2 levels, INT, 0–100                 |
| `%IW3`             | `gSetpoint`, shared INT setpoint, 0–100         |
| `%QX0.0`, `%QX0.1` | Tank 1 pump, alarm                              |
| `%QX0.2`, `%QX0.3` | Tank 2 pump, alarm                              |
| `%QW1`, `%QW2`     | Tank 1 and 2 run-time ticks, UINT               |
| `%QW3`             | Statistics active-pump count, UINT              |
| `%MW0`             | `gPumpBits`: bit 0 for tank 1, bit 1 for tank 2 |

Word indices address two bytes each, so the level words and run-time words do
not overlap byte-zero buttons and lamps. The `.st` files alongside the XML are
its exact editor sources.

`pnpm test tests/conformance/tank-station.test.ts` traces the sources, XML and
saved/reopened XML using the virtual clock: independent control, shared setpoint,
the 5:1 task ratio, `%M` statistics, STOP priority, alarm edge semantics, warm
restart, continued counting, saturation and retained-record restore.
The XML conformance suite also validates this project against the TC6 v2.01 XSD.
`pnpm exec playwright test tank-station.spec.ts` operates both tanks, checks
pump and alarm lamps and numeric displays, checks panel spacing at desktop and
narrow widths, reloads retained counters, and checks
source and panel preservation through save/reopen.

The checked-in `fileHeader.productVersion` represents the current release. Update
it alongside package versions when releasing, as for the other examples.
