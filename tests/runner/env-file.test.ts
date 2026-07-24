import { readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeEnvFile, renderDotenv, sweepEnvFile, writeEnvFile } from "../../src/runner/env-file.js";
import { LANEYARD_MARKER } from "../../src/runner/gradle-properties.js";
import { tmpDir } from "../fixtures/repos.js";

/**
 * A small dotenv reader, written here on purpose.
 *
 * The assertion that matters is not "the string looks right" — it is "a parser
 * reads back exactly what went in". Testing against the writer's own idea of the
 * format would pass however wrong that idea was.
 */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq);
    const raw = line.slice(eq + 1);
    out[key] = raw.startsWith('"')
      ? raw
          .slice(1, -1)
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
      : raw;
  }
  return out;
}

describe("renderDotenv", () => {
  it("writes one variable per line, sorted by name", () => {
    // Sorted so a diff of two runs is a diff of what changed, not of what moved.
    expect(renderDotenv({ B: "2", A: "1", C: "3" })).toBe("A=1\nB=2\nC=3\n");
  });

  it("leaves an ordinary value bare, so the file reads like one a person wrote", () => {
    expect(renderDotenv({ API_URL: "https://api.example.com" })).toBe("API_URL=https://api.example.com\n");
  });

  it("quotes a value a bare line would not survive", () => {
    expect(renderDotenv({ A: "has space" })).toBe('A="has space"\n');
    expect(renderDotenv({ A: "has#hash" })).toBe('A="has#hash"\n');
    expect(renderDotenv({ A: 'has"quote' })).toBe('A="has\\"quote"\n');
    expect(renderDotenv({ A: "has\\backslash" })).toBe('A="has\\\\backslash"\n');
  });

  it("escapes a newline rather than writing one", () => {
    // Written literally, the value would end at the line break and the rest
    // would be read as another variable — or as nothing. A private key pasted
    // into a variable is the case that makes this real.
    const rendered = renderDotenv({ KEY: "line\nbreak" });
    expect(rendered).toBe('KEY="line\\nbreak"\n');
    expect(rendered.split("\n")).toHaveLength(2);
  });

  it("writes an empty value as an empty value", () => {
    expect(renderDotenv({ A: "" })).toBe("A=\n");
  });

  it("writes nothing at all for no variables", () => {
    expect(renderDotenv({})).toBe("");
  });

  it("round-trips every shape through a parser", () => {
    const values = {
      PLAIN: "plain",
      SPACED: "has space",
      HASHED: "has#hash",
      QUOTED: 'has"quote',
      SLASHED: "has\\backslash",
      MULTILINE: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      EMPTY: "",
      EQUALS: "a=b=c",
      LEADING: "  padded  ",
    };

    expect(parseDotenv(renderDotenv(values))).toEqual(values);
  });
});

describe("writeEnvFile", () => {
  it("writes nothing, and returns null, for a project that names no file", async () => {
    const root = await tmpDir("laneyard-env-");
    expect(await writeEnvFile(root, undefined, { A: "1" })).toBeNull();
  });

  it("writes the file at the configured path, marked and readable only by its owner", async () => {
    const root = await tmpDir("laneyard-env-");
    const path = await writeEnvFile(root, ".env", { API_URL: "https://api.example.com" });

    expect(path).toBe(join(root, ".env"));
    expect(await readFile(path!, "utf8")).toBe(`${LANEYARD_MARKER}\nAPI_URL=https://api.example.com\n`);
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
  });

  it("creates the directories the path names", async () => {
    const root = await tmpDir("laneyard-env-");
    const path = await writeEnvFile(root, "ios/config/.env", { A: "1" });
    expect(existsSync(path!)).toBe(true);
  });

  it("replaces a file it wrote itself", async () => {
    const root = await tmpDir("laneyard-env-");
    await writeEnvFile(root, ".env", { A: "first" });
    await writeEnvFile(root, ".env", { A: "second" });

    expect(await readFile(join(root, ".env"), "utf8")).toContain("A=second");
  });

  it("never writes over a file of the user's own", async () => {
    // The clone is a working tree someone can edit by hand. A `.env` they put
    // there is their build's real configuration, and replacing it with one
    // assembled from tick boxes would break something that worked.
    const root = await tmpDir("laneyard-env-");
    const theirs = "API_URL=http://localhost:3000\n";
    await writeFile(join(root, ".env"), theirs, "utf8");

    expect(await writeEnvFile(root, ".env", { API_URL: "https://api.example.com" })).toBeNull();
    expect(await readFile(join(root, ".env"), "utf8")).toBe(theirs);
  });
});

describe("removeEnvFile", () => {
  it("removes a file Laneyard wrote", async () => {
    const root = await tmpDir("laneyard-env-");
    const path = await writeEnvFile(root, ".env", { A: "1" });

    await removeEnvFile(path);
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("leaves a file without the marker where it is", async () => {
    const root = await tmpDir("laneyard-env-");
    await writeFile(join(root, ".env"), "A=theirs\n", "utf8");

    await removeEnvFile(join(root, ".env"));
    expect(await readFile(join(root, ".env"), "utf8")).toBe("A=theirs\n");
  });

  it("takes null without complaining", async () => {
    await expect(removeEnvFile(null)).resolves.toBeUndefined();
  });
});

describe("sweepEnvFile", () => {
  it("removes what a run killed mid-build left behind", async () => {
    const root = await tmpDir("laneyard-env-");
    await writeEnvFile(root, ".env", { TOKEN: "left-behind" });

    await sweepEnvFile(root, ".env");
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("leaves the user's own file alone, and is silent about a clone that is not there", async () => {
    const root = await tmpDir("laneyard-env-");
    await writeFile(join(root, ".env"), "A=theirs\n", "utf8");

    await sweepEnvFile(root, ".env");
    expect(await readFile(join(root, ".env"), "utf8")).toBe("A=theirs\n");

    await expect(sweepEnvFile(join(root, "never-cloned"), ".env")).resolves.toBeUndefined();
    await expect(sweepEnvFile(root, undefined)).resolves.toBeUndefined();
  });
});
