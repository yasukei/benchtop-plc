# Batch mixer reference project

`project.xml` is the Milestone 5 acceptance example: a PLCopen TC6 v2.01 project
with a 10 ms cyclic task, one `Main` PROGRAM and two data type sources.
`MixerState` is an enumeration driving a CASE state machine. `Recipe` is a
structure with a `STRING[20]` name and three TIME durations. An initialized
`ARRAY[1..3] OF Recipe` holds the recipes; `ActiveRecipe : REF_TO Recipe` selects
one without copying it. Three TON instances time the steps, and CONCAT builds
the monitored status from the selected recipe's name.

Open the web app, choose **Open project**, and select this `project.xml`.
Press **RUN**, leave both recipe switches OFF for Quick, then press and release
**START**. **FILL VALVE**, **MIXER** and **DRAIN VALVE** light in sequence;
**DONE** stays on after completion. In the variable monitor, `State` shows
`Filling`, `Mixing`, `Draining` and `Done`; `Status` shows quoted text such as
`'Quick: Mixing'`. `ActiveRecipe` shows `RECIPES[1]`. Expand `RECIPES` and a recipe
row to inspect its name and step durations. The editor list contains both TYPE
texts and the PROGRAM.

| Recipe   | Selection switches                     | Fill | Mix | Drain | Total |
| -------- | -------------------------------------- | ---- | --- | ----- | ----- |
| Quick    | Both OFF                               | 1 s  | 2 s | 1 s   | 4 s   |
| Standard | STANDARD ON, GENTLE OFF                | 2 s  | 3 s | 2 s   | 7 s   |
| Gentle   | GENTLE ON (either setting of STANDARD) | 3 s  | 4 s | 3 s   | 10 s  |

The reference is latched on a START edge in Idle or Done. Changing switches
while a batch runs affects only the next batch; START during an active batch is
ignored. Release START and press it again to start another batch after Done.
A held START cannot repeat a batch. R_TRIG suppresses an edge on its first call:
let the first idle scan run before pressing START after loading or resetting.

**STOP** takes priority over START, immediately returns to Idle, turns all four
outputs OFF, resets all timers and clears the reference to NULL. This is an
abort, with no automatic draining or resume: a fresh START edge begins filling
again for the full recipe duration. Release START before pressing it again;
releasing STOP while START is held does not restart. The panel's STOP input is
separate from the toolbar's runtime STOP, which pauses program execution.

| Address  | Name           | Panel control or indicator               |
| -------- | -------------- | ---------------------------------------- |
| `%IX0.0` | Start          | START push button                        |
| `%IX0.1` | Stop           | STOP push button                         |
| `%IX0.2` | SelectStandard | STANDARD RECIPE selector                 |
| `%IX0.3` | SelectGentle   | GENTLE RECIPE selector (higher priority) |
| `%QX0.0` | FillValve      | FILL VALVE lamp                          |
| `%QX0.1` | Mixer          | MIXER lamp                               |
| `%QX0.2` | DrainValve     | DRAIN VALVE lamp                         |
| `%QX0.3` | DoneLamp       | DONE lamp                                |

Input and output bits 4–7 are unused. A timer starts on the scan entering its
step; the next timer is armed on the transition scan. The stated durations run
from the scan accepting START, with no extra transition scan between steps.
Each completed timer resets on its transition, so a new batch starts from zero.

**Save project** and **Open project** preserve the exact TYPE and PROGRAM texts,
recipe initializers and panel. Runtime state is not saved; reopening starts in
STOP with State Idle and ActiveRecipe NULL.

The exact sources live in
[`tests/conformance/batch-mixer/`](../../tests/conformance/batch-mixer/).
`pnpm test tests/conformance/traces.test.ts` checks both those sources and the
saved/reopened XML against the same virtual-clock trace: all recipe timing
boundaries, messages, selection latching and priority, STOP in every active step,
and complete restarts. `pnpm exec playwright test batch-mixer.spec.ts` opens the
XML, runs Quick, checks lamps and monitor values, and saves/reopens all texts.

The checked-in `fileHeader.productVersion` represents the current release. Update
it alongside package versions when releasing, as for the other examples.
