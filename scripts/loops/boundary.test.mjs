// The boundary lint (boundary.mjs): each rule and form on a sample project, the
// manifest and the allowlist, and this repo itself, which must pass.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  FORMS,
  MANIFEST,
  ROOTS,
  RULES,
  allowlistText,
  codeOf,
  findingLine,
  findings,
  lintRepo,
  manifestProblems,
  parseAllowlist,
  parseManifest,
  readsProjectFile,
  refused,
} from "./boundary.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");

// A sample project, "acme": its folders are web/ and server/, its variables ACME_*.
const project = { names: ["acme"], envPrefixes: ["ACME_"], appPaths: ["web", "server"] };
const CORE = "scripts/loops/tool.sh";
const CORE_JS = "scripts/loops/engine.mjs";
const OWNERS = new Map([
  [CORE, "core"],
  [CORE_JS, "core"],
  ["scripts/loops/held.mjs", "core"],
  ["scripts/backlog/items.mjs", "core"],
  ["scripts/loops/areas.mjs", "project"],
  ["scripts/loops/areas.d/one", "project"],
  ["scripts/loops/areas.d/two", "project"],
  ["scripts/project/up.sh", "project"],
  ["scripts/project/data.json", "project"],
  ["scripts/specs/sign-in.spec.mjs", "project"],
]);
/** The findings for one file's text, as `line rule form text`. */
const lint = (file, text) =>
  findings({ files: new Map([[file, text]]), owners: OWNERS, project }).map(
    (f) => `${f.line} ${f.rule} ${f.form ?? "-"} ${f.text}`,
  );

describe("a core file", () => {
  it("may not hold a project variable or the project's name, in code or in a comment", () => {
    expect(lint(CORE, 'x=${ACME_SLOTS:-2}\n# the acme stack\necho "$ACME_HOME/.acme/inbox Acme"\n')).toEqual([
      "1 project-env - ACME_SLOTS",
      "2 project-name - acme",
      "3 project-env - ACME_HOME",
      "3 project-name - /.acme/inbox",
      "3 project-name - Acme",
    ]);
    // A variable is the prefix at a word's start; the name counts anywhere, in any case.
    expect(lint(CORE_JS, "const lock = `${dir}/acme-backlog.lock`; // MACME_X\n")).toEqual([
      "1 project-name - /acme-backlog.lock",
      "1 project-name - MACME_X",
    ]);
  });

  it("may not name one of the project's own folders, but for a comment", () => {
    expect(
      lint(CORE, 'grep -q "^web/app/" <<< "$changed" # server/ too\ncat "$main/server/src/db.ts"\n'),
    ).toEqual(["1 app-path - web/app/", "2 app-path - server/src/db.ts"]);
    expect(
      lint(CORE_JS, "const FULL = [/^server\\/src\\/migrations\\//]; // web/app\nf.startsWith('web/');\n"),
    ).toEqual(["1 app-path - server/src/migrations/", "2 app-path - web/"]);
    expect(lint(CORE_JS, "const cobweb = 'cobweb/x' + \"my-server/y\";\n")).toEqual([]);
  });

  it.each([
    ["import", CORE_JS, 'import { resolve } from "./areas.mjs";', "scripts/loops/areas.mjs"],
    ["import", CORE_JS, 'const m = await import("../project/data.json");', "scripts/project/data.json"],
    ["import", CORE_JS, 'const m = require("./areas.mjs");', "scripts/loops/areas.mjs"],
    ["import", CORE, 'source "$(dirname "${BASH_SOURCE[0]}")/../project/up.sh"', "scripts/project/up.sh"],
    ["--import", CORE, 'node --import "$here/areas.mjs" server.js', "scripts/loops/areas.mjs"],
    [
      "--import",
      CORE_JS,
      'spawnSync("node", ["--import", join(HERE, "areas.mjs"), "x"]);',
      "scripts/loops/areas.mjs",
    ],
    ["spawn", CORE, '"$bin/../project/up.sh" --wait', "scripts/project/up.sh"],
    ["spawn", CORE, 'ok && node "$main/scripts/loops/areas.mjs" lint', "scripts/loops/areas.mjs"],
    ["spawn", CORE_JS, 'spawnSync("bash", [join(HERE, "../project/up.sh")]);', "scripts/project/up.sh"],
    ["spawn", CORE_JS, "execFileSync(`${HERE}/areas.mjs`);", "scripts/loops/areas.mjs"],
    ["path", CORE, "manifest=$main/scripts/project/data.json", "scripts/project/data.json"],
    ["path", CORE_JS, 'const AREAS = new URL("./areas.d", import.meta.url);', "scripts/loops/areas.d"],
    ["path", CORE_JS, 'const SPECS = "scripts/specs/";', "scripts/specs"],
    [
      "path",
      CORE_JS,
      'const RE = /^scripts\\/project\\//; cp("scripts/specs/*.spec.mjs");',
      "scripts/project",
    ],
  ])("may not reach a project file: %s", (form, file, line, reached) => {
    const got = lint(file, `${line}\n`);
    expect(got[0]).toBe(`1 core-to-project ${form} ${reached}`);
    expect(got.every((l) => l.startsWith("1 core-to-project"))).toBe(true);
  });

  it("may reach its own side, its own folder while project files still sit there, and a comment's path", () => {
    const text = [
      'import { held } from "./held.mjs";',
      'import { items } from "../backlog/items.mjs";',
      "const TOOLING = /^(scripts\\/loops\\/|scripts\\/backlog\\/)/;",
      "// see ./areas.mjs and scripts/project/up.sh",
      "/* scripts/project/data.json */ const n = a / b / c;",
      'const usage = "engine.mjs --mode x"; const url = "https://example.com/scripts/project";',
    ].join("\n");
    expect(lint(CORE_JS, text)).toEqual([]);
    expect(
      lint(CORE, 'source "$here/held.sh" # then scripts/project/up.sh\n: "${n#x}" # ./areas.mjs\n'),
    ).toEqual([]);
  });

  it("reads a here-document and a quoted `#` as code, and a `#` word as a comment", () => {
    const text = [
      "cat <<EOF",
      "# run scripts/project/up.sh",
      "EOF",
      'echo "# ./areas.mjs"',
      "x=1 # ./areas.mjs",
    ].join("\n");
    expect(lint(CORE, text)).toEqual([
      "2 core-to-project path scripts/project/up.sh",
      "4 core-to-project path scripts/loops/areas.mjs",
    ]);
    expect(codeOf(CORE, "a # b\n").length).toBe(6);
    expect(codeOf(CORE_JS, "a // b\n/* c\nd */ e\n")).toBe("a     \n    \n     e\n");
    expect(codeOf("x.yml", "run: x # y\n")).toBe("run: x    \n");
    expect(codeOf("x.json", '{"a": "# b"}')).toBe('{"a": "# b"}');
  });
});

