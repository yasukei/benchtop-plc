PROGRAM Acknowledge
VAR_EXTERNAL
    gAckCount : UDINT;
END_VAR

(* The event task runs once per rising edge, even if ACK stays pressed. *)
gAckCount := gAckCount + 1;
END_PROGRAM
