/**
 * The one seam between the hero band and the ask card below it.
 *
 * The hero's refusal beat and its itinerary both promise a specific question; they keep that
 * promise by asking it through the same path a chip click takes (`AskSpread.run`) rather than by
 * restating an answer of their own. A window event, because the two live in different subtrees of a
 * server-rendered page and threading a callback between them would mean lifting the whole ask into
 * the hero's parent.
 */
export const ASK_EVENT = 'errata:ask';

export function askFor(question: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: question }));
}
