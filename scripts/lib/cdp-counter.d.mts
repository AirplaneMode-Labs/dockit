export interface Ledger {
  onEvent(session: string, method: string, params: any): void;
  mark(label: string): void;
  since(label: string): { network: string[]; swHits: number; cacheHits: number; total: number };
  targetCounts(): Record<string, number>;
  requireTargets(min: Record<string, number>): void;
  targets(): { type: string; url: string; sessionId: string }[];
}
export function createLedger(): Ledger;
export function connectCdp(
  userDataDir: string,
  o?: { timeoutMs?: number },
): Promise<{
  ledger: Ledger;
  close(): void;
  getTargets(): Promise<{ targetInfos: { type: string; url: string; title?: string }[] }>;
  /** Calls cb for a crashed target or a closed debugging socket; returns the function that stops the calls. */
  onFailure(cb: (f: { kind: string; targetType?: string; status?: string }) => void): () => boolean;
}>;
