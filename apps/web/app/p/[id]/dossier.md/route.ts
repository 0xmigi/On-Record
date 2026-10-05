import { fetchDossierMarkdown } from "@/lib/api";

/**
 * The dossier as markdown, for AI assistants and answer engines: the same
 * program as /p/<id>, written for a reader that has to repeat it accurately —
 * corpus-relative comparisons, how each fact was derived, and what is not
 * known. Linked from the page as <link rel="alternate" type="text/markdown">.
 *
 * Cached like the page, and refreshed with it when the record changes
 * (app/api/revalidate). Google is pointed at the HTML page as canonical so
 * the two never compete in results.
 */
export const revalidate = 900; // DOSSIER_REVALIDATE — segment config must be a literal
export async function generateStaticParams() {
  return [];
}

const SITE = "https://on-record.azuolas.xyz";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const md = await fetchDossierMarkdown(id);
  if (!md) {
    return new Response("Not on record.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const page = `${SITE}/p/${encodeURIComponent(id)}`;
  return new Response(`Source: ${page}\n\n${md}`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      link: `<${page}>; rel="canonical"`,
    },
  });
}
