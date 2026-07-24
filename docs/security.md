# Security


Read this before putting Laneyard on a network.

- **It is built for a local network, not the internet.** It listens on `0.0.0.0` so you can reach
  it from your laptop, behind a password. Do not expose it publicly. If you need remote access,
  put it behind a VPN or an SSH tunnel.
- **Passwords** are stored as scrypt hashes and repeated failures are throttled, per account, so
  hammering one name cannot lock out the others. Sessions survive a restart, and what is stored is
  a SHA-256 of the token rather than the token: a stolen `laneyard.db` is a list of digests, not a
  ring of working keys.
- **A role is enforced by the server, not by the interface.** One table names the routes that
  require an admin, and one hook is the only thing that reads it — there is no permission check
  hidden inside a handler. What a builder is not shown is also what a builder is refused.
- **Secrets are encrypted at rest.** Values are stored with AES-256-GCM under a key in
  `~/.laneyard/key` — outside the database, mode `600`, and Laneyard refuses to start if anyone else
  can read it. Someone who walks off with `laneyard.db` gets ciphertext. Nothing else holds
  plaintext: the store, API and interface deal in names only, and no route sends a value back — which
  is why the Secrets tab has no reveal button.
- **A signing block is on disk only while a run needs it.** The file is written into
  `~/.laneyard/runs/<run id>/secrets/`, mode `600` in a `700` directory, and that directory goes when
  the run ends. The block's secret fields — the keystore passphrases — are stripped from output like
  any masked secret, because gradle will echo one back on failure.
- **Masked values are removed from output before it is written, not when displayed.** The
  substitution happens once, where a run's output fans out, so the log file, the live stream and the
  stored error summary all hold `••••••`. It survives being split across two chunks of output.
- **Do not put secrets in `config.yml`.** It is a plain file with ordinary permissions. Use the
  Secrets tab, which puts them in the encrypted vault instead.

What this does *not* cover, stated plainly:

- **Git credentials are not in the vault.** `git_auth` points at an SSH key on disk by path;
  token authentication is refused at load time rather than silently ignored, so a project cannot
  be configured for something that never happens. Laneyard removes the configured repository URL
  from its own git error messages — so a token embedded in an HTTPS URL does not leak that way —
  but that is one string, not a vault.
- **A value shorter than four characters is refused, not protected.** Removing a two-character
  string from a log would shred the output while hiding nothing, so Laneyard says no rather than
  pretending. Store it unmasked if it genuinely does not matter.
- **Anything fastlane prints that is not a stored secret is stored in the clear**, under
  `~/.laneyard/logs/`.
- **`key.properties` is written into the workspace, and it holds passwords.** It is the one
  credential Laneyard puts in the clone rather than the run's own directory, because Gradle resolves
  that path relative to the build. Mode `600`, a marker as its first line, removed when the run ends
  and swept for at the start of the next in case a server was killed mid-build. A file of yours
  without that marker is never touched.

