/** A chunk the retrieval returned, with the id dockit issued for it in the prompt. */
export interface RetrievedSource {
  id: string;
  docId: string;
  ordinal: number;
  pageStart: number;
  pageEnd: number;
  text: string;
}

export interface CitedSource {
  id: string;
  ordinal: number;
  pageStart: number;
  pageEnd: number;
}

/** Only the exact form [S<digits>] counts. Known ids map to retrieved-chunk metadata; unknown ids are dropped and counted. */
export function parseCitations(
  answer: string,
  retrieved: readonly RetrievedSource[],
): { cited: CitedSource[]; unknownCitations: number } {
  const byId = new Map(retrieved.map((r) => [r.id, r]));
  const cited: CitedSource[] = [];
  const seen = new Set<string>();
  const unknown = new Set<string>();
  for (const m of answer.matchAll(/\[S(\d+)\]/gu)) {
    const id = `S${m[1]}`;
    const src = byId.get(id);
    if (src === undefined) {
      unknown.add(id);
    } else if (!seen.has(id)) {
      seen.add(id);
      cited.push({ id, ordinal: src.ordinal, pageStart: src.pageStart, pageEnd: src.pageEnd });
    }
  }
  return { cited, unknownCitations: unknown.size };
}

export interface SourceRow {
  id: string;
  /** '2' or '2 to 3', from the chunk's own metadata. */
  pages: string;
  cited: boolean;
  /** The chunk text itself, never text taken from the answer. */
  text: string;
}

export function buildSourcesPanel(
  retrieved: readonly RetrievedSource[],
  citedIds: ReadonlySet<string>,
): SourceRow[] {
  return retrieved.map((r) => ({
    id: r.id,
    pages: r.pageStart === r.pageEnd ? String(r.pageStart) : `${r.pageStart} to ${r.pageEnd}`,
    cited: citedIds.has(r.id),
    text: r.text,
  }));
}
