PROGRAM Main
VAR
    StartPB   AT %IX0.0 : BOOL;
    StopPB    AT %IX0.1 : BOOL;
    ResetPB   AT %IX0.2 : BOOL;
    Running   AT %QX0.0 : BOOL;
    Lamp      AT %QX0.1 : BOOL;
    Alarm     AT %QX0.2 : BOOL;
    tBlinkOn  : TON;
    tBlinkOff : TON;
    rtLamp    : R_TRIG;
    Blinks    : INT;
    BlinkTime : TIME := T#500ms;
END_VAR

(* Latch: START starts, STOP stops *)
Running := (StartPB OR Running) AND NOT StopPB;

(* Two timers make the lamp blink *)
tBlinkOn(IN := Running AND NOT tBlinkOff.Q, PT := BlinkTime);
tBlinkOff(IN := tBlinkOn.Q, PT := BlinkTime);
Lamp := tBlinkOn.Q;

(* Count blinks; alarm after 10 *)
rtLamp(CLK := Lamp);
IF rtLamp.Q THEN
    Blinks := Blinks + 1;
END_IF;

IF ResetPB THEN
    Blinks := 0;
END_IF;

Alarm := Blinks >= 10;

END_PROGRAM
