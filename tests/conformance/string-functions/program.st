PROGRAM Main
VAR
  Count : INT := -42;
  Parsed : INT;
  Message : STRING[200];
  A : STRING[60] := 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  B : STRING[60] := 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  Joined : STRING[200];
  ShortText : STRING[5];
  LengthValue, PositionValue, WideLength : INT;
  LeftText, RightText, MidText, ConcatText, InsertText, DeleteText, ReplaceText, ClampedLeft, ClampedMid : STRING;
  Duration : TIME;
END_VAR
LengthValue := LEN('benchtop');
LeftText := LEFT('ABCDE', 2);
RightText := RIGHT('ABCDE', 2);
MidText := MID('benchtop', 3, 2);
ConcatText := CONCAT('AB', 'CD', 'E');
InsertText := INSERT('ABC', 'X', 2);
DeleteText := DELETE('ABCDE', 2, 3);
ReplaceText := REPLACE('ABCDE', 'X', 2, 3);
PositionValue := FIND('benchtop', 'top');
ClampedLeft := LEFT('ABC', 5);
ClampedMid := MID('ABC', 5, 2);
WideLength := LEN("$D83D$DE00");
Message := CONCAT('Count=', INT_TO_STRING(Count), ', next=', TO_STRING(Count + 1));
Parsed := STRING_TO_INT('123');
Duration := STRING_TO_TIME(TIME_TO_STRING(T#1500ms));
Joined := CONCAT(A, B);
ShortText := CONCAT(A, B);
END_PROGRAM
