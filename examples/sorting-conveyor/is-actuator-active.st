USING Devices;
FUNCTION IsActuatorActive : BOOL
VAR_INPUT
    Device : REF_TO Actuator;
END_VAR
(* A derived instance can be inspected through a reference to its base class. *)
IsActuatorActive := Device^.IsActive();
END_FUNCTION
