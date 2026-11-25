// The Node entry to lease.sh's machine-wide leases, for the core's Node tools
// (a project's code uses the config's lease command instead, hooks.lease): `takeLease(kind)` holds one through a `lease.sh hold` child, which
// releases it when `release()` is called, when this process exits (its stdin
// closes), or when this process's pid is gone, so even a SIGKILL frees it.
//
//   import { takeLease } from "<repo>/scripts/loops/lease.mjs";
//   const lease = await takeLease("browser", { label: "my-tool" });
//   try { … } finally { await lease.release(); }
//
// It waits while every lease of the kind is taken (lease.sh's messages go to
// stderr), and rejects if lease.sh gives up (exit 75). The env (default
// process.env) sets the limits and directories, as for lease.sh; with
// CARETOOK_LEASES=off it takes nothing and resolves at once.
import { spawn } from "node:child_process";

export const LEASE_SH = new URL("./lease.sh", import.meta.url).pathname;

/**
 * @param {string} kind  browser, check, …
 * @param {{ label?: string, wait?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ n: number, path: string | null, release: () => Promise<void> }>}
 */
export function takeLease(kind, { label, wait, env = process.env } = {}) {
  if (env.CARETOOK_LEASES === "off") return Promise.resolve({ n: 0, path: null, release: async () => {} });
  const args = [
    LEASE_SH,
    "hold",
    kind,
    "--label",
    label ?? `node ${process.pid}`,
    "--watch",
    String(process.pid),
  ];
  if (wait != null) args.push("--wait", String(wait));
  const child = spawn("bash", args, { env, stdio: ["pipe", "pipe", "inherit"] });
  let exited = false;
  const gone = new Promise((resolve) => child.once("exit", () => resolve(undefined)));
  void gone.then(() => (exited = true));
  const release = async () => {
    if (exited) return;
    child.stdin.end();
    await gone;
  };
  return new Promise((resolve, reject) => {
    let out = "";
    let done = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = /^lease (\d+) (.+)$/m.exec(out);
      if (m && !done) {
        done = true;
        resolve({ n: Number(m[1]), path: m[2] === "(off)" ? null : m[2], release });
      }
    });
    child.once("exit", (code, signal) => {
      if (done) return;
      done = true;
      reject(new Error(`no ${kind} lease: lease.sh exited with ${code ?? signal}`));
    });
    child.once("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}
