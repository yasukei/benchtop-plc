# 0006. PLCopen XML as the project format

- Status: Accepted
- Date: 2026-10-16

## Context
Projects need a file format. A custom JSON format is easy but isolated; PLCopen XML (TC6) is the vendor-neutral exchange format for IEC 61131-3 projects.

## Decision
Save and load projects as PLCopen XML TC6 v2.01. Store data the standard does not cover, such as the operator panel layout, in `addData` under our own versioned namespace. The editor shows a textual POU and the project package converts it to and from the XML split of `interface` and `body`.

## Consequences
Projects can, in principle, be exchanged with other IEC 61131-3 tools. XML handling is more work than JSON, and conversion between the textual and XML forms must be kept lossless by tests.
