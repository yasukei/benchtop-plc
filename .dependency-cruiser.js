// @ts-check
// Enforces the package dependency direction (docs: AGENTS.md):
//   web → compiler | runtime | project → core, and project → compiler.

/** Workspace packages each package may import, besides itself. */
const allowedDependencies = {
  core: [],
  compiler: ["core"],
  runtime: ["core"],
  project: ["core", "compiler"],
  web: ["core", "compiler", "runtime", "project"],
};

const packages = Object.keys(allowedDependencies);

/** @type {import("dependency-cruiser").IForbiddenRuleType[]} */
const directionRules = Object.entries(allowedDependencies).flatMap(([name, allowed]) => {
  const forbidden = packages.filter((other) => other !== name && !allowed.includes(other));
  if (forbidden.length === 0) return [];
  return [
    {
      name: `${name}-dependency-direction`,
      severity: "error",
      comment: `packages/${name} may only depend on: ${allowed.join(", ") || "nothing"}.`,
      from: { path: `^packages/${name}/` },
      to: { path: `^packages/(${forbidden.join("|")})/` },
    },
  ];
});

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    ...directionRules,
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Imports must resolve. A workspace package must be listed in package.json.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|coverage)/" },
    // Count type-only imports too: they couple packages just as much.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: ["@benchtop-plc/source", "import", "default"],
      exportsFields: ["exports"],
      extensions: [".ts", ".tsx", ".js", ".json"],
    },
  },
};
