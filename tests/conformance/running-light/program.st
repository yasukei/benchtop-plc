PROGRAM Main
VAR
    StartPB   AT %IX0.0 : BOOL;
    StopPB    AT %IX0.1 : BOOL;
    Direction AT %IX0.2 : BOOL;
    Out0 AT %QX0.0 : BOOL;
    Out1 AT %QX0.1 : BOOL;
    Out2 AT %QX0.2 : BOOL;
    Out3 AT %QX0.3 : BOOL;
    Out4 AT %QX0.4 : BOOL;
    Out5 AT %QX0.5 : BOOL;
    Out6 AT %QX0.6 : BOOL;
    Out7 AT %QX0.7 : BOOL;
    Running : BOOL;
    Pattern : BYTE := BYTE#1;
    Speed : TIME := T#200ms;
    tStep : TON;
    Steps : USINT;
    Rotations : UDINT;
END_VAR

(* STOP takes priority; stopping preserves the pattern and counters. *)
Running := (StartPB OR Running) AND NOT StopPB;
tStep(IN := Running, PT := Speed);
IF tStep.Q THEN
    IF Direction THEN
        Pattern := ROR(Pattern, 1);
    ELSE
        Pattern := ROL(Pattern, 1);
    END_IF;
    (* Eight moves complete a rotation, even if direction changes. *)
    Steps := Steps + 1;
    IF Steps = 8 THEN
        Rotations := Rotations + 1;
        Steps := 0;
    END_IF;
    (* Reset and rearm in this scan so each interval is exactly Speed. *)
    tStep(IN := FALSE, PT := Speed);
    tStep(IN := Running, PT := Speed);
END_IF;

Out0 := Running AND Pattern.0;
Out1 := Running AND Pattern.1;
Out2 := Running AND Pattern.2;
Out3 := Running AND Pattern.3;
Out4 := Running AND Pattern.4;
Out5 := Running AND Pattern.5;
Out6 := Running AND Pattern.6;
Out7 := Running AND Pattern.7;
END_PROGRAM
