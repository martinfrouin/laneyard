import { useContext } from "react";
import { NavLink } from "react-router-dom";
import { Session } from "../App";

/**
 * One project's tabs, wherever that project is on screen.
 *
 * It lives here rather than inside `Project` because the run screen needs it
 * too, and a run screen is not a tab: its address is `/r/:id`, it is reached by
 * pressing ▶ and it used to be a dead end. Everything a project is — its lanes,
 * its secrets, its checklist — was two clicks away behind a link that looked
 * like a label, and the one thing everybody wants from a failed build is to go
 * back to the lanes and start another. Now the strip is on both, and the run is
 * a page of the project rather than a room with the door closed behind you.
 *
 * `end` on the first tab only: `/p/slug` is a prefix of every other address, so
 * without it "lanes" would be lit up on all of them.
 *
 * A builder is shown the tabs a builder can use. The server refuses the other
 * routes whatever this draws — `permissions.ts` is what actually refuses them —
 * so this is courtesy: a strip of four tabs that answer 403 is worse than three
 * that work.
 */
export function ProjectTabs({ slug }: { slug: string }) {
  const admin = useContext(Session)?.role === "admin";
  const tab = ({ isActive }: { isActive: boolean }): string => (isActive ? "current" : "");

  return (
    <nav className="tabs">
      <NavLink to={`/p/${slug}`} end className={tab}>
        lanes
      </NavLink>
      {/* The Fastfile is readable by anyone with a session — a builder who can
          start a lane benefits from seeing what it does — but this tab also
          saves, commits and pushes it, and those are an admin's. */}
      {admin && (
        <NavLink to={`/p/${slug}/fastfile`} className={tab}>
          fastfile
        </NavLink>
      )}
      {admin && (
        <NavLink to={`/p/${slug}/secrets`} className={tab}>
          secrets
        </NavLink>
      )}
      {/* Beside secrets, because the two are neighbours in the mind of whoever
          is looking for one: values you type there, files you upload here. */}
      {admin && (
        <NavLink to={`/p/${slug}/signing`} className={tab}>
          signing
        </NavLink>
      )}
      <NavLink to={`/p/${slug}/readiness`} className={tab}>
        readiness
      </NavLink>
      {admin && (
        <NavLink to={`/p/${slug}/settings`} className={tab}>
          settings
        </NavLink>
      )}
    </nav>
  );
}
