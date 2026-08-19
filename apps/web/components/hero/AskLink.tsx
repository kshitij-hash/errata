'use client';

import type { ReactNode } from 'react';
import { askFor } from '../../lib/askbus';

/**
 * A link into the ask card that also asks. The anchor jump is left alone — it is what scrolls the
 * card into view, and it still works with JS off — and the click additionally runs the question
 * through the ask card's own chip path, so the hero never has to state the answer itself.
 */
export function AskLink({
  question,
  className,
  children,
}: {
  question: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href="#ask" className={className} onClick={() => askFor(question)}>
      {children}
    </a>
  );
}
