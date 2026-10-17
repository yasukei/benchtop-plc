PROGRAM Modulo
VAR
    Small : INT := 7;
    Large : DINT := 40000;
    Divisor : INT;
    InitialSmall : INT := 7 MOD 0;
    InitialLarge : DINT := -40000 MOD 0;
    SmallRemainder : INT := 99;
    LargeRemainder : DINT := 99;
END_VAR
SmallRemainder := Small MOD Divisor;
LargeRemainder := Large MOD Divisor;
END_PROGRAM
