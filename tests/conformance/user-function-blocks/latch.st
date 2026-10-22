FUNCTION_BLOCK Latch
VAR_INPUT setValue : BOOL; END_VAR
VAR_OUTPUT running : BOOL; calls : INT; END_VAR
VAR delay : TON; END_VAR
VAR_TEMP temp : INT := 2; END_VAR
temp := temp + 1;
calls := calls + 1;
running := running OR setValue;
delay(IN := running, PT := T#30ms);
END_FUNCTION_BLOCK
