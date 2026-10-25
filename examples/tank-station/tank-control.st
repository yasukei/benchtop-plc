PROGRAM TankControl
VAR_INPUT
    Level : INT;
    Start : BOOL;
    Stop : BOOL;
END_VAR
VAR_OUTPUT
    Pump : BOOL;
    Alarm : BOOL;
    Running : BOOL;
    RunTime : UINT;
END_VAR
VAR_EXTERNAL
    gSetpoint : INT;
    gAckCount : UDINT;
END_VAR
VAR_EXTERNAL CONSTANT
    cHighLevel : INT;
END_VAR
VAR RETAIN
    RunTicks : UINT;
END_VAR
VAR
    Enabled : BOOL;
    StartEdge : R_TRIG;
    LastAck : UDINT;
END_VAR

StartEdge(CLK := Start);
(* Acknowledge clears a latched alarm only after the level is safe. *)
IF Level >= cHighLevel THEN
    Alarm := TRUE;
ELSIF gAckCount <> LastAck THEN
    Alarm := FALSE;
END_IF;
LastAck := gAckCount;

(* STOP and alarms win. Release START before starting again. *)
IF Stop OR Alarm THEN
    Enabled := FALSE;
ELSIF StartEdge.Q THEN
    Enabled := TRUE;
END_IF;
Pump := Enabled AND NOT Alarm AND (Level < gSetpoint);
Running := Pump;
(* Each control activation represents 100 ms; no timer state is retained.
   Saturate at 65535 ticks (6553.5 s) instead of wrapping the display. *)
IF Pump AND (RunTicks < UINT#65535) THEN
    RunTicks := RunTicks + 1;
END_IF;
RunTime := RunTicks;
END_PROGRAM
