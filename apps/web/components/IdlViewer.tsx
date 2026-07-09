"use client";

import { useMemo, useState } from "react";
import type { AnchorIdl, IdlAccountRef, IdlField, IdlTypeDef } from "@/lib/api";

/** Render an Anchor IDL type node (string | {defined} | {vec} | {option} | …). */
function fmtType(t: unknown): string {
  if (t == null) return "?";
  if (typeof t === "string") return t;
  if (typeof t === "object") {
    const o = t as Record<string, unknown>;
    if (o.defined !== undefined) {
      const d = o.defined;
      return typeof d === "string" ? d : ((d as { name?: string })?.name ?? "defined");
    }
    if (o.vec !== undefined) return `Vec<${fmtType(o.vec)}>`;
    if (o.option !== undefined) return `Option<${fmtType(o.option)}>`;
    if (o.coption !== undefined) return `COption<${fmtType(o.coption)}>`;
    if (o.array !== undefined) {
      const [inner, n] = o.array as [unknown, number];
      return `[${fmtType(inner)}; ${n}]`;
    }
  }
  return "?";
}

function FieldList({ fields }: { fields?: IdlField[] }) {
  if (!fields?.length) return <p className="idl-empty">no fields</p>;
  return (
    <ul className="idl-fields">
      {fields.map((f, i) => (
        <li key={i}>
          <span className="idl-field-name">{f.name ?? "_"}</span>
          <span className="idl-field-type">{fmtType(f.type)}</span>
          {f.docs?.length ? <span className="idl-field-doc">{f.docs.join(" ")}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function AccountList({ accounts }: { accounts?: IdlAccountRef[] }) {
  if (!accounts?.length) return null;
  return (
    <div className="idl-accounts">
      <span className="idl-sublabel">Accounts</span>
      <ul className="idl-fields">
        {accounts.map((a, i) => {
          const signer = a.signer ?? a.isSigner;
          const writable = a.writable ?? a.isMut;
          return (
            <li key={i}>
              <span className="idl-field-name">{a.name ?? "_"}</span>
              <span className="idl-acct-flags">
                {signer ? <span className="idl-flag idl-flag-signer">signer</span> : null}
                {writable ? <span className="idl-flag idl-flag-write">writable</span> : null}
                {a.optional ? <span className="idl-flag">optional</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TypeDefItem({ def }: { def: IdlTypeDef }) {
  const kind = def.type?.kind;
  return (
    <details className="idl-item">
      <summary>
        <span className="idl-ix-name">{def.name}</span>
        {kind ? <span className="idl-kind">{kind}</span> : null}
      </summary>
      <div className="idl-item-body">
        {kind === "enum" ? (
          <ul className="idl-fields">
            {(def.type?.variants ?? []).map((v, i) => (
              <li key={i}>
                <span className="idl-field-name">{v.name ?? "_"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <FieldList fields={def.type?.fields} />
        )}
      </div>
    </details>
  );
}

function Section({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  if (!count) return null;
  return (
    <details className="idl-section" open={defaultOpen}>
      <summary>
        {title} <span className="idl-count">{count}</span>
      </summary>
      <div className="idl-section-body">{children}</div>
    </details>
  );
}

export function IdlViewer({ idl }: { idl: AnchorIdl }) {
  const [raw, setRaw] = useState(false);
  const [q, setQ] = useState("");
  const meta = idl.metadata ?? { name: idl.name, version: idl.version };

  const query = q.trim().toLowerCase();
  const match = (name?: string) => !query || (name ?? "").toLowerCase().includes(query);

  const instructions = useMemo(
    () => (idl.instructions ?? []).filter((ix) => match(ix.name)),
    [idl.instructions, query],
  );
  const accounts = (idl.accounts ?? []).filter((a) => match(a.name));
  const types = (idl.types ?? []).filter((t) => match(t.name));
  const events = (idl.events ?? []).filter((e) => match(e.name));
  const errors = (idl.errors ?? []).filter((e) => match(e.name));

  return (
    <div className="idl-viewer">
      <div className="idl-head">
        <div className="idl-title">
          <span className="idl-name">{meta.name ?? "Anchor IDL"}</span>
          {meta.version ? <span className="idl-ver">v{meta.version}</span> : null}
          {meta.spec ? <span className="idl-spec">spec {meta.spec}</span> : null}
        </div>
        <button type="button" className="idl-toggle" onClick={() => setRaw((r) => !r)}>
          {raw ? "Show parsed" : "Show JSON"}
        </button>
      </div>

      {meta.description && meta.description !== "Created with Anchor" ? (
        <p className="idl-desc">{meta.description}</p>
      ) : null}

      {raw ? (
        <pre className="idl-raw">{JSON.stringify(idl, null, 2)}</pre>
      ) : (
        <>
          <input
            className="idl-search"
            placeholder="Search instructions, accounts, types…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          <Section title="Instructions" count={instructions.length} defaultOpen>
            {instructions.map((ix, i) => (
              <details className="idl-item" key={i}>
                <summary>
                  <span className="idl-ix-name">{ix.name}</span>
                  <span className="idl-ix-meta">
                    {ix.accounts?.length ? `${ix.accounts.length} accounts` : ""}
                    {ix.args?.length ? ` · ${ix.args.length} args` : ""}
                  </span>
                </summary>
                <div className="idl-item-body">
                  {ix.docs?.length ? <p className="idl-ix-doc">{ix.docs.join(" ")}</p> : null}
                  <AccountList accounts={ix.accounts} />
                  {ix.args?.length ? (
                    <div className="idl-args">
                      <span className="idl-sublabel">Args</span>
                      <FieldList fields={ix.args} />
                    </div>
                  ) : null}
                </div>
              </details>
            ))}
          </Section>

          <Section title="Accounts" count={accounts.length}>
            {accounts.map((a, i) => (
              <TypeDefItem def={a} key={i} />
            ))}
          </Section>

          <Section title="Types" count={types.length}>
            {types.map((t, i) => (
              <TypeDefItem def={t} key={i} />
            ))}
          </Section>

          <Section title="Events" count={events.length}>
            {events.map((e, i) => (
              <details className="idl-item" key={i}>
                <summary>
                  <span className="idl-ix-name">{e.name}</span>
                </summary>
                <div className="idl-item-body">
                  <FieldList fields={e.fields} />
                </div>
              </details>
            ))}
          </Section>

          <Section title="Errors" count={errors.length}>
            <ul className="idl-errors">
              {errors.map((e, i) => (
                <li key={i}>
                  <span className="idl-err-code">{e.code}</span>
                  <span className="idl-err-name">{e.name}</span>
                  {e.msg ? <span className="idl-err-msg">{e.msg}</span> : null}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
