import { describe, expect, it } from 'vitest';
import { version } from './index.js';

describe('@errata/core', () => {
  it('exposes a version', () => {
    expect(version).toBe('0.0.0');
  });
});
