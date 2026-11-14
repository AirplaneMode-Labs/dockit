import type { TrustedTypesLike } from './trusted-types.ts';

declare global {
  interface Window {
    /** Present only where Trusted Types is supported. */
    trustedTypes?: TrustedTypesLike;
  }
}
