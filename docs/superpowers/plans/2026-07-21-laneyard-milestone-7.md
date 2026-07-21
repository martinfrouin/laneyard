# Laneyard — Milestone 7: accounts and roles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several people share one Laneyard. Some can start builds and watch them; some can also change what a build does, read the vault and manage accounts.

**Architecture:** Accounts live in `config.yml`, like every other piece of configuration, with passwords hashed. A session carries a user and a role. Every route declares the role it needs, in one table, so the answer to "who can do what" is a file rather than an archaeology exercise.

**Tech Stack:** No new dependency.

---

## The decision this reverses

The design document says, in *Explicitly out of scope*: **"Multi-user, roles, permissions. A personal tool, one password."** That was the right call for a tool one person runs on one machine, and it is no longer what this is. Reversing it is deliberate; the spec must be updated to say so rather than left contradicting the code.

Two roles, and only two:

- **admin** — everything: accounts, projects, secrets, the Fastfile, removal.
- **builder** — start a build, watch it, cancel it, download what it produced. Nothing that changes what a build *does*, and nothing that reveals a credential.

A third role is easy to add and impossible to remove. Two cover the case that prompted this — someone who ships without being trusted with the signing chain — and two can be held in a reader's head.

---

## The rule that makes this reviewable

**Permission is declared once, per route, in one place**, and enforced by a hook — never by a check scattered through a handler. Anyone auditing this reads one table and knows the answer. A permission expressed as an `if` halfway down a handler is a permission nobody will find when it matters.

The interface hides what a builder cannot use, but hiding is courtesy, not security: **the server refuses regardless**, and there is a test for each refusal.

---

### Task 1: Accounts in the configuration

**Files:**
- Modify: `src/config/schema.ts`, `src/config/load.ts`, `tests/config/load.test.ts`

```yaml
server:
  port: 7890
  users:
    - name: martin
      role: admin
      password_hash: "scrypt$…"
    - name: ci
      role: builder
      password_hash: "scrypt$…"
```

**An existing installation must keep working.** `server.password_hash` without `users` is read as a
single admin named `admin` — the person running 0.2 has one password and no accounts, and an
upgrade that locks them out of their own build server is not an upgrade. Both forms load; the
loader normalises to a list so nothing downstream knows the difference.

Refused at load time, each with a message saying why:

- `users` present **and** `server.password_hash` present — two ways to say the same thing, and no
  obvious winner.
- Two users with the same name.
- `users: []`, or a list with no admin. A server nobody can administer is a locked room.

- [ ] Failing tests, watch fail, implement, watch pass, commit.

---

### Task 2: A session belongs to someone

**Files:**
- Modify: `src/server/auth.ts`, `src/server/app.ts`, `tests/server/auth.test.ts`

`POST /api/login` takes `{ name, password }`. The legacy single-password form — `{ password }`
alone — logs in as `admin` when the configuration came from `server.password_hash`, so an upgraded
install keeps working without anyone editing a file.

`SessionStore` maps a token to `{ name, role }` rather than to nothing. The throttle stays, and
becomes per-name: one account under attack must not lock out everyone else. Failing on an unknown
name must take the same time as failing on a wrong password, or the login form becomes a way to
enumerate accounts.

`GET /api/me` returns `{ name, role }`, so the interface knows what to show without guessing from
a 403.

---

### Task 3: One table of permissions

**Files:**
- Create: `src/server/permissions.ts`, `tests/server/permissions.test.ts`
- Modify: `src/server/app.ts`

```ts
/**
 * What each route needs. The whole answer to "who can do what", in one place.
 *
 * A permission expressed as an `if` inside a handler is a permission nobody
 * finds when it matters — during an audit, or after an incident.
 */
export const REQUIRES_ADMIN: RoutePattern[] = [
  { method: "*", path: "/api/secrets" },
  { method: "*", path: "/api/projects/:slug/secrets" },
  { method: "PUT", path: "/api/projects/:slug/fastfile" },
  { method: "POST", path: "/api/projects/:slug/commit" },
  { method: "POST", path: "/api/projects/:slug/push" },
  { method: "DELETE", path: "/api/projects/:slug" },
  { method: "*", path: "/api/users" },
];
```

Everything else needs only a session. Reading the Fastfile is deliberately **not** admin: a builder
who can start a lane benefits from seeing what it does, and it contains no credential — anything
that does is in the vault.

Enforced in one `onRequest` hook, after the session check. **Add a test per admin-only route
proving a builder gets 403**, and one proving a builder can still trigger, watch and cancel a run.
Those tests are the real deliverable of this task.

---

### Task 4: Managing accounts

**Files:**
- Create: `src/server/routes/users.ts`, `src/cli/user.ts`, `tests/server/users.test.ts`
- Modify: `src/main.ts`

```
GET    /api/users            → [{ name, role }] — never a hash
POST   /api/users            → { name, role, password }
DELETE /api/users/:name
```

And `laneyard user add <name> --role builder`, reading the password from standard input, as
`laneyard secret set` already does — a password typed as an argument lands in shell history.

Two refusals, both because the alternative is a locked room:

- Removing the last admin.
- Demoting the last admin.

`laneyard setup` on a fresh machine creates the first admin instead of printing a bare password,
and asks for its name.

---

### Task 5: The interface knows who you are

**Files:**
- Modify: `web/src/App.tsx`, `web/src/components/Login.tsx`, `web/src/api.ts`
- Create: `web/src/pages/Users.tsx`

- Login takes a name and a password.
- The status bar shows who is signed in, with `sign out`.
- A builder does not see the Secrets tab, the Fastfile tab, the Settings tab, or the accounts
  screen. They see projects, lanes, runs, logs, artifacts, and the readiness checklist.
- An accounts screen for admins, in the same grammar: one status line per account — role marker,
  name, right-aligned role.

Hiding is courtesy. The server refuses anyway, and Task 3's tests prove it.

---

### Task 6: Say so

- The **design document** must stop saying multi-user is out of scope, and say what replaced it.
  A specification that contradicts the code is worse than none.
- README: a section on accounts and what each role may do, and the upgrade note — an existing
  `password_hash` keeps working as a single admin.
- `CHANGELOG.md`, and the landing page roadmap.

---

## What this milestone does not do

- **Per-project permissions.** "Alice can build this project but not that one" needs a check on
  every route against a project, and an interface that hides what is not permitted. Worth doing
  when someone asks with a real case, not before.
- **Anything resembling SSO.** This is a tool on a local network with a handful of accounts.
- **Password changes by the account's owner.** An admin sets passwords; self-service needs a flow
  for forgetting one, which needs email, which this tool does not have.
