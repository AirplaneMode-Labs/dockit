export const FIXTURE_DIR: string;
export const POLICY_3P_PAGES: { title: string; lines: string[] }[];
export const INJECTION_PAGES: { title: string; lines: string[]; annots?: string[] }[];
export const DEVA_LINES: string[];
export function noiseDevanagari(lines: string[], p?: number, seed?: number): string[];
export function buildAll(): Record<string, Buffer>;
