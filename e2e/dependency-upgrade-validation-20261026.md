# Dependency upgrade validation — 2026-10-26

## Candidate

Starting commit: `2a69511`. The candidate updates 25 npm direct dependencies and three Cargo direct
dependencies, with both lockfiles refreshed. Node `26.12.1`, npm `12.2.1`, and Rust/Cargo `1.99.1`
already matched the checked stable toolchains. The original dirty npm lockfile was preserved as an
input, and existing sample results were not edited.

The browser gate uses Playwright `1.64.1` and its Chromium `156.0.8078.4` against the production
bundle built with Vite `8.3.5` / CRX `3.0.0`. It uses synthetic fixture responses, not authenticated
live third-party tasks.

## Initial browser result and diagnosis

The complete initial browser run returned **296 passed, 1 failed** in 6.1 minutes. The failure was
`translation-popup-text.spec.ts`, `keeps native popup rows over media with translucent owner backing`.
Text, original DOM, input values, and the uncovered native media checks passed. The backing crop
failed exact pixel equality with a maximum channel delta of `1/255`.

The original report, screenshots, trace, and log are preserved under the ignored directory
`e2e/.runtime/dependency-upgrade-20261026/initial/`. Extracted crops and `pixel-analysis.json` live
alongside it.

A minimal browser reproduction used the same popup/canvas CSS without loading the extension.
Taking the backing crop before and after applying `will-change: opacity` reproduced exactly the
same pixel difference:

| Region / experiment              | Changed pixels | Maximum channel delta |
| -------------------------------- | -------------- | --------------------- |
| Native edge, extension run       | 0              | 0                     |
| Backing, extension run           | 820 / 2,000    | 1                     |
| Backing, no extension, promotion | 820 / 2,000    | 1                     |

The original backing contained 1,180 pixels of RGBA `(247,161,213,255)` and 820 pixels of
`(246,161,212,255)`. Both the extension run and the native-only layer-promotion reproduction changed
it to 2,000 pixels of `(247,161,213,255)`. This isolates browser compositing quantization from
translation behavior.

Applying `will-change: opacity` temporarily through Playwright's screenshot option was insufficient:
the three-attempt focused check returned **1 passed, 2 failed**, with the same one-channel-step
difference. Its report and traces are retained in `temporary-style/` under the evidence directory.
The compositor promotion must persist across the captures, rather than being repeatedly installed
and removed by the screenshot helper.

Keeping `will-change: opacity` from page load alone was also insufficient: the next focused check
returned **2 passed, 1 failed**. The failed crop had a uniform one-channel-step difference beneath
the popup's edge, while its uncovered native pixels and the separate interior backing crop were
identical. This evidence is retained in `persistent-layer/`.

The native-only reproduction compared default and software rendering as well; the two raster paths
produce different rounding for the same half-opacity blend. The final harness correction uses the
software renderer only for this exact-pixel test file and keeps the translucent fixture in a
compositor layer from page load. The focused three-attempt check then returned **3 passed**.
Other browser test files retain the normal renderer. Product code, fixture text, pixel thresholds,
geometry checks, and source-DOM checks remain unchanged. This normalizes the rendering condition
without relaxing the acceptance assertions.

## Compatibility limits

- TypeScript stays at `6.0.3`. The latest stable compiler is `7.0.2`, but the latest
  `typescript-eslint` `8.72.0` supports `>=4.8.4 <6.1.0`. No forced peer resolution was used.
- Cargo's remaining newer transitive versions are blocked by upstream constraints: `smb2` limits
  `aes` to `<0.9.3` and `ctutils` to `<0.4.3`; `crypto-common` pins `generic-array =0.14.7`; `axum`
  pins `matchit =0.8.4`. No overrides were added.
- The Agora revision remains `bb5a9999c2ddd0ed492e40fa8117b7757c653233`, already the upstream `dev`
  head when checked. No tagged stable release was available.
- Building the IIFE content script emits an upstream CRX/Vite warning: `inlineDynamicImports`
  is ignored because `codeSplitting: false` is set. The CRX child build hardcodes the legacy option;
  Vite 8 supplies the equivalent new option. Comparing CRX `2.7.1` and `3.0.0` confirmed the same
  IIFE path and configuration. No warning suppression, package patch, or content-script loading
  change was added. This remains an unresolved build warning, not a zero-warning validation pass.

## Final verification

The final complete browser gate returned **297 passed, 0 failed** in **5.8 minutes**, with no
retries. The earlier failed attempts remain preserved; they are not replaced by this run.

| Check                                                                                   | Result                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm ci`                                                                                | Clean install succeeded; npm audit reported zero vulnerabilities.            |
| `npm ls --all --json`                                                                   | Passed; no invalid or missing peer dependencies.                             |
| `npm outdated --json`                                                                   | Only the intentionally retained TypeScript version remains.                  |
| `npm run format:check`                                                                  | Passed.                                                                      |
| `npm run lint`                                                                          | Passed with zero warnings.                                                   |
| `npm run typecheck`                                                                     | Passed.                                                                      |
| `npm run build`                                                                         | Succeeded with the single unresolved CRX/Vite warning described above.       |
| `npm run test:run`                                                                      | 145 files / 1,863 tests passed.                                              |
| `npm run test:e2e:built`                                                                | All 297 browser tests passed on the frozen build.                            |
| `npm run audit:bundle`                                                                  | Passed, 17 assets.                                                           |
| `npm run check:sandbox`                                                                 | Actual sandbox integration passed.                                           |
| `npm run e2e:catalog:validate`                                                          | All 46 local sample definitions validated; this does not rerun live samples. |
| `npx tsx e2e/runner/doctor.ts`                                                          | All six environment/runtime checks passed on the existing fresh build.       |
| `cargo fmt --manifest-path sandbox/Cargo.toml --check`                                  | Passed.                                                                      |
| `cargo test --manifest-path sandbox/Cargo.toml --locked`                                | 63 unit tests and six CLI tests passed.                                      |
| `cargo clippy --manifest-path sandbox/Cargo.toml --all-targets --locked -- -D warnings` | Passed with zero warnings.                                                   |
| `cargo update --manifest-path sandbox/Cargo.toml --dry-run --verbose`                   | No further updates are allowed by the resolved upstream constraints.         |

The final browser report is preserved in
`e2e/.runtime/dependency-upgrade-20261026/final/`. Build and dependency hashes are recorded in
`e2e/.runtime/dependency-upgrade-20261026/build-identity.json`. The frozen content-script SHA-256 is
`7c7d3e1d8edf09bc0c611039b497db7e8fe86108129e90966bec9dc1e4ee3fb2`, and the background bundle is
`abc3da3c56e8ae4b7fa24a4d23f6c36b308210d9c1490071e1048649b9e578e1`.

The upgrade is functionally validated by these checks, but it does **not** meet a zero-build-warning
gate, nor does it claim every upstream transitive package is at its unconstrained latest version.
No application behavior, authentication path, task instructions, or production source was changed.
