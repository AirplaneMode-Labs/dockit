/** Every limit of the dockit pipeline in one place (D5-05). All lengths are UTF-16 code units. */

export const MAX_FILE_BYTES = 20_971_520; // 20 MiB, checked before the file is read
export const MAX_PAGES = 300;
export const PAGE_UNITS_MAX = 200_000;
export const DOC_UNITS_MAX = 2_000_000;
export const PDF_TIMEOUT_MS = 60_000; // the pdf worker and the analysis worker each get 60 s
export const HEAD_SCAN_BYTES = 1024; // '%PDF-' must appear in the first 1024 bytes

export const CHUNK_TARGET = 700;
export const CHUNK_MAX = 1000;
export const CHUNK_OVERLAP = 100;
export const CHUNK_MAX_PAGES = 2;
/** A chunk of at least this many units is closed at a page boundary, so a citation names the page the text is on. */
export const CHUNK_PAGE_BREAK_MIN = 200;

export const EMBED_BATCH = 8; // B1 M4 (TD-66): was 32; kept only if the fixed question set and top_retrieved_page_ok are unchanged in the after-run
export const TOP_K = 4;
export const SOURCE_UNITS = 700;
export const QUESTION_UNITS = 500;
export const MAX_TOKENS = 256;
export const CONTEXT_RETRIES = 3;
