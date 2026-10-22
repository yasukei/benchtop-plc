PROGRAM Main
VAR counter: CTU; preset: DINT := 40000; i: DINT; END_VAR
FOR i := 1 TO 20000 DO
  counter(CU := FALSE, PV := preset);
  counter(CU := TRUE);
END_FOR;
END_PROGRAM
