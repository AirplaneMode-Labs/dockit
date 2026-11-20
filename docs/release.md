# Release

dockit is never published to a registry; the Pages deploy is the release.

It is a private application (`@airplanemode/dockit`, `private: true`): there is no npm package, no wheel and no crate, so there is nothing to reserve, sign for a registry
or publish. The release is the GitHub Pages deploy of `.github/workflows/pages.yml` at https://airplanemode-labs.github.io/dockit/, built from `main` from the four sibling repositories
at the commits in `deps.lock.json`. dockit is not tagged and nothing is published by the team: the push is the main session's (owner decision of 19 Nov 2026), and a tag is the owner's.

Definition of done for a release, as it stands for dockit:

| Row                                         | State                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tests first, CI on Linux, macOS and Windows | Done: `npm run ci` on the three systems (the sibling-dependent contract tests skip in a lone checkout: exactly 3 skipped).                                                                                                                                               |
| Benchmark on an 8 GB laptop in the README   | **Open, owner only**: every figure is from an Apple M5 Pro with 48 GB and reads "not measured on 8 GB".                                                                                                                                                                  |
| Windows run                                 | The `bench-windows` workflow ran once (run 44656249868, 20 Nov 2026); emulated (a GitHub-hosted VM, not a laptop), it fills no 8 GB cell and its job commit limit is unproven (a read-back, a probe and a 2 GiB control leg that settle it are written and not yet run). |
| Limitations section                         | Done (README).                                                                                                                                                                                                                                                           |
| Signed artefacts and manifest               | The model manifest is signed by a key that exists only inside the build; a real key and its custody are **owner only** (nothing here handles a real key).                                                                                                                |
| CHANGELOG                                   | Done (`## [0.4.0-dev] - 2026-11-20 (untagged)`).                                                                                                                                                                                                                         |
| Semver tag                                  | None, and none is created by the team.                                                                                                                                                                                                                                   |
| Installable from a clean machine            | Not applicable: dockit is built from a clone and served; the clean-machine proof is the lock proof from fresh clones (`pages.yml`'s steps, run by the architect at every wrap-up).                                                                                       |
| Short write-up                              | A draft exists on the site as an unlisted page; not published.                                                                                                                                                                                                           |
