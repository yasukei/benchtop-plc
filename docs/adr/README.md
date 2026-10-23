# Architecture Decision Records

An ADR records one design decision: its context, the decision, and its consequences.

- One decision per file, numbered: `NNNN-short-title.md`. Copy `template.md`.
- ADRs are not edited after they are accepted. To change a decision, add a new ADR and
  mark the old one `Superseded by NNNN`.
- Implementation follows accepted ADRs. If an issue conflicts with an ADR, raise it in the
  PR instead of silently diverging.

## Index

- [0001. Monorepo packages and dependency direction](0001-monorepo-packages-and-dependency-direction.md)
- [0002. Tree-shaped IR as plain data](0002-tree-shaped-ir-as-plain-data.md)
- [0003. Injected clock](0003-injected-clock.md)
- [0004. Diagnostics as codes with arguments](0004-diagnostics-as-codes-with-arguments.md)
- [0005. System-level emergency stop](0005-system-level-emergency-stop.md)
- [0006. PLCopen XML as the project format](0006-plcopen-xml-project-format.md)
- [0007. React UI with logic outside components](0007-react-ui-with-logic-outside-components.md)
- [0008. English and Japanese from the start](0008-english-and-japanese-from-the-start.md)
- [0009. Emergency stop overlays the operating state](0009-emergency-stop-overlay.md)
- [0010. Operating states, restarts and run-time errors](0010-operating-states-restarts-and-runtime-errors.md)
- [0011. Versioning, changelog and releases](0011-versioning-changelog-and-releases.md)
- [0012. Elementary data types, ranges and overflow](0012-elementary-data-types.md)
- [0013. Conversions, literal typing and operators](0013-conversions-literals-and-operators.md)
- [0014. User-defined POUs, calls and instances](0014-user-defined-pous.md)
- [0015. Derived data types, strings and references](0015-derived-types-strings-and-references.md)
