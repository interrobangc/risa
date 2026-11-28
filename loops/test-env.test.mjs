import { describe, expect, it } from "vitest";
import { FIXTURE_CONFIG } from "./config-fixture.mjs";
import { hermeticEnv } from "./test-env.mjs";

// A session's environment: another repo's config and a session's state.
const SESSION = {
  RISA_CONFIG: "/work/other-repo/risa.json",
  RISA_CONFIG_FOUND: "/work/other-repo/risa.json",
  RISA_MACHINE_CONFIG: "/home/sam/.risa/machine.json",
  RISA_SESSION_PID: "4242",
  RISA_SESSION_NAME: "after-split",
  RISA_SESSIONS_DIR: "/home/sam/.risa/sessions",
  RISA_USAGE_DIR: "/home/sam/.risa/usage",
  RISA_MAIN: "/work/other-repo",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  PATH: "/usr/bin:/bin",
  HOME: "/home/sam",
};

describe("hermeticEnv", () => {
  it("turns a session's environment into the fixture's", () => {
    const env = hermeticEnv(SESSION);
    expect(env.RISA_CONFIG).toBe(FIXTURE_CONFIG);
    expect(env.RISA_MACHINE_CONFIG).toBe("");
    for (const name of [
      "RISA_CONFIG_FOUND",
      "RISA_SESSION_PID",
      "RISA_SESSION_NAME",
      "RISA_SESSIONS_DIR",
      "RISA_USAGE_DIR",
      "RISA_MAIN",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
    ])
      expect(env).not.toHaveProperty(name);
  });

  it("drops an inherited CLAUDE_CONFIG_DIR (RISA-1076)", () => {
    const env = hermeticEnv({ ...SESSION, CLAUDE_CONFIG_DIR: "/home/sam/.claude-second" });
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("keeps RISA_TEST_CONFIG as the config", () => {
    const env = hermeticEnv({ ...SESSION, RISA_TEST_CONFIG: "/tmp/test/risa.json" });
    expect(env.RISA_CONFIG).toBe("/tmp/test/risa.json");
  });

  it("passes unrelated variables through and leaves its input alone", () => {
    const input = { ...SESSION };
    const env = hermeticEnv(input);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/sam");
    expect(input).toEqual(SESSION);
  });
});
