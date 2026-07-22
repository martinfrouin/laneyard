import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { Readiness as ReadinessReport, ReadinessSection } from "../api";
import { checkClass, checkMark } from "../status";

/**
 * What a section is called.
 *
 * "always" rather than "all": it says why those lines are there, which is the
 * question someone reading a section heading actually has.
 */
const SECTION_LABEL: Record<ReadinessSection["platform"], string> = {
  all: "always",
  ios: "ios",
  android: "android",
};

/**
 * How many checks are in each state, across every section that applies.
 *
 * Counted rather than shown as a bar or a ring: the answer someone wants from
 * the top of this screen is "how many of these need me", and a number answers it
 * exactly. A proportion would round two warnings out of eight into a shape.
 */
function tally(report: ReadinessReport | null): Record<string, number> {
  const counts: Record<string, number> = { ok: 0, warn: 0, unknown: 0 };
  for (const section of report?.sections ?? []) {
    for (const check of section.checks) counts[check.state] = (counts[check.state] ?? 0) + 1;
  }
  return counts;
}

/** The wording each figure gets, in the order the eye should meet them. */
const TALLY_LABELS: { state: string; one: string; many: string }[] = [
  { state: "warn", one: "needs a look", many: "need a look" },
  { state: "unknown", one: "could not be told", many: "could not be told" },
  { state: "ok", one: "settled", many: "settled" },
];

/** The time of day is what matters here; the date is noise on a checklist run minutes ago. */
const at = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * What stands between this project and a build that runs while nobody watches.
 *
 * Nothing on this screen changes anything: every line explains, and the user
 * acts. There is no button that edits a Fastfile — a tool that rewrites your
 * lanes to make its own checklist go green is a tool you cannot trust with a
 * Fastfile. Where the fix really is one action, the line leads to the secrets
 * tab rather than growing a second copy of its form.
 *
 * The checks shell out to git and to bundler, so they run when this tab is
 * opened and when refresh is pressed — never on a timer. The time they were run
 * is on screen for the same reason: a stale green tick is worse than a red cross.
 */
export function Readiness() {
  const { slug = "" } = useParams();
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .readiness(slug)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [slug]);

  const counts = tally(report);

  return (
    <>
      <h2 className="section">readiness</h2>
      <p className="dim">
        what stands between this project and a build that runs while nobody watches. nothing here
        blocks a run — every line is a warning you decide what to do about.
      </p>

      <p className="dim">
        {loading ? "running the checks…" : report ? `checked at ${at(report.checkedAt)}` : "not checked yet"}{" "}
        <button onClick={load} disabled={loading} title="run the checks again">
          refresh
        </button>
      </p>

      {error && <p className="status-failed">checklist unavailable — {error}</p>}

      {/* Before the list, because it is what decides whether the list gets read
          at all. A state nobody is in is still shown, dimmed: "0 need a look" is
          the reassurance, and a figure that disappears when it reaches zero is a
          figure you cannot trust when it is absent. */}
      {report && (
        <p className="tally">
          {TALLY_LABELS.map(({ state, one, many }) => {
            const n = counts[state] ?? 0;
            return (
              <span key={state} className={n === 0 ? "none" : undefined}>
                <span className={`mark ${n === 0 ? "" : checkClass(state)}`}>{checkMark(state)}</span>{" "}
                <span className={n === 0 ? undefined : "bright"}>{n}</span>{" "}
                <span className="dim">{n === 1 ? one : many}</span>
              </span>
            );
          })}
        </p>
      )}

      {/* A section only appears when it applies, so an Android project is
          never told off for having no App Store Connect key. The heading is the
          same small-caps rule the rest of the interface uses — a card here
          would make one group look more important than another. */}
      {(report?.sections ?? []).map((section) => (
        <Fragment key={section.platform}>
          <h2 className="section" style={{ marginTop: 20 }}>
            {SECTION_LABEL[section.platform]}
          </h2>
          <ul className="rows checks">
            {section.checks.map((check) => (
              <li key={check.id} className={`check-${check.state}`}>
                <span className={`mark ${checkClass(check.state)}`}>{checkMark(check.state)}</span>
                <span className="grow">
                  <span className="bright check-title">{check.title}</span>{" "}
                  <span className="dim">{check.detail}</span>
                  {/* The fix is a sentence on its own line, not a control: most
                      of these are fixed by editing a Fastfile, and a button
                      would be claiming Laneyard can do that for you. */}
                  {check.fix && (
                    <div className="dim">
                      {check.fix}
                      {check.fixIn && (
                        <>
                          {" "}
                          <Link to={`/p/${slug}/${check.fixIn}`} className="accent">
                            {check.fixIn} →
                          </Link>
                        </>
                      )}
                    </div>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </>
  );
}
