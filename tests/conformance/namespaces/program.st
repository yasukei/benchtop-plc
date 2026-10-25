NAMESPACE Machine
USING Conveyor;
PROGRAM Main
VAR belt: Motor; hoist: Lift.Motor; total: INT; stateValue: Conveyor.Status; END_VAR
belt.Tick(); hoist.Tick(); total := belt.speed + hoist.speed;
stateValue.Motor := total;
END_PROGRAM
END_NAMESPACE
