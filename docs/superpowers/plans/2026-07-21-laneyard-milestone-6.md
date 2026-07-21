# Laneyard — Milestone 6: platforms, credentials as files, and removing a project

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop asking an Android project for an Apple key, let a credential be uploaded as the file it already is, and let a project be removed without editing YAML by hand.

**Architecture:** Platforms become an explicit, editable part of a project's configuration, inferred at setup rather than re-guessed on every check. The readiness checklist splits into a shared section and one per platform. A credential file is uploaded and stored in the existing vault, unchanged.

**Tech Stack:** No new dependency — Fastify parses `multipart/form-data` through `@fastify/multipart`, or the file is read in the browser and sent as text. Prefer the second: it is one fewer dependency and the vault stores text anyway.

---

### Task 1: Platforms are configuration, not a guess

**Files:**
- Modify: `src/config/schema.ts`, `src/cli/detect.ts`, `src/cli/setup.ts`
- Create: `src/heuristics/platforms.ts`, `tests/heuristics/platforms.test.ts`

`projectSettingsSchema` gains `platforms: z.array(z.enum(["ios", "android"])).optional()`. It belongs
with the build settings, so it lives in the repository's `laneyard.yml` and is committed like the
rest.

`src/heuristics/platforms.ts` decides which platforms apply, in this order:

1. What the configuration says, if it says anything.
2. What the repository contains — an Xcode project means iOS, a Gradle build means Android.
3. Neither: an empty list, which the checklist reports as such rather than assuming.

`detectProject` already distinguishes the two; move that reasoning here so setup and the checklist
cannot disagree, and have setup write what it found into `laneyard.yml`. A value that was inferred
once and written down can be corrected; one re-inferred on every check cannot.

- [ ] Steps: failing tests, watch fail, implement, watch pass, commit.

Cases worth testing: configuration wins over detection; detection finds iOS, Android, both, and
neither; a project with both an Xcode project and a Gradle build reports both.

---

### Task 2: A checklist that knows what it is looking at

**Files:**
- Modify: `src/heuristics/readiness.ts`, `src/server/routes/readiness.ts`, `tests/heuristics/readiness.test.ts`
- Modify: `web/src/pages/Readiness.tsx`

Today every project gets the same five checks, so an Android project is told off for having no App
Store Connect key. That is worse than unhelpful: one irrelevant warning teaches someone to ignore
the whole screen.

Three groups:

- **Always** — repository reachable, dependencies installable, no action known to stop and ask.
- **iOS**, only when iOS applies — App Store Connect authentication; `match` usable without
  intervention.
- **Android**, only when Android applies — a keystore reachable without a prompt (a lane calling
  `gradle` with `storeFile`/`storePassword` needs those, and a password not in the vault means a
  prompt), and a Play Store service account credential in the vault if a lane uploads
  (`upload_to_play_store`, `supply`).

The Android checks follow the same rules as the iOS ones: they read **literal arguments only**, and
say so when they cannot tell. Extend the `BLOCKING_RULES` table rather than writing new branches.

The response becomes `{ checkedAt, sections: [{ platform: "all" | "ios" | "android", checks: [...] }] }`.
A project with no platform shows the shared section plus one line saying none was detected and how
to set it in `laneyard.yml`.

In the interface, a section is a small heading in the existing grammar — letter-spaced small caps,
one-pixel rule — not a card.

---

### Task 3: A credential is a file

**Files:**
- Modify: `web/src/pages/Secrets.tsx`, `web/src/api.ts`
- Modify: `README.md`

Pasting the contents of a `.p8` into a text field is absurd when the file is right there, and it is
the moment someone is most likely to paste it somewhere else by accident.

Add a file control beside the value field. The browser reads the file and sends its text to the
existing `PUT` route; the vault is unchanged, the server learns nothing new, and no upload
endpoint or multipart parser is introduced.

Two details:

- **A `.p8` and a service account JSON are both text.** Read as UTF-8, trimmed of a trailing
  newline, and stored as any other secret.
- **The file is never echoed back.** It is read, sent, and the control resets. The page shows the
  file's name only, never its contents — the same rule the rest of the tab already follows.

Name the two credentials the checklist asks for, so someone arrives with the right file:
`APP_STORE_CONNECT_API_KEY_P8` and `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.

---

### Task 4: Removing a project

**Files:**
- Modify: `src/cli/setup.ts` (or a sibling — the YAML editing lives there), `src/server/routes/projects.ts`
- Modify: `web/src/pages/Project.tsx` or a settings tab, `web/src/api.ts`
- Create: `tests/server/remove-project.test.ts`

`DELETE /api/projects/:slug` removes that project's block from `config.yml`, **through the YAML
document** so comments and key order survive — `addProjectToConfig` already does this kind of edit,
follow it.

What it does and does not do, and the interface must say both:

- **Refuses while that project has a run in flight.** The run is using its workspace.
- **The run history stays.** Removing a project from the file has always meant "stop showing it",
  not "destroy its past"; the design says so and `src/db/runs.ts` implements it. Since "delete"
  usually means the opposite, say it.
- **The clone and the artifacts are left on disk**, with their paths shown so they can be removed
  by hand. Deleting files someone may still want, from a web page, on a single click, is not a
  thing to do.

The control asks for confirmation by having the user **type the project's name**. It is the one
destructive action in the product, and a dialogue one can click through is not a confirmation.

---

### Task 5: Say so

README, `CHANGELOG.md`, and the landing page roadmap in `/Users/martin/Projets/laneyard-landing`.

---

## What this milestone does not do

- **Android keystore management.** The checklist reports what it can see; storing a keystore file
  is a larger question than storing its password, since the file belongs in the repository or in
  `match`-like storage, not in a vault row.
- **Deleting a workspace or artifacts from the interface.** Named above, deliberately absent.
