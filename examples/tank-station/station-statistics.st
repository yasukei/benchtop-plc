PROGRAM StationStatistics
VAR_OUTPUT
    ActivePumps : UINT;
END_VAR
VAR_EXTERNAL
    gPumpBits : WORD;
END_VAR
VAR
    Samples : UDINT;
END_VAR

(* The control instances publish their running flags in the shared %M word. *)
ActivePumps := BOOL_TO_UINT(gPumpBits.0) + BOOL_TO_UINT(gPumpBits.1);
Samples := Samples + 1;
END_PROGRAM
