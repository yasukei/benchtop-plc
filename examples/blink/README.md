# Blink reference project

`project.xml` is a PLCopen TC6 v2.01 project with one ST program (`Main`) and a
10 ms cyclic task. Its source matches `tests/conformance/reference/program.st`.

The checked-in `fileHeader.productVersion` represents the current release. When
updating the package versions for a release, update this header to the same
version; a regression test checks it against `packages/web/package.json`. Saving
from the web app always stamps that app's package version, including when opening
an older project, while preserving unrelated header metadata.

| Address  | Name    | Behavior                                 |
| -------- | ------- | ---------------------------------------- |
| `%IX0.0` | StartPB | Momentary start; latches Running         |
| `%IX0.1` | StopPB  | Stops running; takes priority over start |
| `%IX0.2` | ResetPB | Clears Blinks and Alarm                  |
| `%QX0.0` | Running | Latched running state                    |
| `%QX0.1` | Lamp    | Blinks with 500 ms on/off timers         |
| `%QX0.2` | Alarm   | True after 10 rising lamp edges          |

The counter persists on stop; use ResetPB to clear it. StopPB is a program input;
the runtime's system emergency stop is a separate mechanism. The included panel
has START (green), STOP (red), and RESET push buttons, Running (green), Lamp
(amber), and Alarm (red) LEDs, and a separate emergency stop. Three columns keep
the controls apart on narrow screens.

The web app opens this project on startup. Press RUN, then hold START briefly to
latch Running and blink the Lamp LED. Select **Blink** under **Example**, then use **Open example** and confirm on the
page to replace the current program, panel layout, and task cycle with this
project. A host can also import it using `@benchtop-plc/project`'s `readProject`.

`pnpm test tests/conformance/traces.test.ts` loads this XML, compiles its source,
and runs the same trace as the ST reference case. See
[`tests/conformance/README.md`](../../tests/conformance/README.md) for the trace
format and scan timing.
