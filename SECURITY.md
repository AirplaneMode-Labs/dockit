# Security policy

## Supported versions

| Version           | Supported |
| ----------------- | --------- |
| none released yet | -         |

dockit has no release. The `main` branch is a skeleton under active development; please
report problems against it anyway.

## Reporting a vulnerability

Email jtushar53@gmail.com with a description, the commit or version affected and, where
possible, a reproduction. You will get an acknowledgement within seven days.

Airplane Mode Labs follows a 90-day coordinated disclosure window: we aim to fix and publish
within 90 days of the report, and we will coordinate the publication date with you. If a fix
needs longer we will say so before the window ends.

## Test key material

Any Ed25519 key material that appears in an Airplane Mode Labs repository is the published,
non-secret RFC 8032 section 7.1 test vector. It is public test data; it is never trusted
outside tests and it signs nothing real. dockit's `src/` contains no key material at all;
the trust set (`src/trust.ts`) is an empty typed constant until real keys are compiled in
before any pilot.

## Telemetry

dockit collects no telemetry and makes no network requests other than the asset and manifest
URLs you pass it, so there is nothing to opt out of.
