import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Renders the small markdown subset Ash's published writing uses (content/*.md):
 * ## and ### headings, paragraphs, > quotes, - lists (an indented line continues
 * the item), ![alt](src WxH) images, and inline **bold**, `code` and [links](…).
 * Our own files only, rendered to elements — never raw HTML — so no dependency
 * and nothing to sanitise.
 */

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  // code first so its contents are never read as bold or links
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] != null) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] != null) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else {
      const [label, href] = [m[3]!, m[4]!];
      out.push(
        href.startsWith("/") ? (
          <Link key={k} href={href}>
            {inline(label, k)}
          </Link>
        ) : (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {inline(label, k)}
          </a>
        ),
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** inline content with hard line breaks kept */
function lines(text: string, key: string): ReactNode[] {
  return text.split("\n").flatMap((l, i) => (i ? [<br key={`${key}-br${i}`} />, ...inline(l, `${key}-${i}`)] : inline(l, `${key}-${i}`)));
}

export function Markdown({ source }: { source: string }) {
  const blocks = source.trim().split(/\n\s*\n/);
  const out: ReactNode[] = [];
  // a list may be split by blank lines in the source; merge consecutive ones
  let list: string[] | null = null;
  const flushList = (k: string) => {
    if (!list) return;
    out.push(
      <ul key={k}>
        {list.map((item, i) => (
          <li key={i}>{lines(item, `${k}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = null;
  };

  blocks.forEach((raw, b) => {
    const block = raw.trimEnd();
    const k = `b${b}`;
    if (block.startsWith("- ")) {
      const items = block
        .split(/\n(?=- )/)
        .map((it) => it.replace(/^- /, "").replace(/\n\s+/g, "\n"));
      list = [...(list ?? []), ...items];
      return;
    }
    flushList(`${k}-ul`);
    let m: RegExpMatchArray | null;
    if ((m = block.match(/^(#{2,3}) (.+)$/))) {
      const text = m[2]!;
      out.push(
        m[1] === "##" ? (
          <h2 key={k} id={slug(text)}>{inline(text, k)}</h2>
        ) : (
          <h3 key={k} id={slug(text)}>{inline(text, k)}</h3>
        ),
      );
    } else if ((m = block.match(/^!\[([^\]]*)\]\((\S+)(?: (\d+)x(\d+))?\)$/))) {
      out.push(
        <figure key={k}>
          <img src={m[2]} alt={m[1]} width={m[3]} height={m[4]} loading="lazy" decoding="async" />
        </figure>,
      );
    } else if (block.startsWith(">")) {
      const paras = block
        .split("\n")
        .map((l) => l.replace(/^>\s?/, ""))
        .join("\n")
        .split(/\n\s*\n/);
      out.push(
        <blockquote key={k}>
          {paras.map((p, i) => (
            <p key={i}>{lines(p, `${k}-${i}`)}</p>
          ))}
        </blockquote>,
      );
    } else {
      out.push(<p key={k}>{lines(block, k)}</p>);
    }
  });
  flushList("end-ul");
  return <>{out}</>;
}
