# Accounts

Everyone who signs in has a name, a password and one of two roles — two, because a third is easy to
add and impossible to remove.

| | **admin** | **builder** |
|---|---|---|
| start a build, watch it, cancel it | ✓ | ✓ |
| download artifacts, read logs and the Fastfile | ✓ | ✓ |
| see the readiness checklist | ✓ | ✓ |
| read and write secrets | ✓ | |
| save, commit and push the Fastfile | ✓ | |
| remove a project | ✓ | |
| manage accounts | ✓ | |

A builder is who you give someone who ships without being trusted with the signing chain: they press
the button and watch, and never see a credential. The interface hides what they cannot use — but that
is courtesy, not security: the server refuses those routes on its own, whatever the browser was shown.

## Which projects a builder reaches

An admin reaches every project; a builder only those granted from the accounts screen. A project it
cannot reach is **invisible** — absent from its lists, and a 404 by URL answered with the body a
nonexistent project gives, so the two cannot be told apart.

The reach is a `projects` list on the account in `config.yml`:

- **absent** — every project, so nobody loses access on an upgrade;
- **`[]`** — none, what a new account starts with;
- **a list of slugs** — exactly those.

Removing a project strips its slug from every account, so a re-created slug inherits no old grant.

## Adding and removing

```bash
echo "$PASSWORD" | laneyard user add lea --role builder
```

The password is read from standard input, never an argument — an argument lands in your shell
history. Without `--role`, the account is a builder. Removing or demoting the last admin is refused:
a server nobody can administer cannot be repaired from the interface.

Anyone changes their own password and name from **your account**, builders included. Both ask for the
current password even though you are signed in — a session is a cookie in a browser that may have
been left open — and doing it ends every other session that account has.

Removing an account ends its sessions immediately, and so does editing `config.yml` by hand: every
request looks the account up again, so a change takes effect at once.
