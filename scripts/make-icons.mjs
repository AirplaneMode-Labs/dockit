#!/usr/bin/env node
// The PWA icons in public/icons/ are copies of the organisation icons in the site repo
// (site/brand/icons/icon-192.png and icon-512.png, rendered from site/brand/airplanemode-labs-icon.svg).
// Do not generate them here; copy them from the sibling checkout when the brand changes:
//   cp ../site/brand/icons/icon-192.png ../site/brand/icons/icon-512.png public/icons/
console.error('dockit icons are copied from ../site/brand/icons; see the comment in scripts/make-icons.mjs');
process.exit(1);
