PROGRAM Main
VAR timer: TON; elapsedIsPreset: BOOL; END_VAR
timer(IN := TRUE, PT := LT#1500us);
elapsedIsPreset := timer.ET = LT#1500us;
END_PROGRAM
