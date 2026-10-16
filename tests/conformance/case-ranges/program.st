PROGRAM Ranges
VAR
    Selector : INT;
    Result : INT;
END_VAR
CASE Selector OF
    -3..-1: Result := 10;
    1, 3..5: Result := 20;
ELSE
    Result := 30;
END_CASE;
END_PROGRAM
