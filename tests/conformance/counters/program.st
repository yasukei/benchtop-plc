PROGRAM Counters
VAR
    Edge AT %IX0.0 : BOOL;
    Reset AT %IX0.1 : BOOL;
    Load AT %IX0.2 : BOOL;
    Up : CTU;
    Down : CTD;
END_VAR
Up(CU := Edge, R := Reset, PV := 2);
Down(CD := Edge, LD := Load, PV := 2);
END_PROGRAM
