PROGRAM TimeWrap
VAR
    Duration : TIME := T#24d;
    Factor : DINT := 2;
    Wrapped : TIME;
    Initial : TIME := T#24d * 2;
    RealFactor : LREAL := 0.5;
    Rounded : TIME;
END_VAR
Wrapped := Duration * Factor;
Rounded := T#3ms * RealFactor;
END_PROGRAM
