# Running light reference project

`project.xml` is a PLCopen TC6 v2.01 project with one ST program (`Main`) and a
10 ms cyclic task. Its source matches
[`tests/conformance/running-light/program.st`](../../tests/conformance/running-light/program.st).
It exercises `BYTE`, `USINT`, `UDINT`, `TIME`, `TON`, `ROL`/`ROR` and bit access.

Open the web app, select **Running light** under **Example**, then click **Open example** twice to confirm. Press
**RUN**, then hold **START** briefly. One LED lights immediately, then moves once
every `Speed` (initially `T#200ms`). The panel has START and STOP push buttons, a
DIRECTION selector and eight LEDs in a row, numbered 0–7 from left to right.
A wide browser window makes the LED row easier to read.

| Address           | Name      | Behavior                                                         |
| ----------------- | --------- | ---------------------------------------------------------------- |
| `%IX0.0`          | StartPB   | Momentary start; latches Running                                 |
| `%IX0.1`          | StopPB    | Stops and turns all LEDs off; takes priority over START          |
| `%IX0.2`          | Direction | OFF: ROL, LED 0 → 1 → … → 7 → 0; ON: ROR, LED 0 → 7 → … → 1 → 0  |
| `%QX0.0`–`%QX0.7` | Out0–Out7 | Each output reads the corresponding bit of Pattern while running |

The variable monitor shows `Pattern` as a hexadecimal `BYTE`, `Speed` as a `TIME`,
and the `UDINT` counter `Rotations`. Each eight moves increments `Rotations`,
including moves made after changing direction. STOP preserves `Pattern`, the
partial move count (`Steps`) and `Rotations`; START resumes at that LED with a
fresh timer interval. The toolbar's cold reset restores the initial values.
STOP here is a program input, separate from the runtime's emergency stop.

The timer resets and rearms in the same scan after each move, avoiding an extra
scan between intervals. Durations that are not multiples of the task interval
round up to the next scan. You can write a positive `Speed` in the variable
monitor to change the interval.

The checked-in `fileHeader.productVersion` represents the current release. Update
it alongside package versions when releasing, as for the blink example.

`pnpm test tests/conformance/traces.test.ts` loads the XML, compiles its source,
and checks all eight output bits over virtual time in both directions, including
wraparound, rotation counts, STOP priority, restart and a changed speed. See
[`tests/conformance/README.md`](../../tests/conformance/README.md) for scan timing.
