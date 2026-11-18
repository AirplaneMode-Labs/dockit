/** Decimal megabytes, as the Download button and the progress read-out show them. */
export const mb = (bytes: number): string =>
  `${Math.round(bytes / 1_000_000).toLocaleString('en-US')} MB`;

export const ms = (n: number | null | undefined): string =>
  n === null || n === undefined ? 'n/a' : `${Math.round(n).toLocaleString('en-US')} ms`;
