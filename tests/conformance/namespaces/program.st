NAMESPACE Machine
USING Conveyor;
PROGRAM Main
VAR belt: Motor; hoist: Lift.Motor; total: INT; END_VAR
belt.Tick(); hoist.Tick(); total := belt.speed + hoist.speed;
END_PROGRAM
END_NAMESPACE
