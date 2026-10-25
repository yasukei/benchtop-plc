USING Devices;
PROGRAM SortingConveyor
VAR
    Start AT %IX0.0 : BOOL;
    Stop AT %IX0.1 : BOOL;
    SensorA AT %IX0.2 : BOOL;
    SensorB AT %IX0.3 : BOOL;
    ResetTotals AT %IX0.4 : BOOL;
    MotorOn AT %QX0.0 : BOOL;
    DivertA AT %QX0.1 : BOOL;
    DivertB AT %QX0.2 : BOOL;
    BinATotal AT %QW1 : UINT;
    BinBTotal AT %QW2 : UINT;
    Belt : ConveyorMotor;
    GateA, GateB : Diverter;
    Actuators : ARRAY[1..3] OF IActuator;
    Commands : ARRAY[1..3] OF BOOL;
    BinA, BinB : PartCounter;
    StartEdge, PartAEdge, PartBEdge : R_TRIG;
    Running : BOOL;
    Index : INT;
END_VAR

StartEdge(CLK := Start);
(* STOP wins simultaneous START and requires a fresh START edge to resume. *)
IF Stop THEN
    Running := FALSE;
ELSIF StartEdge.Q THEN
    Running := TRUE;
END_IF;

(* Rebind after every restart: interfaces are never retained. *)
Actuators[1] := Belt;
Actuators[2] := GateA;
Actuators[3] := GateB;
Commands[1] := Running;
Commands[2] := Running AND SensorA;
Commands[3] := Running AND SensorB;
FOR Index := 1 TO 3 DO
    (* The same call sets motor speed or diverter angle by dynamic binding. *)
    Actuators[Index].Apply(Enable := Commands[Index]);
END_FOR;
MotorOn := IsActuatorActive(REF(Belt));
DivertA := Actuators[2].IsActive();
DivertB := Actuators[3].IsActive();

(* Observe raw sensor edges so a held sensor is not recounted on START. *)
PartAEdge(CLK := SensorA);
PartBEdge(CLK := SensorB);
IF ResetTotals THEN
    BinA.Reset();
    BinB.Reset();
ELSE
    IF Running AND PartAEdge.Q THEN BinA.Count(); END_IF;
    IF Running AND PartBEdge.Q THEN BinB.Count(); END_IF;
END_IF;
BinATotal := BinA.Total();
BinBTotal := BinB.Total();
END_PROGRAM
