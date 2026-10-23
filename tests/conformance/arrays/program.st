PROGRAM Main
VAR
  V : ARRAY[1..5] OF INT := [1, 2, 3(0)];
  Copy : ARRAY[1..5] OF INT;
  M : ARRAY[0..1, 0..2] OF REAL;
  N : ARRAY[1..2] OF ARRAY[1..3] OF INT;
  i, Sum : INT;
END_VAR
Sum := 0;
FOR i := 1 TO 5 DO
  Sum := Sum + V[i];
END_FOR;
M[1,2] := 2.5;
N[2][3] := Sum;
Copy := V;
Copy[1] := 99;
END_PROGRAM
