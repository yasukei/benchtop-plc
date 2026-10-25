CONFIGURATION TankStation
VAR_GLOBAL
    gSetpoint AT %IW3 : INT;
    gPumpBits AT %MW0 : WORD;
    gAckCount : UDINT;
END_VAR
VAR_GLOBAL CONSTANT
    cHighLevel : INT := 90;
END_VAR
RESOURCE Station ON BENCHTOP
    TASK Control (INTERVAL := T#100ms, PRIORITY := 1);
    TASK Statistics (INTERVAL := T#500ms, PRIORITY := 5);
    TASK OnAck (SINGLE := %IX0.4, PRIORITY := 0);
    PROGRAM Tank1 WITH Control : TankControl (
        Level := %IW1, Start := %IX0.0, Stop := %IX0.1,
        Pump => %QX0.0, Alarm => %QX0.1, Running => %MX0.0, RunTime => %QW1);
    PROGRAM Tank2 WITH Control : TankControl (
        Level := %IW2, Start := %IX0.2, Stop := %IX0.1,
        Pump => %QX0.2, Alarm => %QX0.3, Running => %MX0.1, RunTime => %QW2);
    PROGRAM Stats WITH Statistics : StationStatistics (ActivePumps => %QW3);
    PROGRAM Ack WITH OnAck : Acknowledge;
END_RESOURCE
END_CONFIGURATION
