/**
 * Explicit timeouts for the tests whose cost depends on the machine rather than on the code. vitest's default is 5 000 ms, and a number
 * is only worth writing down with the measurement behind it. The Windows figures are from the windows-latest job of CI run 44325772916
 * (same commit, same tests); the local figures are this repository's tests on an Apple-silicon Mac.
 */

/**
 * Every test that loads the real pdf.js (pdfjs-dist/legacy: about 1.2 MB of module plus the fake worker it imports on first use).
 * The first such test in a file pays for that load: 115 ms locally, 5 673 ms on windows-latest, where it hit the 5 000 ms default
 * (`policy-3p.pdf has three pages and page 2 holds the grace-period sentence`). That is about 50 times slower on a cold runner, so
 * 30 s is five times the worst figure seen: a slow runner passes, a real hang still fails long before the job limit.
 */
export const PDFJS_TEST_TIMEOUT_MS = 30_000;

/**
 * How long a test waits for pdf.js to open a document before it treats it as hung and carries on with an empty result. It must stay
 * below PDFJS_TEST_TIMEOUT_MS so a hang shows up as the assertion on the page count instead of a bare timeout, and above the cold load
 * (it was 3 000 ms, which a runner that needs 5 673 ms for the module alone would also have missed).
 */
export const PDFJS_OPEN_GUARD_MS = 20_000;

/**
 * Tests that build four scratch git repositories and run the assembler against them (a few dozen git processes each): 370 to 440 ms
 * locally, 1 516 to 1 806 ms on windows-latest, where process start-up is slow. That left 36 % of the default, so a slower runner day would
 * fail them for no reason. 30 s again, for the same reason as above.
 */
export const SCRATCH_GIT_TEST_TIMEOUT_MS = 30_000;
