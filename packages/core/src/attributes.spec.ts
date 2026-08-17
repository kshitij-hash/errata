import { describe, it, expect } from 'vitest';
import { attributeSynonyms, resolveAttribute, isRegistered, normalizeAttributeToken } from './attributes.js';

describe('attribute registry ', () => {
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

  it('exposes the registry synonyms as words, for the ask path\'s attribute vocabulary', () => {
    // the flagship question says "pre-approved"; the attribute spells it closed. The registry is
    // where that equivalence is already written down, so the ask path reads it rather than guessing.
    expect(attributeSynonyms('mortgage_preapproval_amount')).toContain('pre approved amount');
    expect(attributeSynonyms('employer')).toContain('works at');
    expect(attributeSynonyms('favorite_color_of_car')).toEqual([]); // unregistered: no vocabulary
  });
});
