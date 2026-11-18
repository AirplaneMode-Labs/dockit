/**
 * Shown instead of the app when the page is inside a frame (reason 'framed'): no file input, no download, no ask. The link
 * is a literal './' (the app's own address, resolved by the browser) opened in a new top-level tab.
 */
export function Framed() {
  return (
    <main className="app" data-testid="framed">
      <h1>dockit</h1>
      <p data-testid="framed-message">dockit does not run inside another page. Open it directly.</p>
      <p>
        <a href="./" target="_blank" rel="noopener" data-testid="framed-open">
          Open dockit directly
        </a>
      </p>
    </main>
  );
}
