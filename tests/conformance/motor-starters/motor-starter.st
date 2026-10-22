FUNCTION_BLOCK MotorStarter
VAR_INPUT
    Start : BOOL;
    Stop : BOOL;
    Overload : BOOL;
    Delay : TIME := T#500ms;
END_VAR
VAR_OUTPUT
    Active : BOOL;
    Running : BOOL;
    Tripped : BOOL;
END_VAR
VAR
    StartTimer : TON;
END_VAR

(* STOP and overload take priority over START and clear the latch. *)
Active := (Start OR Active) AND NOT Stop AND NOT Overload;
StartTimer(IN := Active, PT := Delay);
Running := StartTimer.Q;
Tripped := Overload;
END_FUNCTION_BLOCK