describe("a project file", () => {
  it.each([
    [
      "import",
      "vitest.config.ts",
      'import { parse } from "./scripts/backlog/items.mjs";',
      "scripts/backlog/items.mjs",
    ],
    ["import", "scripts/loops/areas.mjs", 'import { held } from "./held.mjs";', "scripts/loops/held.mjs"],
    ["import", "scripts/project/up.sh", 'source "$(dirname "$0")/../loops/tool.sh"', "scripts/loops/tool.sh"],
    [
      "--import",
      "package.json",
      '"serve": "node --import ./scripts/loops/held.mjs server.js"',
      "scripts/loops/held.mjs",
    ],
    ["spawn", "package.json", '"tool": "bash scripts/loops/tool.sh",', "scripts/loops/tool.sh"],
    [
      "spawn",
      ".github/workflows/ci.yml",
      "      - run: node scripts/loops/engine.mjs lint",
      "scripts/loops/engine.mjs",
    ],
    [
      "spawn",
      "web/test/lease.ts",
      'spawn("bash", [new URL("../../scripts/loops/tool.sh", import.meta.url).pathname]);',
      "scripts/loops/tool.sh",
    ],
    [
      "path",
      "web/test/lease.ts",
      'const url = new URL("../../scripts/loops/held.mjs", import.meta.url).href;',
      "scripts/loops/held.mjs",
    ],
    ["path", "vitest.config.ts", 'include: ["loops/**/*.test.mjs", "backlog/**"],', "scripts/backlog/**"],
    ["path", "scripts/loops/areas.d/one", "scripts/backlog/     -", "scripts/backlog"],
    ["path", ".github/workflows/ci.yml", "      - 'scripts/loops/**'", "scripts/loops/**"],
  ])("may not reach a core file: %s", (form, file, line, reached) => {
    expect(lint(file, `${line}\n`)).toEqual([`1 project-to-core ${form} ${reached}`]);
  });

  it("may hold its own names and paths, reach its own side, and name the core in a comment", () => {
    const text = [
      "// the tooling: scripts/loops/tool.sh",
      'import { resolve } from "./scripts/loops/areas.mjs";',
      'const env = process.env.ACME_ZONE; const pkg = "@acme/web"; const dir = "web/app";',
      'const data = "scripts/project/data.json"; const areas = "scripts/loops/areas.d";',
      'const specs = ["scripts/specs/*.spec.mjs", "*.test.mjs"];',
    ].join("\n");
    expect(lint("vitest.config.ts", text)).toEqual([]);
    expect(lint("scripts/project/up.sh", "# source ../loops/tool.sh\n. ./data.json\n")).toEqual([]);
  });

  it("is read when it is code or config, not prose", () => {
    for (const f of [
      "package.json",
      "vitest.config.ts",
      ".github/workflows/ci.yml",
      ".githooks/a-hook",
      "web/a.tsx",
      "x.sh",
    ])
      expect(readsProjectFile(f), f).toBe(true);
    for (const f of [
      "README.md",
      "plans/x-plan.md",
      "docs/agents/loop.md",
      "pnpm-lock.yaml",
      "web/logo.png",
      "web/app.css",
    ])
      expect(readsProjectFile(f), f).toBe(false);
  });
});

