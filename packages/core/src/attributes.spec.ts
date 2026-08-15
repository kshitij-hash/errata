import { describe, it, expect } from 'vitest';
import { resolveAttribute, isRegistered, normalizeAttributeToken } from './attributes.js';

describe('attribute registry (spec 31 §7 tests 8-10)', () => {
  it('8: normalizes case / whitespace / punctuation / synonyms to the canonical name', () => {
    expect(resolveAttribute('Company').name).toBe('employer');
    expect(resolveAttribute('  Works At ').name).toBe('employer');
    expect(resolveAttribute('works-at').name).toBe('employer');
    expect(resolveAttribute('Job Title').name).toBe('job_title');
    expect(normalizeAttributeToken('  City of Residence! ')).toBe('city_of_residence');
  });

  it('9: an unregistered attribute resolves to arity MULTI, registered=false', () => {
    const r = resolveAttribute('favorite color of car');
    expect(r.registered).toBe(false);
    expect(r.arity).toBe('MULTI');
    expect(r.name).toBe('favorite_color_of_car');
    expect(isRegistered('favorite color of car')).toBe(false);
  });

  it('10: FUNCTIONAL vs MULTI arity is correct for registered attributes', () => {
    expect(resolveAttribute('employer').arity).toBe('FUNCTIONAL');
    expect(resolveAttribute('city_of_residence').arity).toBe('FUNCTIONAL');
    expect(resolveAttribute('mortgage_preapproval_amount').arity).toBe('FUNCTIONAL');
    expect(resolveAttribute('hobby').arity).toBe('MULTI');
    expect(resolveAttribute('allergy').arity).toBe('MULTI');
  });
});
