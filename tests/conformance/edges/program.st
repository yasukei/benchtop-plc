PROGRAM Edges
VAR
    Input AT %IX0.0 : BOOL;
    Rising : R_TRIG;
    Falling : F_TRIG;
END_VAR
Rising(CLK := Input);
Falling(CLK := Input);
END_PROGRAM
