"use client";

import { useState } from "react";
import { SectionHeader } from "@/components/SectionHeader";
import { CardFoot, CardHead, HasKey, SplitRows } from "@/components/StatBits";
import { LabeledBar } from "@/components/LabeledBar";

// Openness as one view, the way Lifecycle works: who can change the code, as
// one bar across the top. Pick a kind of authority and Published and Verified
// builds narrow to those programs, so a single key can be read against a
// multisig. Pick it again to go back to all.

type Disc = { total: number; idl: number; securityTxt: number; withRepo?: number; verified: number };
/** one network's openness figures, for the all-networks comparison */
export type OpenNet = {
  authority: Record<string, number>;
  disclosure: Disc;
  byAuthority?: Record<string, Disc>;
  lostVerification?: number;
};

const KINDS = [
  { key: "immutable", label: "immutable", tone: "s4" },
  { key: "multisig", label: "multisig", tone: "s3" },
  { key: "program", label: "program", tone: "s2" },
  { key: "singleKey", label: "single key", tone: "s1" },
  { key: "unread", label: "not read", tone: "rest" },
] as const;

const num = (n: number) => n.toLocaleString("en-US");

export function OpennessView({
  authority,
  authorityInfo,
  disclosure,
  byAuthority,
  publishedInfo,
  verifiedInfo,
  lostVerification,
  lostHref,
  byNet = null,
}: {
  authority: Record<string, number>;
  authorityInfo: string;
  disclosure: Disc;
  byAuthority?: Record<string, Disc>;
  publishedInfo: string;
  verifiedInfo: string;
  lostVerification?: number;
  lostHref?: string;
  /** on all networks: each network's figures, drawn mainnet over devnet */
  byNet?: { mainnet: OpenNet; devnet: OpenNet } | null;
}) {
  const [pick, setPick] = useState<string | null>(null);
  const toggle = (k: string) => setPick((p) => (p === k ? null : k));
  const d: Disc = pick && byAuthority?.[pick] ? byAuthority[pick]! : disclosure;
  const discOf = (n: OpenNet): Disc =>
    pick ? n.byAuthority?.[pick] ?? { total: 0, idl: 0, securityTxt: 0, withRepo: 0, verified: 0 } : n.disclosure;
  const dm = byNet ? discOf(byNet.mainnet) : d;
  const dd = byNet ? discOf(byNet.devnet) : null;
  const partsOf = (a: Record<string, number>) =>
    KINDS.filter((k) => (a[k.key] ?? 0) > 0).map((k) => ({ key: k.key, label: k.label, value: a[k.key] ?? 0, tone: `tone-${k.tone}` }));
  const pickedLabel = pick ? KINDS.find((k) => k.key === pick)?.label : null;

  return (
    <>
      <section className="stat-card stat-span">
        <SectionHeader title="Upgrade authority" info={authorityInfo} />
        <LabeledBar
          parts={byNet ? partsOf(byNet.mainnet.authority) : partsOf(authority)}
          devParts={byNet ? partsOf(byNet.devnet.authority) : null}
          pick={pick}
          onPick={toggle}
          ariaLabel="Upgrade authority: pick one to narrow the section"
        />
      </section>

      <section className="stat-card">
        <CardHead title="Published" info={publishedInfo} aside={<HasKey />} />
        {pickedLabel ? <div className="sub-label">{pickedLabel} only</div> : null}
        <SplitRows
          rows={[
            { label: "IDL", has: dm.idl, total: dm.total, dev: dd ? { has: dd.idl, total: dd.total } : null },
            {
              label: "security.txt",
              has: dm.securityTxt,
              total: dm.total,
              dev: dd ? { has: dd.securityTxt, total: dd.total } : null,
            },
            ...(dm.withRepo != null
              ? [
                  {
                    label: "source repo",
                    has: dm.withRepo,
                    total: dm.total,
                    dev: dd ? { has: dd.withRepo ?? 0, total: dd.total } : null,
                  },
                ]
              : []),
          ]}
        />
      </section>

      <section className="stat-card">
        <CardHead title="Verified builds" info={verifiedInfo} aside={<HasKey />} />
        {pickedLabel ? <div className="sub-label">{pickedLabel} only</div> : null}
        <SplitRows
          rows={[
            {
              label: "verified build",
              has: dm.verified,
              total: dm.total,
              dev: dd ? { has: dd.verified, total: dd.total } : null,
            },
          ]}
        />
        {!pick && lostVerification ? (
          <CardFoot
            label="lost verification"
            value={num(byNet ? byNet.mainnet.lostVerification ?? 0 : lostVerification)}
            devValue={byNet ? num(byNet.devnet.lostVerification ?? 0) : null}
            href={lostHref}
          />
        ) : null}
      </section>
    </>
  );
}
