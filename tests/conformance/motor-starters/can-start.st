FUNCTION CanStart : BOOL
VAR_INPUT
    Requested : BOOL;
    OtherActive : BOOL;
END_VAR

CanStart := Requested AND NOT OtherActive;
END_FUNCTION
