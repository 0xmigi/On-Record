import bs58 from "bs58";
import { sql } from "drizzle-orm";
import {
  db,
  schema,
  isOnCurve,
  type ApiProgram,
  type ApiBuilder,
  type ApiBuilderProgram,
  type ApiBuilderRelation,
  type Network,
  type BuilderLabel,
  type BuilderRole,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// A wallet's profile (/b/<address>): every program it shows up in and in what
// role, how it handles control, what its programs publish, and who it acts
// with. Built from the loader record (what every wallet did to every program),
// the subjects (where control sits now and what each program discloses), and
// the multisig_members / funding_trails tables (migration 0011).
//
// The labels describe behaviour on record, not identity, and claim nothing the
// record doesn't show: "secured-team" = holds or sits on a Squads multisig that
// needs 2+ approvals and controls a live program.
// ---------------------------------------------------------------------------

type SubjectRow = typeof schema.subjects.$inferSelect;

/** Programs serialised per profile. A churn wallet can touch hundreds; the
 *  summary still counts all of them. */
const MAX_PROGRAMS = 300;
const RELATED_PER_KIND = 8;
const DAY_MS = 86_400_000;
const HANDOFF = sql`kind in ('set_authority', 'set_authority_checked')`;

interface Involvement {
  program_id: string;
  paid_deploy: boolean;
  deploy_authority: boolean;
  deploy_at: string | Date | null;
  upgrades_signed: number;
  upgrades_paid_by_others: number;
  paid_for_others: number;
  first_handoff_at: string | Date | null;
  /** '' = made immutable */
  handoff_to: string[] | null;
  first_at: string | Date | null;
  last_at: string | Date | null;
}

const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const ms = (v: string | Date | null | undefined): number | null => (v ? new Date(v).getTime() : null);

function kindOf(address: string): "wallet" | "pda" {
  try {
    return isOnCurve(bs58.decode(address)) ? "wallet" : "pda";
  } catch {
    return "pda";
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export async function buildBuilderProfile(
  network: Network,
  address: string,
  serialize: (rows: SubjectRow[]) => Promise<ApiProgram[]>,
): Promise<ApiBuilder | null> {
  // 1. every loader instruction this wallet signed, paid for, or held authority under
  const involvement = (await db.execute(sql`
    select program_id,
      bool_or(kind = 'deploy' and fee_payer = ${address}) as paid_deploy,
      bool_or(kind = 'deploy' and authority_after = ${address}) as deploy_authority,
      min(block_time) filter (where kind = 'deploy') as deploy_at,
      count(*) filter (where kind = 'upgrade' and authority_before = ${address})::int as upgrades_signed,
      count(*) filter (where kind = 'upgrade' and authority_before = ${address} and fee_payer <> ${address})::int as upgrades_paid_by_others,
      count(*) filter (where kind in ('deploy', 'upgrade') and fee_payer = ${address}
        and coalesce(case when kind = 'deploy' then authority_after else authority_before end, '') <> ${address})::int as paid_for_others,
      min(block_time) filter (where ${HANDOFF} and authority_before = ${address} and authority_after is distinct from ${address}) as first_handoff_at,
      array_agg(coalesce(authority_after, '')) filter (where ${HANDOFF} and authority_before = ${address} and authority_after is distinct from ${address}) as handoff_to,
      min(block_time) as first_at, max(block_time) as last_at
    from loader_txns
    where network = ${network} and not failed
      and (fee_payer = ${address} or authority_after = ${address} or authority_before = ${address})
    group by program_id
  `)) as unknown as Involvement[];
  const byProgram = new Map(involvement.map((r) => [r.program_id, r]));

  // 2. the multisigs it sits on
  const memberOf = (await db.execute(sql`
    select multisig, threshold, member_count from multisig_members
    where network = ${network} and member = ${address}
  `)) as unknown as { multisig: string; threshold: number | null; member_count: number | null }[];
  const multisigsAsMember = memberOf.map((m) => m.multisig);

  // 3. the programs: everything above, plus what it (or a multisig it sits on) controls now
  const msList = JSON.stringify(multisigsAsMember);
  const idList = JSON.stringify(involvement.map((r) => r.program_id));
  const subjects: SubjectRow[] = await db
    .select()
    .from(schema.subjects)
    .where(sql`${schema.subjects.network} = ${network} and ${schema.subjects.kind} = 'program' and (
      ${schema.subjects.id} in (select jsonb_array_elements_text(${idList}::jsonb))
      or ${schema.subjects.authority} = ${address}
      or ${schema.subjects.facts}->'multisig'->>'address' = ${address}
      or ${schema.subjects.facts}->'multisig'->>'address' in (select jsonb_array_elements_text(${msList}::jsonb))
    )`);

  const [funded] = (await db.execute(sql`
    select funder, lamports, funded_at, busy from funding_trails where network = ${network} and address = ${address}
  `)) as unknown as { funder: string | null; lamports: string | number | null; funded_at: string | Date | null; busy: boolean }[];

  if (!involvement.length && !subjects.length && !memberOf.length && !funded) return null;

  // newest first, open before closed; every subject is counted, the first
  // MAX_PROGRAMS are serialised
  const when = (s: SubjectRow) => ms(s.lastEventAt ?? s.firstSeenAt) ?? 0;
  const closed = (s: SubjectRow) => ((s.facts ?? {}) as { closedAt?: string }).closedAt != null;
  subjects.sort((a, b) => Number(closed(a)) - Number(closed(b)) || when(b) - when(a));
  const programs = await serialize(subjects);
  const multisigOf = (s: SubjectRow) => ((s.facts ?? {}) as { multisig?: { address?: string } }).multisig?.address ?? null;

  const entries: ApiBuilderProgram[] = subjects.map((s, i) => {
    const inv = byProgram.get(s.id);
    const ms_ = multisigOf(s);
    const roles: BuilderRole[] = [];
    if (inv?.paid_deploy || inv?.deploy_authority) roles.push("deployed");
    if (s.authority === address) roles.push("controls");
    else if (inv?.handoff_to?.length) roles.push("controlled");
    if (inv?.upgrades_signed) roles.push("upgraded");
    if (inv?.paid_for_others) roles.push("paid");
    if (ms_ === address) roles.push("multisig");
    if (ms_ && multisigsAsMember.includes(ms_)) roles.push("member");
    return {
      program: programs[i]!,
      roles,
      upgradesSigned: inv?.upgrades_signed ?? 0,
      firstAt: iso(inv?.first_at),
      lastAt: iso(inv?.last_at),
    };
  });

  // --- summary ---------------------------------------------------------------
  const deployed = entries.filter((e) => e.roles.includes("deployed"));
  const isClosed = (p: ApiProgram) => p.closed || p.closedAt != null;
  const closedWithinDay = deployed.filter((e) => {
    const start = ms(e.program.firstDeployAt ?? e.program.deployedAt);
    const end = ms(e.program.closedAt);
    return start != null && end != null && end - start < DAY_MS;
  }).length;

  let toProgramControlled = 0;
  let toWallet = 0;
  let toNobody = 0;
  const hoursToFirst: number[] = [];
  for (const e of deployed) {
    const inv = byProgram.get(e.program.id);
    const targets = inv?.handoff_to ?? [];
    if (!targets.length) continue;
    if (targets.includes("")) toNobody++;
    else if (targets.some((t) => kindOf(t) === "pda")) toProgramControlled++;
    else toWallet++;
    const a = ms(inv?.deploy_at);
    const b = ms(inv?.first_handoff_at);
    if (a != null && b != null && b >= a) hoursToFirst.push((b - a) / 3_600_000);
  }

  // multisigs: the ones it sits on, and itself if it is one
  const multisigs: ApiBuilder["summary"]["multisigs"] = memberOf.map((m) => ({
    address: m.multisig,
    threshold: m.threshold,
    members: m.member_count,
    programs: subjects.filter((s) => multisigOf(s) === m.multisig && !closed(s)).length,
    isMember: true,
  }));
  // the address is itself a multisig: its setup as read from the account
  // (multisig_members), else as the dossier last recorded it
  const own = (await db.execute(sql`
    select member, threshold, member_count from multisig_members where network = ${network} and multisig = ${address} order by member
  `)) as unknown as { member: string; threshold: number | null; member_count: number | null }[];
  const selfAsMultisig = subjects.filter((s) => multisigOf(s) === address);
  if (selfAsMultisig.length || own.length) {
    const info = ((selfAsMultisig[0]?.facts ?? {}) as { multisig?: { threshold?: number | null; members?: number | null } }).multisig;
    multisigs.push({
      address,
      threshold: own[0]?.threshold ?? info?.threshold ?? null,
      members: own[0]?.member_count ?? info?.members ?? null,
      programs: selfAsMultisig.filter((s) => !closed(s)).length,
      isMember: false,
    });
  }

  const upgradesSigned = involvement.reduce((n, r) => n + r.upgrades_signed, 0);
  const firsts = involvement.map((r) => ms(r.first_at)).filter((x): x is number => x != null);
  const lasts = involvement.map((r) => ms(r.last_at)).filter((x): x is number => x != null);

  // --- disclosure: its live programs ------------------------------------------
  const live = entries.filter(
    (e) => !isClosed(e.program) && e.roles.some((r) => r === "deployed" || r === "controls" || r === "multisig" || r === "member"),
  );
  const count = (f: (p: ApiProgram) => boolean) => live.filter((e) => f(e.program)).length;
  const disclosure = {
    of: live.length,
    named: count((p) => !!p.name),
    securityTxt: count((p) => p.hasSecurityTxt),
    repo: count((p) => !!(p.repoUrl ?? p.repoUrlDeclared)),
    verified: count((p) => p.verified),
    idl: count((p) => p.idlPresent),
    site: count((p) => !!(p.website ?? p.social)),
  };

  // --- labels ----------------------------------------------------------------
  const n = deployed.length;
  const deployedOpen = deployed.filter((e) => !isClosed(e.program)).length;
  const churn = n >= 4 && closedWithinDay / n >= 0.5;
  const labels: BuilderLabel[] = [];
  // only what the record proves: a Squads multisig needing 2+ approvals holds a
  // live program. A handoff to some other program-controlled address is not
  // proof that more than one person controls it.
  const sharedControl = multisigs.some((m) => (m.threshold ?? 0) >= 2 && m.programs > 0);
  if (sharedControl && !churn) labels.push("secured-team");
  if (!churn && n >= 2 && deployedOpen >= 2) labels.push("serial-builder");
  if (!churn && n === 1) labels.push("one-shot");
  if (churn) labels.push("churn");

  // --- who it acts with -------------------------------------------------------
  const related: ApiBuilderRelation[] = [];
  const handedTo = new Map<string, number>();
  for (const r of involvement) for (const t of new Set(r.handoff_to ?? [])) if (t) handedTo.set(t, (handedTo.get(t) ?? 0) + 1);
  const top = (m: Map<string, number>, relation: ApiBuilderRelation["relation"]) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RELATED_PER_KIND)
      .forEach(([a, programs]) => related.push({ address: a, relation, programs }));
  top(handedTo, "handed-control-to");

  const pairs = (await db.execute(sql`
    select 'received-control-from' as relation, authority_before as address, count(distinct program_id)::int as programs
    from loader_txns
    where network = ${network} and not failed and ${HANDOFF} and authority_after = ${address}
      and authority_before is not null and authority_before <> ${address}
    group by 2
    union all
    select 'fees-paid-by', fee_payer, count(distinct program_id)::int
    from loader_txns
    where network = ${network} and not failed and kind in ('deploy', 'upgrade')
      and (case when kind = 'deploy' then authority_after else authority_before end) = ${address} and fee_payer <> ${address}
    group by 2
    union all
    select 'paid-fees-for', case when kind = 'deploy' then authority_after else authority_before end, count(distinct program_id)::int
    from loader_txns
    where network = ${network} and not failed and kind in ('deploy', 'upgrade') and fee_payer = ${address}
      and coalesce(case when kind = 'deploy' then authority_after else authority_before end, '') not in ('', ${address})
    group by 2
  `)) as unknown as { relation: ApiBuilderRelation["relation"]; address: string; programs: number }[];
  for (const relation of ["received-control-from", "fees-paid-by", "paid-fees-for"] as const) {
    top(new Map(pairs.filter((p) => p.relation === relation).map((p) => [p.address, p.programs])), relation);
  }

  if (multisigsAsMember.length) {
    const co = (await db.execute(sql`
      select member as address, count(*)::int as shared from multisig_members
      where network = ${network} and member <> ${address}
        and multisig in (select jsonb_array_elements_text(${msList}::jsonb))
      group by 1 order by 2 desc limit ${RELATED_PER_KIND}
    `)) as unknown as { address: string; shared: number }[];
    for (const c of co) related.push({ address: c.address, relation: "multisig-co-member", programs: 0 });
  }
  for (const m of own) related.push({ address: m.member, relation: "multisig-member", programs: 0 });
  if (funded?.funder) related.push({ address: funded.funder, relation: "funded-by", programs: 0 });
  const fundedOthers = (await db.execute(sql`
    select address from funding_trails where network = ${network} and funder = ${address} order by funded_at desc nulls last limit ${RELATED_PER_KIND}
  `)) as unknown as { address: string }[];
  for (const f of fundedOthers) related.push({ address: f.address, relation: "funded", programs: 0 });

  return {
    address,
    network,
    kind: kindOf(address),
    labels,
    summary: {
      deployed: n,
      deployedOpen,
      deployedClosedWithinDay: closedWithinDay,
      controlsNow: entries.filter((e) => e.roles.includes("controls") && !isClosed(e.program)).length,
      upgradesSigned,
      firstSeenAt: firsts.length ? new Date(Math.min(...firsts)).toISOString() : null,
      lastSeenAt: lasts.length ? new Date(Math.max(...lasts)).toISOString() : null,
      handedOff: {
        programs: toProgramControlled + toWallet + toNobody,
        toProgramControlled,
        toWallet,
        toNobody,
        medianHoursToFirst: median(hoursToFirst),
      },
      multisigs,
      feesPaidByOthers: { upgrades: involvement.reduce((s, r) => s + r.upgrades_paid_by_others, 0), of: upgradesSigned },
      devnetFirst: {
        programs: deployed.filter((e) => e.program.incubation && ["program_id", "sha256"].includes(e.program.incubation.matchedOn)).length,
        of: n,
      },
    },
    disclosure,
    fundedBy: funded
      ? { funder: funded.funder, busy: funded.busy, at: iso(funded.funded_at), sol: funded.lamports != null ? Number(funded.lamports) / 1e9 : null }
      : null,
    programs: entries.slice(0, MAX_PROGRAMS),
    programsTruncated: entries.length > MAX_PROGRAMS,
    related,
  };
}
