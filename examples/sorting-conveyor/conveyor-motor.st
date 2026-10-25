NAMESPACE Devices
CLASS ConveyorMotor EXTENDS Actuator
VAR PUBLIC
    SpeedPercent : UINT;
END_VAR

METHOD PUBLIC OVERRIDE Apply
    VAR_INPUT Enable : BOOL; END_VAR
    SpeedPercent := SEL(Enable, UINT#0, UINT#100);
    Active := SpeedPercent > 0;
END_METHOD
END_CLASS
END_NAMESPACE
