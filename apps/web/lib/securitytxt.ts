// ---------------------------------------------------------------------------
// security.txt fields, read per the convention rather than printed raw.
// Spec: https://github.com/neodyme-labs/solana-security-txt#format
//
//   contacts  comma-separated `type:value` entries — email:, link:, discord:,
//             telegram:, twitter:, other:
//   auditors  comma-separated names, or a link to where audit reports live
//
// Every value here came out of a deployed binary, so it is attacker-controlled:
// only http(s) URLs ever become links, an email must look like one before it
// becomes a mailto:, and anything unrecognised is shown verbatim as text.
// ---------------------------------------------------------------------------

export type SecTxtPart =
  | { kind: "link"; href: string; text: string; via: string | null }
  | { kind: "text"; text: string; via: string | null };

const HTTP = /^https?:\/\/\S+$/i;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;

/** A URL as a person would read it: percent-escapes decoded, and a deep path
 *  cut to its first two and last two segments — on a repo URL that keeps the
 *  owner/repo and what the link actually points at (…/advisories/new, the
 *  audit's folder and file). */
export function readableUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // malformed escape — keep it as written
  }
  const segs = path.split("/").filter(Boolean);
  const shown = segs.length > 5 ? [...segs.slice(0, 2), "…", ...segs.slice(-2)] : segs;
  return [url.hostname, ...shown].join("/");
}

function linkOrText(value: string, via: string | null): SecTxtPart {
  return HTTP.test(value)
    ? { kind: "link", href: value, text: readableUrl(value), via }
    : { kind: "text", text: value, via };
}

function split(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseContacts(raw: string): SecTxtPart[] {
  return split(raw).map((entry): SecTxtPart => {
    const m = entry.match(/^(email|link|discord|telegram|twitter|other):\s*(.+)$/i);
    if (!m) return linkOrText(entry, null);
    const type = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    switch (type) {
      case "email":
        return EMAIL.test(value)
          ? { kind: "link", href: `mailto:${value}`, text: value, via: "email" }
          : { kind: "text", text: value, via: "email" };
      case "twitter": {
        const h = value.match(HANDLE);
        if (h) return { kind: "link", href: `https://x.com/${h[1]}`, text: `@${h[1]}`, via: "x" };
        return linkOrText(value, "x");
      }
      case "discord":
      case "telegram":
        return linkOrText(value, type);
      default: // link:, other:
        return linkOrText(value, null);
    }
  });
}

export function parseAuditors(raw: string): SecTxtPart[] {
  return split(raw).map((entry) => linkOrText(entry, null));
}
