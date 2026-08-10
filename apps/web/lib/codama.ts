import type { AnchorIdl, IdlField, IdlTypeDef } from "@/lib/api";

// ---------------------------------------------------------------------------
// Codama → viewer adapter.
//
// Two IDL dialects reach this page. Anchor puts the program surface at the root
// of the document; Codama (what Anchor ≥1.0 and the Pinocchio toolchain emit)
// nests it under `program` and describes every type as a node object rather
// than a string. Read raw, a Codama IDL renders as an empty viewer titled
// "Anchor IDL v1.0.0" — the version being Codama's spec version, not the
// program's.
//
// Rather than teach the viewer a second dialect, translate Codama into the
// shape it already renders. The translation is lossy on purpose: it keeps what
// the interface tab shows (names, fields, types, accounts, args, errors) and
// drops what it doesn't (discriminator nodes, PDA seed graphs, value defaults).
// ---------------------------------------------------------------------------

export type IdlDialect = "anchor" | "codama";

interface Node {
  kind?: string;
  name?: string;
  [key: string]: unknown;
}

const isObj = (v: unknown): v is Node =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Node[] => (Array.isArray(v) ? (v as Node[]) : []);

export function idlDialect(idl: unknown): IdlDialect {
  if (!isObj(idl)) return "anchor";
  const program = idl.program;
  if (idl.standard === "codama" || idl.kind === "rootNode") return "codama";
  if (isObj(program) && (Array.isArray(program.instructions) || Array.isArray(program.accounts)))
    return "codama";
  return "anchor";
}

/** Render a Codama type node as the short type string the viewer prints. */
function typeName(t: unknown): string {
  if (!isObj(t)) return "?";
  switch (t.kind) {
    case "numberTypeNode":
      return String(t.format ?? "number");
    case "publicKeyTypeNode":
      return "pubkey";
    case "booleanTypeNode":
      return "bool";
    case "bytesTypeNode":
      return "bytes";
    case "stringTypeNode":
      return "string";
    case "definedTypeLinkNode":
      return String(t.name ?? "defined");
    case "optionTypeNode":
    case "zeroableOptionTypeNode":
      return `Option<${typeName(t.item)}>`;
    case "arrayTypeNode": {
      const count = isObj(t.count) ? t.count.value : undefined;
      return count === undefined ? `Vec<${typeName(t.item)}>` : `[${typeName(t.item)}; ${count}]`;
    }
    case "fixedSizeTypeNode":
      // a width wrapper around another node — the inner type is what reads
      return typeName(t.type);
    case "sizePrefixTypeNode":
      return typeName(t.type);
    case "structTypeNode":
      return "struct";
    case "enumTypeNode":
      return "enum";
    default:
      return typeof t.kind === "string" ? t.kind.replace(/TypeNode$/, "") : "?";
  }
}

function fields(node: unknown): IdlField[] {
  return arr(isObj(node) ? node.fields : null).map((f) => ({
    name: f.name,
    type: typeName(f.type),
    docs: Array.isArray(f.docs) ? (f.docs as string[]) : undefined,
  }));
}

/** structTypeNode / enumTypeNode → the viewer's {kind, fields, variants}. */
function typeDef(name: string | undefined, node: unknown, docs?: unknown): IdlTypeDef {
  const t = isObj(node) ? node : {};
  if (t.kind === "enumTypeNode") {
    return {
      name,
      docs: Array.isArray(docs) ? (docs as string[]) : undefined,
      type: { kind: "enum", variants: arr(t.variants).map((v) => ({ name: v.name })) },
    };
  }
  return {
    name,
    docs: Array.isArray(docs) ? (docs as string[]) : undefined,
    type: { kind: "struct", fields: fields(t) },
  };
}

/** Translate a Codama root node into the Anchor-ish document the viewer reads.
 *  Returns the input untouched when it is not Codama. */
export function adaptIdl(idl: unknown): AnchorIdl {
  if (idlDialect(idl) !== "codama") return (idl ?? {}) as AnchorIdl;
  const root = idl as Node;
  const p = isObj(root.program) ? root.program : {};

  return {
    address: typeof p.publicKey === "string" ? p.publicKey : undefined,
    metadata: {
      name: typeof p.name === "string" ? p.name : undefined,
      // the program's own version, NOT root.version (that is Codama's spec)
      version: typeof p.version === "string" ? p.version : undefined,
      // the Codama spec version; the dialect itself is named by its own chip
      spec: typeof root.version === "string" ? root.version : undefined,
    },
    instructions: arr(p.instructions).map((ix) => ({
      name: ix.name,
      docs: Array.isArray(ix.docs) ? (ix.docs as string[]) : undefined,
      accounts: arr(ix.accounts).map((a) => ({
        name: a.name,
        signer: a.isSigner === true || a.isSigner === "either",
        writable: a.isWritable === true,
        optional: a.isOptional === true,
        docs: Array.isArray(a.docs) ? (a.docs as string[]) : undefined,
      })),
      args: arr(ix.arguments).map((a) => ({
        name: a.name,
        type: typeName(a.type),
        docs: Array.isArray(a.docs) ? (a.docs as string[]) : undefined,
      })),
    })),
    // an account's shape lives under `data`, a defined type's under `type`
    accounts: arr(p.accounts).map((a) => typeDef(a.name, a.data, a.docs)),
    types: arr(p.definedTypes).map((t) => typeDef(t.name, t.type, t.docs)),
    events: arr(p.events).map((e) => ({
      name: typeof e.name === "string" ? e.name : undefined,
      fields: fields(e.data ?? e.type),
    })),
    errors: arr(p.errors).map((e) => ({
      code: typeof e.code === "number" ? e.code : undefined,
      name: e.name,
      msg: typeof e.message === "string" ? e.message : undefined,
    })),
  };
}
