export function resolveDepsMode(opts: {
  env: Record<string, string | undefined>;
  hasProvenance: boolean;
}): 'stub' | 'vendor';
