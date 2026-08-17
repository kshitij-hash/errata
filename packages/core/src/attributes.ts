// packages/core/src/attributes.ts — the attribute registry .
//
// Arity drives revision behaviour:
//   FUNCTIONAL — single-valued; a differing value triggers the conflict judge.
//   MULTI      — set-valued; values coexist and are never superseded unless a NEGATE claim
//                matches an existing member.
// An UNREGISTERED attribute is accepted, written with attribute_registered=false, and treated
// as MULTI — conservative on purpose: an unknown attribute can never manufacture a fake revision.

import type { Arity } from './types.js';

interface AttributeSpec {
  canonical: string;
  arity: Arity;
  /** normalized synonyms that map to this canonical name */
  synonyms: readonly string[];
}

const SPECS: readonly AttributeSpec[] = [
  // --- FUNCTIONAL: single-valued facts about the subject ---
  { canonical: 'employer', arity: 'FUNCTIONAL', synonyms: ['company', 'workplace', 'works_at', 'employed_by'] },
  // `current_job_title` is what the LLM extractor actually names this attribute on the demo
  // history; without the synonym the same fact lands unregistered (and therefore MULTI).
  { canonical: 'job_title', arity: 'FUNCTIONAL', synonyms: ['title', 'role', 'position', 'occupation', 'profession', 'current_job_title', 'current_title', 'current_role'] },
  { canonical: 'city_of_residence', arity: 'FUNCTIONAL', synonyms: ['city', 'lives_in', 'residence', 'home_city', 'current_city'] },
  { canonical: 'country_of_residence', arity: 'FUNCTIONAL', synonyms: ['country', 'home_country'] },
  { canonical: 'home_address', arity: 'FUNCTIONAL', synonyms: ['address', 'street_address'] },
  { canonical: 'relationship_status', arity: 'FUNCTIONAL', synonyms: ['marital_status', 'married', 'relationship'] },
  { canonical: 'car_model', arity: 'FUNCTIONAL', synonyms: ['car', 'vehicle', 'car_make'] },
  { canonical: 'phone_model', arity: 'FUNCTIONAL', synonyms: ['phone', 'smartphone'] },
  { canonical: 'current_salary', arity: 'FUNCTIONAL', synonyms: ['salary', 'income', 'pay'] },
  { canonical: 'age', arity: 'FUNCTIONAL', synonyms: ['years_old'] },
  { canonical: 'university', arity: 'FUNCTIONAL', synonyms: ['school', 'college', 'alma_mater'] },
  { canonical: 'degree', arity: 'FUNCTIONAL', synonyms: ['graduated_with', 'qualification'] },
  { canonical: 'major', arity: 'FUNCTIONAL', synonyms: ['field_of_study', 'studied'] },
  { canonical: 'mortgage_lender', arity: 'FUNCTIONAL', synonyms: ['lender', 'bank_for_mortgage'] },
  { canonical: 'mortgage_preapproval_amount', arity: 'FUNCTIONAL', synonyms: ['preapproval_amount', 'pre_approved_amount', 'preapproved_for', 'mortgage_amount'] },
  { canonical: 'primary_bank', arity: 'FUNCTIONAL', synonyms: ['bank'] },
  // --- MULTI: set-valued; members coexist ---
  { canonical: 'hobby', arity: 'MULTI', synonyms: ['hobbies', 'pastime', 'interest'] },
  { canonical: 'allergy', arity: 'MULTI', synonyms: ['allergies', 'allergic_to'] },
  { canonical: 'visited_city', arity: 'MULTI', synonyms: ['visited', 'travelled_to', 'traveled_to', 'been_to'] },
  { canonical: 'owns_pet', arity: 'MULTI', synonyms: ['pet', 'pets', 'has_pet'] },
  { canonical: 'favorite_food', arity: 'MULTI', synonyms: ['favourite_food', 'likes_food'] },
  { canonical: 'skill', arity: 'MULTI', synonyms: ['skills', 'can_do'] },
  { canonical: 'language_spoken', arity: 'MULTI', synonyms: ['language', 'speaks'] },
  { canonical: 'dietary_restriction', arity: 'MULTI', synonyms: ['diet', 'dietary'] },
  { canonical: 'subscription', arity: 'MULTI', synonyms: ['subscriptions', 'subscribed_to'] },
  { canonical: 'medication', arity: 'MULTI', synonyms: ['medications', 'takes_medication'] },
];

/** lowercase, collapse any run of non-alphanumeric characters to a single underscore, trim `_`. */
export function normalizeAttributeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const LOOKUP: ReadonlyMap<string, AttributeSpec> = (() => {
  const m = new Map<string, AttributeSpec>();
  for (const spec of SPECS) {
    m.set(spec.canonical, spec);
    for (const syn of spec.synonyms) m.set(normalizeAttributeToken(syn), spec);
  }
  return m;
})();

export interface ResolvedAttribute {
  name: string; // canonical if registered, else the normalized token
  arity: Arity;
  registered: boolean;
}

/** Map a raw extractor attribute to a registry entry; unknown → MULTI, registered=false. */
export function resolveAttribute(raw: string): ResolvedAttribute {
  const token = normalizeAttributeToken(raw);
  const spec = LOOKUP.get(token);
  if (spec) return { name: spec.canonical, arity: spec.arity, registered: true };
  return { name: token, arity: 'MULTI', registered: false };
}

export function isRegistered(raw: string): boolean {
  return LOOKUP.has(normalizeAttributeToken(raw));
}

/**
 * The registry's own synonyms for an attribute, as words — the curated half of the ask path's
 * attribute vocabulary (the other half is generated per history at ingest, see ingest/aliases.ts).
 * `mortgage_preapproval_amount` yields `pre approved amount`, which is how a person asks for it.
 * Unregistered attributes have none, which is the honest answer: nobody has written them down.
 */
export function attributeSynonyms(raw: string): string[] {
  const spec = LOOKUP.get(normalizeAttributeToken(raw));
  if (!spec) return [];
  return spec.synonyms.map((s) => s.replace(/_/g, ' '));
}
