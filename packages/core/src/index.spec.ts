import { describe, it, expect } from 'vitest';
import * as core from './index.js';

describe('@errata/core public surface', () => {
  it('exports the domain functions', () => {
    for (const fn of ['resolveBelief', 'resolveAsOf', 'diffChain', 'scoreEvidence', 'decide', 'resolveAttribute']) {
      expect(typeof (core as Record<string, unknown>)[fn]).toBe('function');
    }
  });
});
