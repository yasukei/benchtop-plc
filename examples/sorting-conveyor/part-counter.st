FUNCTION_BLOCK PartCounter
VAR RETAIN
    Parts : UINT;
END_VAR

METHOD PUBLIC Count
    (* Saturate so a full bin never wraps back to zero. *)
    IF Parts < UINT#65535 THEN
        Parts := Parts + 1;
    END_IF;
END_METHOD

METHOD PUBLIC Reset
    Parts := 0;
END_METHOD

METHOD PUBLIC Total : UINT
    Total := Parts;
END_METHOD
END_FUNCTION_BLOCK
