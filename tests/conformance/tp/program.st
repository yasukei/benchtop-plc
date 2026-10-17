PROGRAM TimerTest
VAR
    Input AT %IX0.0 : BOOL;
    Timer : TP;
    Output AT %QX0.0 : BOOL;
END_VAR
Timer(IN := Input, PT := T#10ms);
Output := Timer.Q;
END_PROGRAM
