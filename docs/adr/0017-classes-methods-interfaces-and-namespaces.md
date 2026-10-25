# 0017. Classes, methods, interfaces and namespaces

- Status: Accepted
- Date: 2026-10-25
- Related: [0006](0006-plcopen-xml-project-format.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md),
  [0011](0011-versioning-changelog-and-releases.md),
  [0014](0014-user-defined-pous.md),
  [0015](0015-derived-types-strings-and-references.md),
  [0016](0016-configurations-tasks-and-global-variables.md)
- Source: [issue #174](https://github.com/yasukei/benchtop-plc/issues/174)

## Context

Milestone 7 adds the object-oriented features of IEC 61131-3: methods, classes,
inheritance, interfaces and namespaces. Today a project is a list of sources with one
data type, POU or configuration each (ADR 0014, ADR 0015, ADR 0016). A
`FUNCTION_BLOCK` has one body; its instances keep `VAR_INPUT`, `VAR_OUTPUT` and `VAR`
between calls, and calls are formal only. Every call target is known at compile time,
so recursion is a compile error. Function block instances cannot be reference targets
(ADR 0015). POU, type, configuration, task, instance and global names share one
case-insensitive namespace with the standard names. PLCopen XML TC6 v2.01 has no
element for methods, classes, interfaces or namespaces.

The new features change the compiler, the IR, the runtime, the monitor and the project
file together. The implementation issues under
[#173](https://github.com/yasukei/benchtop-plc/issues/173) need one model.

The 4th edition text (IEC 61131-3:2025) is not available and no access is expected.
These features were introduced by the 3rd edition (2013), so decisions that depend on
the standard follow the 3rd edition text and secondary sources (vendor documentation
for CODESYS and TwinCAT); they are not verified claims about 4th edition clauses. The
checks and project restrictions below are tracked in
[#92](https://github.com/yasukei/benchtop-plc/issues/92).

## Decision

### Methods

- A `FUNCTION_BLOCK` declares methods after its variable sections and before its body:

  ```
  FUNCTION_BLOCK Counter
    VAR_INPUT Step : INT := 1; END_VAR
    VAR n : INT; END_VAR
    METHOD PUBLIC Increment
      n := n + Step;
    END_METHOD
    METHOD PUBLIC Value : INT
      Value := n;
    END_METHOD
    METHOD PUBLIC Reset
      n := 0;
    END_METHOD
    Increment();
  END_FUNCTION_BLOCK
  ```

  The statements after the last `END_METHOD` are the body, as before; a block may
  have methods and an empty body.

- A method with a result type returns the value last assigned to the method name, or
  the type's default, as a function does (ADR 0014). A method without a result type is
  called only as a statement.
- A method allows `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and `VAR` (with `CONSTANT`).
  Its variables and result start from their initial values at every call, as a
  function's do. `VAR_TEMP`, `VAR_EXTERNAL`, `RETAIN`/`NON_RETAIN` and function block
  or class instances in a method are compile errors (restriction, as for functions in
  ADR 0014).
- A method body reads and writes the instance's `VAR_INPUT`, `VAR_OUTPUT`, `VAR`,
  `VAR_IN_OUT` (when the body has bound it) and `VAR_EXTERNAL` by their names, and
  calls the instance's other methods. A method's own variables cannot have the name of
  a member or method of its type, including inherited ones (restriction; no
  shadowing), so `n` in a method always means one thing.
- Calls:
  - From outside: `c.Increment();`, `x := c.Value();`, `valves[i].Open();`.
  - Inside the type: `Increment();` or `THIS.Increment();`, and `THIS.n` for a member.
  - Arguments follow user functions (ADR 0014): formal (`M(A := x, Q => y)`) or
    non-formal (`M(x)`), never mixed; in a formal call an omitted input takes its
    declared initial value; a non-formal call needs one argument per input and only
    `VAR_INPUT` parameters. Operands and arguments are evaluated left to right.
- A method cannot call its instance's body: `THIS(...)` is a compile error
  (restriction). The body is called only as today, `c(Step := 2);`.
- `RETURN` leaves the method.

### Access specifiers

- `PUBLIC`, `PROTECTED`, `PRIVATE` and `INTERNAL` follow `METHOD` and `VAR` of a class
  or function block: `METHOD PRIVATE Check : BOOL`, `VAR PUBLIC Speed : REAL; END_VAR`.
  Without one, a method or `VAR` member is `PROTECTED`, as in the 3rd edition.
- `PUBLIC`: accessible everywhere. `PROTECTED`: in the declaring type and the types
  derived from it. `PRIVATE`: in the declaring type only. `INTERNAL`: in the namespace
  that contains the declaring type (see Namespaces); in the global namespace that is
  the whole project.
- Access is checked by type, not by instance: a method of `Counter` may read `other.n`
  of another `Counter`.
- `VAR_INPUT` and `VAR_OUTPUT` of a function block stay as ADR 0014 says: readable from
  outside, inputs also assignable. They take no access specifier (restriction).
  `VAR_IN_OUT` and `VAR_TEMP` stay inaccessible from outside.
- An access specifier on any other section, or two on one section or method, is a
  compile error.
- The monitor ignores access specifiers (see Monitoring and protocol).

### Classes

- A class groups variables and methods and has no body:

  ```
  CLASS Valve
    VAR PUBLIC Position : REAL; END_VAR
    VAR isOpen : BOOL; END_VAR
    METHOD PUBLIC Open
      isOpen := TRUE; Position := 100.0;
    END_METHOD
    METHOD PUBLIC IsOpen : BOOL
      IsOpen := isOpen;
    END_METHOD
  END_CLASS
  ```

- A class allows `VAR` (with `CONSTANT`, `RETAIN`, `NON_RETAIN` and access specifiers)
  and `VAR_EXTERNAL`. `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR_TEMP` and `AT` in a
  class are compile errors, as in the 3rd edition.
- A class instance cannot be called: `v();` is a compile error. It is used only through
  its methods and its accessible variables.
- Class instances can be declared wherever function block instances can: `VAR` of a
  `PROGRAM`, `FUNCTION_BLOCK` or class, `VAR_GLOBAL`, and arrays of instances
  (ADR 0015). Like function block instances, they cannot be structure members, in
  `VAR_TEMP`, in a `FUNCTION` or a method, or `CONSTANT`, and they take no initializer
  (restriction).
- A class may contain instances of function blocks and other classes, with ADR 0014's
  rule against containing itself directly or indirectly.
- Class names join the ADR 0014 namespace, with `decl.name-collision` kind `"type"` for
  a variable named like a class.

### Inheritance

- `FUNCTION_BLOCK Servo EXTENDS Motor` and `CLASS Servo EXTENDS Motor`: single
  inheritance from a type of the same kind (restriction: a function block cannot
  extend a class, nor a class a function block). An unknown base, a base of the other
  kind and a cycle (`A EXTENDS B` with `B EXTENDS A`) are compile errors. There is no
  depth limit beyond the absence of cycles.
- A derived type inherits every variable section and method of its base. Declaring a
  variable or method with the name of an inherited member is a compile error unless it
  is a method with `OVERRIDE`. Base members keep their declared initializers.
- `METHOD PUBLIC OVERRIDE Check : BOOL` replaces an inherited method. It must have the
  same name, the same access specifier, the same parameters (names, sections, types
  and order) and the same result type. `OVERRIDE` without an inherited method of that
  name, and an inherited method redeclared without `OVERRIDE`, are compile errors.
- Methods are bound at run time (see Dynamic binding and recursion): in a base method,
  `Check()` and `THIS.Check()` run the override of the instance's actual type.
- `SUPER.Check()` calls the base type's implementation from a method or body of the
  derived type. `SUPER` without a base, and `SUPER.M()` naming an abstract or missing
  base method, are compile errors.
- A derived function block's body replaces its base's body. The base body runs only
  when the derived body calls `SUPER();`, which takes no arguments and runs the base
  body with the instance's current inputs. A derived function block with an empty
  body does nothing when called.
- `ABSTRACT` and `FINAL` follow `CLASS` or `FUNCTION_BLOCK`
  (`CLASS ABSTRACT Actuator`) and, on methods, the access specifier
  (`METHOD PUBLIC ABSTRACT Run`). Rules:
  - An abstract method has no statements between its declarations and `END_METHOD`;
    only an abstract type can declare one.
  - A type that is not abstract must implement every abstract method it inherits and
    every interface method (see Interfaces).
  - An instance of an abstract type is a compile error; references and interface
    variables may refer to instances of derived types.
  - A `FINAL` type cannot be extended, and a `FINAL` method cannot be overridden.
  - `ABSTRACT` together with `FINAL`, and `ABSTRACT` on a function block that has a
    body, are compile errors (restriction).

### Interfaces

- An interface declares method prototypes only:

  ```
  INTERFACE IActuator
    METHOD Start
    END_METHOD
    METHOD Stop
    END_METHOD
    METHOD IsRunning : BOOL
    END_METHOD
  END_INTERFACE
  ```

  A prototype has a name, an optional result type and `VAR_INPUT`, `VAR_OUTPUT` and
  `VAR_IN_OUT` sections, and no statements. Interface methods take no access
  specifier; they are public.

- `INTERFACE IServo EXTENDS IActuator, IPositioner` combines interfaces. Two inherited
  prototypes with the same name must have identical signatures; otherwise, and for an
  unknown interface or a cycle, the compiler reports an error.
- `FUNCTION_BLOCK Pump IMPLEMENTS IActuator` and
  `CLASS Valve EXTENDS Base IMPLEMENTS IActuator, IPositioner`. A type implements an
  interface when it declares or inherits a `PUBLIC` method with each prototype's name
  and identical signature. A missing method makes the type abstract, which it must say
  (`ABSTRACT`); otherwise it is a compile error. A derived type implements its base's
  interfaces.
- An interface variable refers to an instance, or holds `NULL`:
  - Declared as `a : IActuator;` in `VAR`, `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and
    `VAR_TEMP` of any POU or method, in `VAR_GLOBAL`, as an array element, as a
    structure member and as a function or method result. `NULL` is its default and
    only initializer; it cannot be `CONSTANT` or located.
  - Assignment accepts `NULL`, an interface variable of the same interface or of one
    that extends it, `THIS` inside an implementing type, and an instance whose type
    implements the interface: `a := pump1;`. The instance must be one that `REF()`
    accepts under ADR 0015 and the references section below, so an interface variable
    never outlives its instance.
  - `a.Start();` and `x := a.IsRunning();` call the method of the instance it refers
    to. A call through `NULL` faults with `runtime.null-reference`.
  - `=` and `<>` compare two interface variables, or one with `NULL`; they are equal
    when they refer to the same instance.
  - Interface variables cannot be dereferenced (`a^` is a compile error) and are not
    instances: `a();` and reading or writing a variable through `a` are compile
    errors.
- Interface names join the ADR 0014 namespace.

### Assignment attempt

- `target ?= source;` is a statement. The target is an interface variable or a
  reference to a function block or class type; the source is an interface variable, a
  reference to a function block or class type, or `NULL`.
- If the source refers to an instance whose actual type implements the target
  interface, or is the target reference's type or derived from it, the target refers
  to that instance. Otherwise, including a `NULL` source, the target becomes `NULL`.
  It never faults. This follows the 3rd edition.
- `?=` with a target or source of any other type, or used inside an expression, is a
  compile error.

### References to instances

- This extends ADR 0015: `REF_TO T` is allowed when `T` is a user function block or a
  class. Standard function block instances stay excluded (restriction), and so does
  `REF_TO` an interface, which is already a reference.
- `REF(m1)` follows ADR 0015's lifetime rule: the instance must live as long as the
  program instance (a `VAR` instance of a `PROGRAM`, `FUNCTION_BLOCK` or class, a
  global, an array element of those, or `THIS`). `REF()` of an in-out instance stays a
  compile error.
- Through `r : REF_TO Motor`: `r^.Start();`, `r^.Speed`, and for a function block
  `r^(Enable := TRUE);`. Access specifiers apply as through the instance. `NULL`
  faults with `runtime.null-reference` (ADR 0015).
- A `REF_TO Motor` accepts a `REF_TO Servo` when `Servo` extends `Motor`, directly or
  indirectly; the other direction needs `?=`. `=` and `<>` compare references whose
  types are the same or related by inheritance, or a reference with `NULL`. All other
  reference rules of ADR 0015 stay.

### Dynamic binding and recursion

- Every function block and class instance carries its actual type. A method call
  through `THIS` (explicit or implicit), an interface variable or a reference runs the
  implementation of the instance's actual type. A call on an instance variable
  (`m1.Start()`) also runs that type's implementation; since an instance variable
  always holds an instance of its declared type, the target is known at compile time.
  `SUPER.M()` always runs the base implementation.
- The recursion rule of ADR 0014 extends to methods: the compiler builds the call
  graph over functions, function block bodies and methods. A call through `THIS`, an
  interface or a reference adds an edge to every implementation it could run (every
  override in the type and its derived types, or every implementing method of every
  type in the project). Any cycle is a compile error. This is conservative: it can
  reject a program whose cycle never runs (restriction).

### Namespaces

- A source may wrap its one declaration in a namespace:

  ```
  NAMESPACE Conveyor.Devices
  USING Common;
  CLASS Motor
    ...
  END_CLASS
  END_NAMESPACE
  ```

  The namespace holds exactly one data type, function, function block, program, class
  or interface (restriction, keeping one declaration per source). `NAMESPACE A.B` is
  the only way to write nested namespaces; `NAMESPACE A NAMESPACE B ...` is a compile
  error (restriction). A namespace has no source of its own: it exists when a source
  declares into it. The configuration source cannot be in a namespace.

- Names: a declaration in `Conveyor.Devices` has the qualified name
  `Conveyor.Devices.Motor`. Two declarations may share a simple name in different
  namespaces. The first segment of every namespace name joins the ADR 0014 namespace,
  so a global declaration, a configuration name or a global variable named `Conveyor`
  is a compile error, and so is a variable, parameter or member named `Conveyor`
  anywhere (restriction; it keeps `Conveyor.x` unambiguous between a namespace and a
  member access).
- Resolution of a simple name used as a type, POU, class or interface, after local
  variables: the source's own namespace, then each enclosing namespace outward, then
  the names imported by `USING`, then the global namespace (including standard names).
  A qualified name (`Conveyor.Devices.Motor`) is always resolved from the global
  namespace.
- `USING Common, Lib.Util;` follows the `NAMESPACE` line, or the POU header in a source
  without a namespace, and imports the declarations directly in the named namespaces.
  A name that two `USING` namespaces both provide is a compile error where it is used;
  it can still be written qualified. An unknown namespace is a
  compile error.
- `INTERNAL` before a declaration inside a namespace (`CLASS INTERNAL Helper`) limits
  its use to sources in the same namespace or a namespace nested inside it. On
  members and methods it means the same, relative to the declaring type's namespace.
  `NAMESPACE INTERNAL` is a compile error (restriction).
- Standard functions, standard function blocks and elementary types live in the global
  namespace. Today's unqualified declarations stay in the global namespace, so existing
  projects mean the same.
- A configuration names a namespaced program by its qualified name, since the
  configuration source has no namespace and no `USING`:
  `PROGRAM P WITH T : Conveyor.Main;`. Instance, task and global names stay global.

### Instance memory, restarts and faults

- Class instances are initialized, retained and restarted as function block instances
  are (ADR 0014, ADR 0016), including the qualifier inheritance of ADR 0016 for members
  in `RETAIN` or `NON_RETAIN` sections. Inherited members are part of the instance.
- Interface variables and references are never retained: load, cold reset, warm
  restart and reload set them to `NULL`; STOP → RUN, single scan and FAULT keep them.
- A run-time fault inside a method names the method as `Counter.Increment`, the POU
  text it occurred in, and the instance path when known (`Station.Conveyor1`), so the
  span is shown in the right source. A fault inside an inherited method names the
  declaring type's text.
- ADR 0010's loop limit counts method execution as part of the task run (ADR 0016).

### Monitoring and protocol

- Class instances are monitored like user function block instances (ADR 0014): every
  scalar non-`CONSTANT` `VAR` member gets a `VariableId` with a dotted path
  (`Line.Valve1.Position`), whatever its access specifier. Inherited members appear
  under the instance with their own names, since a derived type cannot redeclare them
  (`Servo1.Speed` for `Speed` declared in `Motor`).
- Writes and forces work on these members as on function block members today, whatever
  their access specifiers: the monitor is a debugging tool, not program code.
- Interface variables and references to instances are snapshotted as the existing
  `{ kind: "reference"; target: string | null }` with the target instance's display
  path, and reject writes and forces, as references do (ADR 0015).
- Method variables are absent from snapshots, writes and forces, as function variables
  are.
- Inline values stay limited to `PROGRAM` bodies until Milestone 8. A method call in a
  `PROGRAM` body shows its result as a function call does; a method without a result
  shows nothing.
- Diagnostics and the monitor name types by their qualified names when they are in a
  namespace (`Conveyor.Devices.Motor`). Variable paths are unchanged, since they start
  from instances and globals.

### IR

- Function block and class definitions carry their methods, base type, implemented
  interfaces and a method table that maps each method name to the implementation for
  that type. Instances carry their actual type, so calls through interfaces, references
  and `THIS` select the implementation at run time. Bodies of functions, function
  blocks and methods still appear once. The exact shape belongs to #175 and the later
  sub-issues of #173.

### Project file

- TC6 v2.01 has no element for methods, classes, interfaces, inheritance or namespaces.
  The exact source text in the benchtop-plc source extension stays authoritative for
  them, as program parameter connections are in ADR 0016. The standard elements carry
  what TC6 can express, so other tools still see a usable subset:
  - A function block with methods is written as today: its variables and body as
    `pouType="functionBlock"`, without the methods. Other tools see the block without
    its methods, base type or interfaces.
  - A class is written as `pouType="functionBlock"` with its variable sections and an
    empty ST body. Other tools see a function block that does nothing when called.
  - Interfaces have no TC6 counterpart. They are written in a project-root `addData`
    record, `https://github.com/yasukei/benchtop-plc/ns/interface/1`, with one
    `source` element per interface in project order. Other tools do not see them.
  - A namespaced declaration is written with its qualified name in `name` (TC6 allows
    any string) and in every `derived` type reference and `typeName`, so
    `<pou name="Conveyor.Devices.Motor">` and `<derived name="Conveyor.Devices.Motor"/>`.
- On open, a source extension is accepted as today when it parses to a declaration
  that matches the standard element: the same kind, except that a `CLASS` source
  matches a `functionBlock` POU with an empty body; the same qualified name,
  declarations and body, where a function block's body excludes its methods. Otherwise
  `project.stale-source` applies as today. A POU without the extension whose name is
  qualified gets a generated source wrapped in `NAMESPACE`.
- Access specifiers, `ABSTRACT`, `FINAL`, `EXTENDS`, `IMPLEMENTS` and `USING` exist
  only in the source text (restriction).
- 0.6.0 files open unchanged, and a project that uses none of the new features saves
  as 0.6.0 wrote it.

### Web app

- The source list adds "Class" and "Interface" to the kinds a user can add, with
  templates: an empty class with one public method, and an interface with one method
  prototype. Function block templates stay as they are; methods are added by editing.
- Interfaces are listed after the data types and before the other POUs, as data types
  are listed before POUs (ADR 0015), so the order survives the project-root record.
- A namespaced source is listed under its qualified name.

### Names

- `CLASS`, `END_CLASS`, `METHOD`, `END_METHOD`, `INTERFACE`, `END_INTERFACE`,
  `EXTENDS`, `IMPLEMENTS`, `OVERRIDE`, `ABSTRACT`, `FINAL`, `THIS`, `SUPER`, `PUBLIC`,
  `PRIVATE`, `PROTECTED`, `INTERNAL`, `NAMESPACE`, `END_NAMESPACE` and `USING` join the
  reserved words, and `?=` becomes a token. A program that uses one of these words as
  an identifier stops compiling; the changelog says so (ADR 0011). The bundled examples
  use none of them.

### Restrictions and points to check

The following decisions are based on the 3rd edition and need verification against the
4th edition text:

- The syntax of `METHOD`, `CLASS`, `INTERFACE`, `EXTENDS`, `IMPLEMENTS`, `OVERRIDE`,
  `ABSTRACT`, `FINAL` and `NAMESPACE`; whether `THIS` and `SUPER` are written with `.`
  (as here) or with `^.` (as CODESYS writes them).
- The default access specifier of methods and of class variables is `PROTECTED`;
  `INTERNAL` means visible within the namespace.
- Method variables are temporary; methods return the value last assigned to their name.
- A class has no body and allows `VAR` and `VAR_EXTERNAL`, not `VAR_INPUT`, `VAR_OUTPUT`
  or `VAR_IN_OUT`.
- Single inheritance; an override keeps the signature; `SUPER()` calls the base
  function block body; abstract types cannot be instantiated.
- Interfaces contain public method prototypes only and may extend several interfaces;
  interface variables are references with `NULL` as default.
- `?=` stores `NULL` when the instance does not fit the target, and works on interface
  variables and references.
- Standard names live in the global namespace; `USING` imports the declarations of a
  namespace; the resolution order.

The following are benchtop-plc restrictions or choices, not claims that the standard
forbids other behavior:

- Methods allow no `VAR_TEMP`, `VAR_EXTERNAL`, retention qualifiers or instances; their
  variables cannot shadow members; `THIS(...)` cannot call the body.
- `VAR_INPUT` and `VAR_OUTPUT` of a function block take no access specifier; access is
  checked by type.
- Class and function block instances cannot be structure members, `CONSTANT` or
  initialized, and need the ADR 0015 lifetime to be referred to.
- A function block extends only a function block and a class only a class; an
  override has the same access specifier; `ABSTRACT` with `FINAL`, and an abstract
  function block with a body, are rejected.
- The recursion check treats every possible target of a dynamic call as called.
- `REF_TO` standard function blocks and interfaces stays excluded; a reference to a
  base type accepts a derived instance only implicitly upward.
- One declaration per namespace source; nested namespaces only as `NAMESPACE A.B`; no
  `NAMESPACE INTERNAL`; the first segment of a namespace name cannot be used as any
  other name; the configuration source cannot be in a namespace.
- Methods, classes, interfaces, inheritance, access specifiers and namespaces exist
  only in the source text of the project file; interfaces live in a project-root
  `addData` record and are listed after data types.

Issue #92 records each item. If a decision changes, the corresponding item there must
change with it. This ADR does not update `docs/compliance.md`: each implementing
sub-issue records its matching items there when the feature is implemented.

### Deferred scope

This ADR does not introduce properties (`PROPERTY`), dynamic instances (`__NEW`,
`__DELETE`), references to methods, generic types, UTF-8 strings or other 4th edition
additions, or IEC 61131-10 exchange; their texts or definitions are not available or
they are vendor extensions. Breakpoints, inline values inside function block, class
and method bodies, and choosing the instance they show belong to Milestone 8.

## Consequences

- Users can model devices as classes and function blocks with methods, share
  behavior through inheritance, and drive different devices through one interface.
- Keeping one declaration per source, now optionally inside a namespace, keeps the
  editor, the project file and the diagnostics model of ADR 0014 to 0016, at the cost
  of not grouping several declarations in one `NAMESPACE` block.
- Dynamic binding needs every instance to carry its type and the recursion check to
  consider every possible target. The check may reject some programs that would run;
  the restriction can be relaxed later without breaking accepted programs.
- Twenty new reserved words can break existing programs that use them as names; this
  is allowed in 0.x and listed in the changelog.
- Other PLCopen tools see classes as empty function blocks and do not see methods,
  inheritance, interfaces or namespaces semantics. benchtop-plc files keep their full
  meaning through the source extension.
- Implementation and conformance tests belong to the remaining sub-issues of #173.
  Accepting this ADR records the design; it does not make these features available in
  the app.
