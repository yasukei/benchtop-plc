PROGRAM NegativePresets
VAR
    Input AT %IX0.0 : BOOL;
    OnNegative, OnZero : TON;
    OffNegative, OffZero : TOF;
    PulseNegative, PulseZero : TP;
END_VAR
OnNegative(IN := Input, PT := T#-1ms);
OnZero(IN := Input, PT := T#0ms);
OffNegative(IN := Input, PT := T#-1ms);
OffZero(IN := Input, PT := T#0ms);
PulseNegative(IN := Input, PT := T#-1ms);
PulseZero(IN := Input, PT := T#0ms);
END_PROGRAM
