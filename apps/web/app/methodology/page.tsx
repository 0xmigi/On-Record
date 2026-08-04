import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  CALIBRATION,
  SYSCALL_SOURCE_URL,
  TIER_ORDER,
  measuredByRule,
  type Tier,
} from "@/lib/primitives";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "What decides the order of the On Record feed — the seven things every program is scored on, and what pushes a program down.",
};

const TIER_MEANING: Record<Tier, string> = {
  mythical: "Nothing on mainnet imports it, or it isn't activated yet.",
  legendary: "Under 1% of programs.",
  epic: "1–3% of programs.",
  rare: "3–15% of programs.",
  uncommon: "15–60% of programs.",
  common: "Over 60%, or held here because it never distinguishes a program.",
};

function share(pct: number | null): string {
  if (pct == null) return "—";
  if (pct === 0) return "0";
  return `${pct}%`;
}

/** One scored thing. Closed by default; open it for how it's measured. */
function Part({
  name,
  weight,
  blurb,
  children,
}: {
  name: string;
  weight: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <details className="method-part">
      <summary>
        <span className="method-name">{name}</span>
        <span className="method-desc">{blurb}</span>
        <span className="method-share">{weight}</span>
      </summary>
      <div className="method-part-body">{children}</div>
    </details>
  );
}

export default function MethodologyPage() {
  const groups = measuredByRule();

  return (
    <>
      <h1 className="funnel-title">Methodology</h1>
      <p className="method-sub">What decides the order programs show up in the feed.</p>
      <p className="method-lede">
        Every program is scored on seven things, and the feed shows the highest scores first. Open a
        row to see how that part is measured.
      </p>

      <Part name="disclosure" weight="30%" blurb="How much the program says about who built it">
        <p>Six things, and it scores the fraction it has:</p>
        <ul>
          <li>a recovered name</li>
          <li>a public source repo</li>
          <li>a website or social link</li>
          <li>a published IDL</li>
          <li>a security.txt in the binary</li>
          <li>a verified build</li>
        </ul>
        <p>
          It carries the most weight because it is the sharpest bot filter available — six things a
          sniper never bothers with.
        </p>
      </Part>

      <Part name="novelty" weight="20%" blurb="How unlike anything already on record the code is">
        <p>
          Every new program is compared against everything on record using a fuzzy fingerprint of the
          compiled bytecode, which survives recompiling where a plain hash would not. The distance to
          its closest relative puts it in one of three groups, and the radar shows those as separate
          lists:
        </p>
        <ul>
          <li>
            <strong>novel</strong> — distance 150 or more. Nothing on record looks like it.
          </li>
          <li>
            <strong>variant</strong> — 50 to 149. Loosely similar to something, not a copy.
          </li>
          <li>
            <strong>clone</strong> — under 50. A fork or near-identical redeploy. Scores zero here.
          </li>
        </ul>
        <p>
          The match is not always trustworthy, and the dossier says so when it isn&apos;t — a nearest
          relative found only because the two are a similar size, or one of dozens equally close, is
          flagged rather than presented as fact.
        </p>
      </Part>

      <Part name="primitives" weight="15%" blurb="How rare the syscalls it imports are">
        <p>
          A program scores on its peak tier — the single rarest syscall it imports. Not a sum, so
          twelve ordinary imports never beat one rare one. Legendary is worth +0.09 of the final
          score, epic +0.06, uncommon +0.015; common earns nothing.
        </p>
        {TIER_ORDER.map((tier) => {
          const inTier = groups.filter((g) => g.rule.tier === tier && !g.rule.fallback);
          if (!inTier.length) return null;
          return (
            <div className="method-tier" key={tier}>
              <div className="method-tier-head">
                <span className={`prim-group-tier tier-${tier}`} title={TIER_MEANING[tier]}>
                  {tier}
                </span>
              </div>
              <div className="method-rows">
                {inTier.map(({ rule, syscalls, pct }) => (
                  <div className="method-row" key={rule.label}>
                    <span className="method-name" title={rule.explain}>
                      {rule.label}
                      {rule.floored ? <i className="method-held">held</i> : null}
                    </span>
                    <span className="method-calls">
                      {syscalls.length ? (
                        syscalls.map((s) => s.name).join("  ")
                      ) : (
                        <em>not activated on mainnet — SIMD-0388</em>
                      )}
                    </span>
                    <span className="method-share">{share(pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <p>
          Two rules are <em>held</em> below what their rarity would earn. Memory operations and basic
          logging never distinguish a program whatever their share. And <code>sol_alloc_free_</code>{" "}
          and <code>sol_get_fees_sysvar</code> are as rare as anything legendary but worth nothing —
          rare because deprecated, not because hard.
        </p>
        <p className="method-foot">
          Shares measured over {CALIBRATION.programs.toLocaleString()} {CALIBRATION.network} programs
          on {CALIBRATION.measuredAt}, and they drift as the corpus grows ·{" "}
          <a href={SYSCALL_SOURCE_URL} target="_blank" rel="noopener noreferrer">
            syscall list
          </a>
        </p>
      </Part>

      <Part name="newness" weight="10%" blurb="How recently it deployed">
        <p>
          Decays fast, on purpose: a program keeps about a third of this a day after deploying and
          almost none of it after a week. Fresh deploys surface, then have to earn the place on
          something other than the hour they landed.
        </p>
      </Part>

      <Part name="momentum" weight="10%" blurb="Transactions in the last 24 hours">
        <p>
          Log-scaled and capped at 10,000, so a giant cannot bury an emerging program on traffic
          alone.
        </p>
      </Part>

      <Part name="conviction" weight="10%" blurb="SOL locked as rent by the deploy">
        <p>
          Log-scaled, capped at 100 SOL. A large program costs real money to put on chain and keep
          there — a cost a throwaway deploy does not pay.
        </p>
      </Part>

      <Part name="adoption" weight="5%" blurb="How much of the last 48 hours saw any activity">
        <p>Counted in hourly buckets, so steady use scores and a single spike does not.</p>
      </Part>

      <h2 className="method-h2">What pushes a program down</h2>
      <p className="method-lede">
        Applied after scoring and multiplied together. This is what sinks the churn to the bottom of
        the feed.
      </p>
      <div className="method-rows">
        <div className="method-row">
          <span className="method-name">closed</span>
          <span className="method-desc">
            Rent reclaimed — the program is gone and the deployer took the SOL back.
          </span>
          <span className="method-share">×0.05</span>
        </div>
        <div className="method-row">
          <span className="method-name">byte-clone</span>
          <span className="method-desc">
            Recycled bytecode. Sniper-flavoured clones take ×0.05 instead.
          </span>
          <span className="method-share">×0.20</span>
        </div>
        <div className="method-row">
          <span className="method-name">large family</span>
          <span className="method-desc">
            Near-identical siblings, scaled by how many the family has already closed. A family that
            closes nothing pays nothing however large it is; one that buries its own pays in full.
          </span>
          <span className="method-share">×0.59–0.23</span>
        </div>
      </div>
    </>
  );
}
