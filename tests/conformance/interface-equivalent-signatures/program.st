PROGRAM Main
VAR
  device: DeviceImpl; link: IDevice;
  count: INT;
  formatted: STRING[20];
END_VAR
link := device;
count := link.Count(step := 3, text := '12');
formatted := link.Format(step := 3, text := 'value');
END_PROGRAM
