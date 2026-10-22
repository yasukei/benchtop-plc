PROGRAM Main
VAR
  value: REAL;
  defaulted: INT;
  first: INT;
  second: INT;
  output: INT;
  nested: INT;
  scans: INT;
END_VAR
value := Scale(2, 3, 4);
defaulted := Sum(B := 2);
first := Fresh();
second := Fresh();
Emit(A := scans, Q => output);
nested := Twice(defaulted);
scans := scans + 1;
END_PROGRAM
