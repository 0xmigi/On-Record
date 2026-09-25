import type { ApiVerification } from "@/lib/api";

/**
 * The live version's verification, under the mainnet record: what the verify
 * doctor found, and what would fix it. The rows above say verified or not per
 * version; this is the why for the one version anyone can still act on.
 *
 * The commands are for whoever controls the program. Most readers don't, so
 * they sit behind a disclosure, stated plainly rather than as advice.
 */

type Current = NonNullable<ApiVerification["current"]>;

const HEAD: Record<Current["status"], string> = {
  verified: "✓ Current version verified",
  "verified-older-build": "! Verified, but for an older build",
  "not-verified": "✗ Current version not verified",
  "never-submitted": "✗ Never submitted for verification",
  unreadable: "",
};

export function VerifyNote({ current }: { current: Current }) {
  if (current.status === "unreadable" || !current.diagnosis) return null;
  const tone = current.status === "verified" ? "yes" : current.status === "verified-older-build" ? "pending" : "no";
  return (
    <div className="vfy-note">
      <p className="vfy-note-head">
        <span className={`vfy vfy-${tone}`}>{HEAD[current.status]}</span>
        <span className="vfy-note-why">{current.diagnosis}</span>
      </p>
      {current.fixes.length ? (
        <details className="vfy-fix">
          <summary>What would fix it</summary>
          <ol>
            {current.fixes.map((f, i) => (
              <li key={i}>
                {f.text ? <p>{f.text}</p> : null}
                {f.command ? (
                  <pre>
                    <code>{f.command}</code>
                  </pre>
                ) : null}
              </li>
            ))}
          </ol>
          {current.notes.map((n) => (
            <p key={n} className="vfy-note-extra">
              {n}
            </p>
          ))}
          <p className="vfy-note-extra">Checked against the chain, OtterSec&apos;s verifier and GitHub.</p>
        </details>
      ) : null}
    </div>
  );
}
