import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { CredentialSummary } from "../api";
import { CredentialCard } from "../components/CredentialCard";
import { CREDENTIAL_KINDS } from "../../../src/credentials/kinds";
import type { CredentialKind, Platform } from "../../../src/credentials/kinds";

/** Fixed, so the two groups keep their order whatever the table is written in. */
const PLATFORMS: Platform[] = ["ios", "android"];

/**
 * The files a lane needs to sign or upload a build.
 *
 * Its own tab because it is its own activity. Beside the vault it read as a
 * fourth zone of the same screen — values you type and files you upload,
 * scrolled together — and the two have nothing in common but the word secret.
 *
 * Every kind is offered whether or not this project has any use for it, and the
 * screen must read the same either way. fastlane is not only for shipping:
 * lanes take screenshots, run tests, sync certificates, and a project that signs
 * nothing should find three quiet closed lines here rather than three things it
 * is failing to have. So nothing counts what is missing, nothing is coloured for
 * being absent, and the resting state of this tab is an offer.
 */
export function Signing() {
  const { slug = "" } = useParams();
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .listCredentials(slug)
      .then((c) => {
        setCredentials(c);
        setListError(null);
      })
      .catch((e: Error) => setListError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [slug]);

  /**
   * Where this project's build reads its signing properties file, read from the
   * clone. It pre-fills the keystore's path field and flags a stored one that
   * disagrees — the field whose wrong value produces an artifact signed with the
   * debug key and no error anywhere. Its failure is silent on purpose: a project
   * with no android build, or one never cloned, simply has no hint to offer.
   */
  const [propertiesPath, setPropertiesPath] = useState<string | null>(null);
  useEffect(() => {
    api
      .signingHints(slug)
      .then((h) => setPropertiesPath(h.propertiesPath))
      .catch(() => setPropertiesPath(null));
  }, [slug]);

  /**
   * Which blocks are open, which is a fact about this screen and about nothing
   * else. Not stored, not sent anywhere, and gone when the page is: what
   * someone opened to read is not a setting of their project.
   */
  const [opened, setOpened] = useState<CredentialKind[]>([]);
  const toggleBlock = (kind: CredentialKind) =>
    setOpened((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

  return (
    <>
      {/* No preamble. The two groups, their names and each card's own fields
          say what this screen is; two paragraphs of it above were read once by
          nobody. What each block exports is on the card that exports it. */}
      <h2 className="section">signing</h2>

      {listError && <p className="status-failed">unreadable signing blocks — {listError}</p>}
      {loading && <p className="dim">reading vault…</p>}

      {PLATFORMS.map((platform) => (
        <div key={platform} className="credentials-group">
          {/* The platform is a label on a group, not a question anybody is
              asked: both groups are here whatever this project builds, and an
              android-only project reads one short list instead of skipping
              past an apple block on its way down. */}
          <p className="dim platform">{platform}</p>
          <ul className="rows credentials">
            {CREDENTIAL_KINDS.filter((spec) => spec.platform === platform).map((spec) => (
              <CredentialCard
                key={spec.kind}
                slug={slug}
                spec={spec}
                stored={credentials.find((c) => c.kind === spec.kind)}
                propertiesPath={propertiesPath}
                open={opened.includes(spec.kind)}
                onToggle={() => toggleBlock(spec.kind)}
                onChanged={load}
                onError={setError}
              />
            ))}
          </ul>
        </div>
      ))}

      {error && <p className="status-failed">refused — {error}</p>}
    </>
  );
}
