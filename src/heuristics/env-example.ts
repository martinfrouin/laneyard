/**
 * The variable names a `.env.example` advertises.
 *
 * A project that keeps its variables in `fastlane/.env` almost always commits a
 * `.env.example` beside it — that is what the file is *for*: telling whoever
 * clones the repository which variables they need. It is the one manifest of
 * required variables that is both conventional and, unlike `.env` itself,
 * actually present in the clone a build runs from.
 *
 * It catches what parsing the Fastfile cannot. `SENTRY_AUTH_TOKEN` is read by
 * `sentry-cli`, not by any `ENV.fetch` in a lane, so no amount of reading the
 * Fastfile finds it — and it sits in `.env.example`, named, all along.
 *
 * Only names are taken. The file is an example by definition, so its values are
 * placeholders; reading them would be reading fiction, and a checklist that
 * compared them to anything would be worse than one that did not look.
 */
export function parseEnvExample(content: string): string[] {
  const names: string[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    // `export FOO=bar` is legal in these files and means the same thing.
    const assignment = line.replace(/^export\s+/, "");
    const eq = assignment.indexOf("=");
    if (eq <= 0) continue;

    const name = assignment.slice(0, eq).trim();
    // Shell-ish variable names only: anything else is a line this has
    // misunderstood, and inventing a requirement is worse than missing one.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
  }

  return [...new Set(names)];
}
