PROGRAM Loops
VAR
    I, J, Sum, Visits, NoIterations : INT;
END_VAR
Sum := 0;
Visits := 0;
NoIterations := 0;
FOR I := 5 TO 1 BY -2 DO
    Sum := Sum + I;
    FOR J := 1 TO 3 DO
        Visits := Visits + 1;
        EXIT;
    END_FOR;
END_FOR;
FOR I := 1 TO 5 BY -1 DO
    NoIterations := NoIterations + 1;
END_FOR;
FOR I := 5 TO 1 BY -1 DO
    IF I = 3 THEN EXIT; END_IF;
    Sum := Sum + I;
END_FOR;
END_PROGRAM
