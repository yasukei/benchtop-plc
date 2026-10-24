PROGRAM Main
VAR
    Start AT %IX0.0 : BOOL;
    Stop AT %IX0.1 : BOOL;
    SelectStandard AT %IX0.2 : BOOL;
    SelectGentle AT %IX0.3 : BOOL;
    FillValve AT %QX0.0 : BOOL;
    Mixer AT %QX0.1 : BOOL;
    DrainValve AT %QX0.2 : BOOL;
    DoneLamp AT %QX0.3 : BOOL;
    State : MixerState := Idle;
    Recipes : ARRAY[1..3] OF Recipe := [
        (Name := 'Quick', FillTime := T#1s, MixTime := T#2s, DrainTime := T#1s),
        (Name := 'Standard', FillTime := T#2s, MixTime := T#3s, DrainTime := T#2s),
        (Name := 'Gentle', FillTime := T#3s, MixTime := T#4s, DrainTime := T#3s)
    ];
    ActiveRecipe : REF_TO Recipe;
    FillTimer : TON;
    MixTimer : TON;
    DrainTimer : TON;
    StartEdge : R_TRIG;
    Status : STRING[80] := 'Idle';
END_VAR

StartEdge(CLK := Start);
(* STOP wins over START. A new START edge is required after stopping. *)
IF Stop THEN
    State := Idle;
    ActiveRecipe := NULL;
ELSIF StartEdge.Q AND ((State = Idle) OR (State = Done)) THEN
    (* Selection is latched for the whole batch; Gentle has priority. *)
    IF SelectGentle THEN
        ActiveRecipe := REF(Recipes[3]);
    ELSIF SelectStandard THEN
        ActiveRecipe := REF(Recipes[2]);
    ELSE
        ActiveRecipe := REF(Recipes[1]);
    END_IF;
    State := Filling;
END_IF;

CASE State OF
    Idle, Done:
        FillTimer(IN := FALSE);
        MixTimer(IN := FALSE);
        DrainTimer(IN := FALSE);
    Filling:
        FillTimer(IN := TRUE, PT := ActiveRecipe^.FillTime);
        IF FillTimer.Q THEN
            FillTimer(IN := FALSE);
            State := Mixing;
            (* Arm the next timer on the transition scan. *)
            MixTimer(IN := TRUE, PT := ActiveRecipe^.MixTime);
        END_IF;
    Mixing:
        MixTimer(IN := TRUE, PT := ActiveRecipe^.MixTime);
        IF MixTimer.Q THEN
            MixTimer(IN := FALSE);
            State := Draining;
            DrainTimer(IN := TRUE, PT := ActiveRecipe^.DrainTime);
        END_IF;
    Draining:
        DrainTimer(IN := TRUE, PT := ActiveRecipe^.DrainTime);
        IF DrainTimer.Q THEN
            DrainTimer(IN := FALSE);
            State := Done;
        END_IF;
END_CASE;

FillValve := State = Filling;
Mixer := State = Mixing;
DrainValve := State = Draining;
DoneLamp := State = Done;
CASE State OF
    Idle: Status := 'Idle';
    Filling: Status := CONCAT(ActiveRecipe^.Name, ': Filling');
    Mixing: Status := CONCAT(ActiveRecipe^.Name, ': Mixing');
    Draining: Status := CONCAT(ActiveRecipe^.Name, ': Draining');
    Done: Status := CONCAT(ActiveRecipe^.Name, ': Done');
END_CASE;
END_PROGRAM
