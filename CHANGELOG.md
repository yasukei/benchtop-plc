# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, any release may break compatibility, including saved project files.

## [Unreleased]

### Added

- A public demo at https://yasukei.github.io/benchtop-plc/ always runs the latest
  `main` in the browser.

### Fixed

- Saved PLCopen projects now identify the writing app's package version, including
  when resaving older projects, while preserving unrelated project metadata.

## [0.1.0] - 2026-10-18

First release: the single-file HTML prototype rebuilt as a tested monorepo.

### Added

- Structured Text compiler with diagnostics: one `PROGRAM`, the types `BOOL`,
  `INT`, `DINT`, `UINT`, `REAL`, `LREAL` and `TIME`, and the statements `IF`,
  `CASE`, `FOR`, `WHILE`, `REPEAT`, `EXIT` and `RETURN`.
- Scan-cycle runtime with the operating states STOP, RUN and FAULT and an
  emergency-stop overlay.
- Standard function blocks `TON`, `TOF`, `TP`, `R_TRIG`, `F_TRIG`, `CTU` and
  `CTD`, and the standard functions `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL` and basic
  type conversions.
- Debugging: force and write variables, single scan, and live values shown next
  to the source.
- Operator panel with LEDs, push buttons, selector switches and an emergency
  stop on the bits `%IX0.0`–`%IX0.7` and `%QX0.0`–`%QX0.7`, plus an I/O image and
  a variable monitor.
- Open and save projects as PLCopen XML (TC6 v2.01).
- English and Japanese user interface.
- Work is saved automatically in the browser, and the theme follows the system
  setting unless you choose Light or Dark.
- The app opens with the blink example and its panel.

[Unreleased]: https://github.com/yasukei/benchtop-plc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yasukei/benchtop-plc/releases/tag/v0.1.0
