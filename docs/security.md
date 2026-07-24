# Security

Read this before putting Laneyard on a network.

- **It is built for a local network, not the internet.** It listens on `0.0.0.0` so you can reach it
  from your laptop, behind a password. Do not expose it publicly — use a VPN or an SSH tunnel.
- **Passwords** are scrypt hashes, and failures are throttled per account so hammering one name
  cannot lock out the others. Sessions store a SHA-256 of the token, not the token: a stolen
  `laneyard.db` is a list of digests.
- **Roles are enforced by the server, not the interface.** One table names the admin-only routes and
  one hook reads it. What a builder is not shown is also what a builder is refused.
- **Secrets are encrypted at rest** with AES-256-GCM, under a key in `~/.laneyard/key` — outside the
  database, mode `600`, and Laneyard refuses to start if anyone else can read it. No route ever sends
  a value back, which is why the Secrets tab has no reveal button.
- **A signing block is on disk only while a run needs it**, in `~/.laneyard/runs/<run id>/secrets/`
  (mode `600` in a `700` directory), removed when the run ends. Its secret fields are stripped from
  output like any masked secret.
- **Masked values are removed from output as it is written**, not when displayed — so the log file,
  the live stream and the stored error summary all hold `••••••`, even across two chunks of output.
- **Do not put secrets in `config.yml`.** It is a plain file with ordinary permissions.

What this does *not* cover:

- **Git credentials are not in the vault.** `git_auth` points at an SSH key on disk by path; token
  authentication is refused at load. Laneyard strips the repository URL from its own git errors, but
  that is one string, not a vault.
- **A value shorter than four characters is refused, not protected** — removing it from a log would
  shred the output while hiding nothing. Store it unmasked if it does not matter.
- **Anything fastlane prints that is not a stored secret is kept in the clear**, under
  `~/.laneyard/logs/`.
- **`key.properties` is written into the workspace and holds passwords.** It is the one credential
  put in the clone rather than the run's own directory, because Gradle resolves that path relative to
  the build. Mode `600`, marked on its first line, removed when the run ends and swept for at the
  start of the next. A file of yours without that marker is never touched.