describe("a finding", () => {
  it("names its file, line, rule and form", () => {
    const found = findings({
      files: new Map([[CORE, 'echo ok\nbash "$here/areas.mjs" "$ACME_DIR"\n']]),
      owners: OWNERS,
      project,
    });
    expect(found.map(findingLine)).toEqual([
      `${CORE}:2: core-to-project (spawn): scripts/loops/areas.mjs`,
      `${CORE}:2: project-env: ACME_DIR`,
    ]);
    expect(found.every((f) => RULES.includes(f.rule) && (f.form === null || FORMS.includes(f.form)))).toBe(
      true,
    );
  });

  it("is never raised on the lint's own data", () => {
    const files = new Map([
      [MANIFEST, "scripts/project/up.sh project\n"],
      [ALLOWLIST, "web/acme.ts project-to-core 1\n"],
    ]);
    expect(
      findings({ files, owners: new Map([...OWNERS, [MANIFEST, "core"], [ALLOWLIST, "core"]]), project }),
    ).toEqual([]);
  });
});

describe("the manifest", () => {
  it("reads one `<path> <owner>` line per file", () => {
    const { owners, problems } = parseManifest(".githooks/a-hook project\nscripts/loops/a.mjs core\n");
    expect(problems).toEqual([]);
    expect([...owners]).toEqual([
      [".githooks/a-hook", "project"],
      ["scripts/loops/a.mjs", "core"],
    ]);
  });

  it("refuses a wrong line, a wrong owner, a file outside its folders, a repeat and a line out of order", () => {
    const text = [
      "scripts/loops/b.mjs core",
      "scripts/loops/a.mjs acme",
      "scripts/loops/a.mjs core",
      "scripts/loops/b.mjs core",
      "web/x.ts project",
      "scripts/ci/x.mjs  core",
    ];
    expect(parseManifest(text.join("\n")).problems).toEqual([
      `${MANIFEST}:2: not \`<path> core|project\`: scripts/loops/a.mjs acme`,
      `${MANIFEST}:3: scripts/loops/a.mjs is out of order (sorted, one file a line)`,
      `${MANIFEST}:4: scripts/loops/b.mjs is listed twice`,
      `${MANIFEST}:5: web/x.ts is outside ${ROOTS.join(", ")}`,
      `${MANIFEST}:6: not \`<path> core|project\`: scripts/ci/x.mjs  core`,
    ]);
  });

  it("must list every file under its folders, and only files", () => {
    const owners = new Map([
      ["scripts/loops/a.mjs", "core"],
      ["scripts/ci/gone.mjs", "project"],
    ]);
    const files = [
      "scripts/loops/a.mjs",
      "scripts/project/new.sh",
      ".githooks/a-hook",
      "scripts/build/x.mjs",
      "web/a.ts",
    ];
    expect(manifestProblems(owners, files)).toEqual([
      `${MANIFEST}: no line for .githooks/a-hook: add \`.githooks/a-hook core\` or \`.githooks/a-hook project\``,
      `${MANIFEST}: no line for scripts/project/new.sh: add \`scripts/project/new.sh core\` or \`scripts/project/new.sh project\``,
      `${MANIFEST}: scripts/ci/gone.mjs is no file: delete its line`,
    ]);
  });
});

