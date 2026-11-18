/**
 * What may reach the screen from a model answer: tag characters (U+E0000-E007F, a known smuggling channel) and bidi controls
 * (U+202A-202E, U+2066-2069, which can reorder what the reader sees) are dropped. The result is rendered as ONE text node;
 * nothing here parses markup, links or markdown.
 */
export function sanitiseDisplay(text: string): string {
  return text.normalize('NFC').replace(/[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/gu, '');
}
