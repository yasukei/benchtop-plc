PROGRAM Main
VAR
    Start1 AT %IX0.0 : BOOL;
    Stop1 AT %IX0.1 : BOOL;
    Overload1 AT %IX0.2 : BOOL;
    Start2 AT %IX0.3 : BOOL;
    Stop2 AT %IX0.4 : BOOL;
    Overload2 AT %IX0.5 : BOOL;
    Run1 AT %QX0.0 : BOOL;
    Starting1 AT %QX0.1 : BOOL;
    Trip1 AT %QX0.2 : BOOL;
    Run2 AT %QX0.3 : BOOL;
    Starting2 AT %QX0.4 : BOOL;
    Trip2 AT %QX0.5 : BOOL;
    M1 : MotorStarter;
    M2 : MotorStarter;
END_VAR

(* Reserve the interlock during the delay as well as while running.
   Calling M1 first gives it priority when both motors are idle. *)
M1(Start := CanStart(Start1, M2.Active), Stop := Stop1,
   Overload := Overload1, Delay := T#500ms,
   Running => Run1, Tripped => Trip1);
M2(Start := CanStart(Start2, M1.Active), Stop := Stop2,
   Overload := Overload2, Delay := T#500ms,
   Running => Run2, Tripped => Trip2);

Starting1 := M1.Active AND NOT M1.Running;
Starting2 := M2.Active AND NOT M2.Running;
END_PROGRAM