describe("the allowlist", () => {
  const found = findings({
    files: new Map([
      [CORE, 'echo "$ACME_A $ACME_B"\nbash "$here/areas.mjs"\n'],
      ["package.json", '"tool": "bash scripts/loops/tool.sh"\n'],
    ]),
    owners: OWNERS,
    project,
  });
  const list = (text) => parseAllowlist(text).allowed;

  it("passes findings it counts exactly", () => {
    const text = `package.json project-to-core 1 # goes at the move\n${CORE} core-to-project 1\n${CORE} project-env 2\n`;
    expect(parseAllowlist(text).problems).toEqual([]);
    expect(refused(found, list(text))).toEqual([]);
    expect(list(text).get("package.json project-to-core")).toEqual({ count: 1, why: "goes at the move" });
  });

  it("fails on a finding it doesn't have, naming each with its file, line, rule and form", () => {
    expect(refused(found, list(`${CORE} project-env 1\n`))).toEqual([
      "package.json project-to-core: 1 found, none allowed",
      "  package.json:1: project-to-core (spawn): scripts/loops/tool.sh",
      `${CORE} core-to-project: 1 found, none allowed`,
      `  ${CORE}:2: core-to-project (spawn): scripts/loops/areas.mjs`,
      `${CORE} project-env: 2 found, the allowlist has 1: one is new (take it out, don't raise the count)`,
      `  ${CORE}:1: project-env: ACME_A`,
      `  ${CORE}:1: project-env: ACME_B`,
    ]);
  });

  it("fails on a count that is too high, and on a line with nothing left", () => {
    const text = `package.json project-to-core 1\n${CORE} core-to-project 1\n${CORE} project-env 3\n${CORE} project-name 2\n`;
    expect(refused(found, list(text))).toEqual([
      `${CORE} project-env: 2 found, the allowlist has 3: lower its count to 2 in ${ALLOWLIST}`,
      `${CORE} project-name: 0 found, the allowlist has 2: delete its line in ${ALLOWLIST}`,
    ]);
  });

  it("refuses a wrong line, an unknown rule, a zero, a repeat and a line out of order", () => {
    const text = [
      "b.sh project-env 1",
      "a.sh project-env 1",
      "a.sh project-env 2",
      "a.sh no-rule 1",
      "a.sh project-name 0",
      "a.sh project-name",
    ];
    expect(parseAllowlist(text.join("\n")).problems.map((p) => p.replace(/ \(rules:.*\)/, ""))).toEqual([
      `${ALLOWLIST}:2: a.sh project-env is out of order (sorted by path, then rule)`,
      `${ALLOWLIST}:3: a.sh project-env is listed twice`,
      `${ALLOWLIST}:4: not \`<path> <rule> <count>\`: a.sh no-rule 1`,
      `${ALLOWLIST}:5: not \`<path> <rule> <count>\`: a.sh project-name 0`,
      `${ALLOWLIST}:6: not \`<path> <rule> <count>\`: a.sh project-name`,
    ]);
  });

  it("is rewritten sorted, one line per file and rule, keeping its heading and each reason", () => {
    const old = `# The heading.\n# Two lines.\npackage.json project-to-core 4 # goes at the move\n${CORE} project-name 1\n`;
    const text = allowlistText(found, old);
    expect(text).toBe(
      `# The heading.\n# Two lines.\npackage.json project-to-core 1 # goes at the move\n${CORE} core-to-project 1\n${CORE} project-env 2\n`,
    );
    expect(parseAllowlist(text).problems).toEqual([]);
    expect(refused(found, list(text))).toEqual([]);
  });
});

describe("CI's two lists", () => {
  it("are data: a core path in one is no finding, while the same line in another file is", () => {
    const line = "scripts/loops/tool.test.mjs\ta flaky test\tB-1\n";
    const owners = new Map([...OWNERS, ["scripts/loops/tool.test.mjs", "core"]]);
    const found = findings({
      files: new Map([
        ["scripts/ci/flaky.txt", line],
        ["scripts/ci/held.txt", line],
        ["scripts/ci/other.txt", line],
      ]),
      owners,
      project,
      data: ["scripts/ci/flaky.txt", "scripts/ci/held.txt"],
    });
    expect(found.map(findingLine)).toEqual([
      "scripts/ci/other.txt:1: project-to-core (path): scripts/loops/tool.test.mjs",
    ]);
  });
});

describe("this repo", () => {
  const result = lintRepo(ROOT);

  it("has every file under the manifest's folders in the manifest, sorted, each with an owner", () => {
    expect(result.problems).toEqual([]);
  });

  it("crosses the line only where the allowlist says", () => {
    expect(result.failures).toEqual([]);
  });

  it("ignores a CI test step's output written while it runs (B-753's progress file)", () => {
    const dir = join(ROOT, "ci-results");
    const file = join(dir, `boundary-${process.pid}.progress.json`);
    const made = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    const started = ["scripts/loops/boundary.test.mjs", "scripts/loops/boundary.mjs"];
    writeFileSync(
      file,
      JSON.stringify({ limitSeconds: 300, started, finished: [], failed: [], timedOut: [] }),
    );
    try {
      const during = lintRepo(ROOT);
      expect(during.failures).toEqual([]);
      expect(during.problems).toEqual([]);
    } finally {
      rmSync(made ? dir : file, { recursive: true, force: true });
    }
  });

  it("passes from the command line too", () => {
    const r = spawnSync(process.execPath, [join(HERE, "boundary.mjs")], { encoding: "utf8" });
    expect(r.stdout).toMatch(/^boundary: ok \(\d+ allowed\)\n$/);
    expect(r.status).toBe(0);
    expect(spawnSync(process.execPath, [join(HERE, "boundary.mjs"), "--nope"]).status).toBe(2);
  });
});
