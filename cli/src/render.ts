import type { Check, Mark, Report, Status } from "../../packages/core/dist/verify/doctor.js";

// ---------------------------------------------------------------------------
// Terminal rendering of a Report. Colour only on a TTY, and never when
// NO_COLOR is set; commands are never wrapped so they paste cleanly.
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

const MARKS: Record<Mark, string> = {
  pass: green("✓"),
  fail: red("✗"),
  warn: yellow("!"),
  unknown: dim("?"),
};

const STATUS: Record<Status, string> = {
  verified: green("✓ verified"),
  "verified-older-build": yellow("! verified, but for an older build"),
  "not-verified": red("✗ not verified"),
  "never-submitted": red("✗ never submitted for verification"),
  unreadable: red("✗ can't read this program"),
};

const WIDTH = Math.min(process.stdout.columns || 100, 100);

function wrap(text: string, indent: number): string {
  const room = Math.max(WIDTH - indent, 40);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > room) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  const pad = " ".repeat(indent);
  return lines.map((l) => pad + l).join("\n");
}

const addr = (s: string): string => `${s.slice(0, 4)}…${s.slice(-4)}`;
const kb = (n: number): string => `${Math.round(n / 1024).toLocaleString("en-US")} KB`;

export function render(r: Report): string {
  const out: string[] = [];
  const host = (() => {
    try {
      return new URL(r.rpcUrl).host;
    } catch {
      return r.rpcUrl;
    }
  })();
  out.push("", `  ${bold(r.programId)}`, dim(`  ${r.cluster === "mainnet" ? "mainnet" : "not mainnet"} · via ${host}`), "");

  const p = r.program;
  if (p) {
    const when = p.deployedAt ? ` · ${p.deployedAt.slice(0, 10)}` : "";
    out.push(`  ${dim("program")}   deployed at slot ${p.deploySlot.toLocaleString("en-US")}${when}`);
    const auth = p.authority ? `authority ${addr(p.authority)}` : "immutable";
    out.push(`            ${auth} · ${kb(p.sizeBytes)} · hash ${p.hash.slice(0, 12)}…`);
  }
  out.push(`  ${dim("status")}    ${STATUS[r.status]}`, "");

  if (r.status !== "verified") {
    r.uploads.forEach((u, i) => {
      const who =
        u.signerRole === "authority" ? "upgrade authority" : u.signerRole === "ottersec" ? "OtterSec" : "not the upgrade authority";
      const tag = r.uploads.length > 1 && i === r.primary ? dim("  ← diagnosed below") : "";
      out.push(`  ${bold(`upload ${i + 1} of ${r.uploads.length}`)} · by ${addr(u.upload.signer)} (${who})${tag}`);
      const commit = u.upload.commit ? ` @ ${u.upload.commit.slice(0, 7)}` : "";
      const cli = u.upload.cliVersion ? ` · solana-verify ${u.upload.cliVersion}` : "";
      out.push(`    ${dim("recipe")}    ${u.upload.gitUrl || "(no url)"}${commit}${cli}`);
      if (u.upload.args.length) out.push(`              ${dim("args")} ${u.upload.args.join(" ")}`);
      for (const c of u.checks) out.push(checkLine(c));
      out.push("");
    });
  }

  if (r.diagnosis) out.push(`  ${bold("diagnosis")}`, wrap(r.diagnosis, 4), "");

  if (r.fixes.length) {
    out.push(`  ${bold("fix")}`);
    r.fixes.forEach((f, i) => {
      const n = `${i + 1}.`;
      if (f.text) out.push(wrap(f.text, 7).replace(/^ {7}/, `    ${n.padEnd(3)}`));
      if (f.command) out.push(`${f.text ? "       " : `    ${n.padEnd(3)}`}${green("$")} ${f.command}`);
    });
    out.push("");
  }

  for (const note of r.notes) out.push(`  ${dim("note")}`, wrap(note, 4), "");
  return out.join("\n");
}

function checkLine(c: Check): string {
  return `    ${MARKS[c.mark]} ${c.id.padEnd(8)}${c.label}`;
}
