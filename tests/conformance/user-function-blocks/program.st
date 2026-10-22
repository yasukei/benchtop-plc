PROGRAM Main
VAR m1,m2 : Latch; steps : INT; done : BOOL; END_VAR
VAR_TEMP scratch : INT := 5; END_VAR
steps := steps + 1;
scratch := scratch + 1;
IF steps = 1 THEN m1(setValue := TRUE); END_IF;
m1(); m2();
END_PROGRAM
