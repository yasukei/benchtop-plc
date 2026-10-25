NAMESPACE Devices
CLASS Diverter EXTENDS Actuator
VAR PUBLIC
    AngleDegrees : UINT;
END_VAR

METHOD PUBLIC OVERRIDE Apply
    VAR_INPUT Enable : BOOL; END_VAR
    AngleDegrees := SEL(Enable, UINT#0, UINT#90);
    Active := AngleDegrees = 90;
END_METHOD
END_CLASS
END_NAMESPACE
