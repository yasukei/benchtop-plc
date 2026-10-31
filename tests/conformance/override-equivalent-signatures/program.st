PROGRAM Main
VAR
  device: Derived; link: REF_TO Base;
  count: INT;
  formatted: STRING[20];
END_VAR
link := REF(device);
count := link^.Count(step := 3, text := '12');
formatted := link^.Format(step := 3, text := 'value');
END_PROGRAM
