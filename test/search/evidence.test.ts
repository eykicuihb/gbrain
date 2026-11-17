/**
 * T4 — evidence + create_safety contract. This is the agent-facing signal that
 * prevents the incident's duplicate-stub class: the don't-write decision keys
 * off WHY a page matched, not a raw blended score.
 */

import { describe, test, expect } from 'bun:test';
import { classifyEvidence, createSafetyFor, stampEvidence, HIGH_MATCH_FLOOR, SOLID_MATCH_FLOOR, VECTOR_COSINE_FLOOR, VECTOR_COSINE_SOLID } from '../../src/core/search/evidence.ts';
import type { SearchResult } from '../../src/core/types.ts';

function r(partial: Partial<SearchResult>): SearchResult {
  return { slug: 's', title: 't', chunk_text: '', type: 'note', source_id: 'default', chunk_index: 0, chunk_id: 1, score: 0.5, ...partial } as SearchResult;
}

describe('classifyEvidence precedence', () => {
  test('alias_hit wins over everything', () => {
    expect(classifyEvidence(r({ alias_hit: true, title_match_boost: 1.25, base_score: 0.99 }))).toBe('alias_hit');
  });
  test('exact_title_match when title boost fired', () => {
    expect(classifyEvidence(r({ title_match_boost: 1.25, base_score: 0.2 }))).toBe('exact_title_match');
  });
  test('high_vector_match at/above HIGH_MATCH_FLOOR', () => {
    expect(classifyEvidence(r({ base_score: HIGH_MATCH_FLOOR }))).toBe('high_vector_match');
    expect(classifyEvidence(r({ base_score: 0.90 }))).toBe('high_vector_match');
  });
  test('keyword_exact in the solid band', () => {
    expect(classifyEvidence(r({ base_score: SOLID_MATCH_FLOOR }))).toBe('keyword_exact');
    expect(classifyEvidence(r({ base_score: 0.7 }))).toBe('keyword_exact');
  });
  test('weak_semantic below the solid floor (the incident: 0.64 body chunk... 0.5 here)', () => {
    expect(classifyEvidence(r({ base_score: 0.4 }))).toBe('weak_semantic');
  });
  test('falls back to score when base_score absent', () => {
    expect(classifyEvidence(r({ score: 0.95, base_score: undefined }))).toBe('high_vector_match');
  });
});

describe('classifyEvidence — grounded vector_cosine arm (calibration TODO fix)', () => {
  test('true cosine >= floor → high_vector_match, even when the blended base_score is low', () => {
    // The TODO's failure mode, inverted: a LOW blended pipeline score that
    // hides a genuinely strong semantic match now reads correctly.
    expect(classifyEvidence(r({ vector_cosine: VECTOR_COSINE_FLOOR, base_score: 0.3 }))).toBe('high_vector_match');
    expect(classifyEvidence(r({ vector_cosine: 0.9, base_score: 0.3 }))).toBe('high_vector_match');
  });

  test('THE TODO CASE — generic high base_score WITHOUT a strong true cosine no longer reads as exists', () => {
    // base_score 0.86 cleared the old blended band → create_safety='exists'
    // even though the real cosine says the chunk is only weakly related.
    const genericHigh = r({ base_score: 0.86, vector_cosine: 0.35 });
    expect(classifyEvidence(genericHigh)).toBe('weak_semantic');
    expect(createSafetyFor(classifyEvidence(genericHigh))).toBe('unknown');
  });

  test('cosine in the solid band → keyword_exact/probable', () => {
    expect(classifyEvidence(r({ vector_cosine: VECTOR_COSINE_SOLID, base_score: 0.9 }))).toBe('keyword_exact');
    expect(classifyEvidence(r({ vector_cosine: 0.6, base_score: 0.9 }))).toBe('keyword_exact');
  });

  test('cosine below the solid band → weak_semantic regardless of base_score', () => {
    expect(classifyEvidence(r({ vector_cosine: 0.2, base_score: 0.99 }))).toBe('weak_semantic');
  });

  test('alias_hit and exact_title_match still outrank the cosine arm', () => {
    expect(classifyEvidence(r({ alias_hit: true, vector_cosine: 0.1 }))).toBe('alias_hit');
    expect(classifyEvidence(r({ title_match_boost: 1.25, vector_cosine: 0.1 }))).toBe('exact_title_match');
  });

  test('non-finite cosine falls through to the legacy base_score bands', () => {
    expect(classifyEvidence(r({ vector_cosine: NaN, base_score: 0.86 }))).toBe('high_vector_match');
    expect(classifyEvidence(r({ vector_cosine: undefined, base_score: 0.86 }))).toBe('high_vector_match');
  });

  test('stampEvidence propagates the grounded labels', () => {
    const rs = [r({ vector_cosine: 0.8 }), r({ vector_cosine: 0.3, base_score: 0.99 })];
    stampEvidence(rs);
    expect(rs[0].evidence).toBe('high_vector_match');
    expect(rs[0].create_safety).toBe('exists');
    expect(rs[1].evidence).toBe('weak_semantic');
    expect(rs[1].create_safety).toBe('unknown');
  });
});

describe('createSafetyFor', () => {
  test('strong evidence → exists (do NOT duplicate)', () => {
    expect(createSafetyFor('alias_hit')).toBe('exists');
    expect(createSafetyFor('exact_title_match')).toBe('exists');
    expect(createSafetyFor('high_vector_match')).toBe('exists');
  });
  test('keyword_exact → probable', () => {
    expect(createSafetyFor('keyword_exact')).toBe('probable');
  });
  test('weak_semantic → unknown', () => {
    expect(createSafetyFor('weak_semantic')).toBe('unknown');
  });
});

describe('stampEvidence', () => {
  test('stamps both fields on every result', () => {
    const rs = [r({ alias_hit: true }), r({ base_score: 0.3 })];
    stampEvidence(rs);
    expect(rs[0].evidence).toBe('alias_hit');
    expect(rs[0].create_safety).toBe('exists');
    expect(rs[1].evidence).toBe('weak_semantic');
    expect(rs[1].create_safety).toBe('unknown');
  });

  test('the incident: a 0.64 body-chunk match reads as weak/unknown (agent should look closer, not blindly duplicate)', () => {
    const incident = r({ base_score: 0.64, score: 0.64 });
    stampEvidence([incident]);
    expect(incident.evidence).toBe('keyword_exact'); // 0.64 is in the solid band
    expect(incident.create_safety).toBe('probable');  // not 'unknown' — prefer update over create
  });

  test('after the fix: the same page via alias/title reads as exists (do not duplicate)', () => {
    const fixed = r({ base_score: 0.64, alias_hit: true });
    stampEvidence([fixed]);
    expect(fixed.evidence).toBe('alias_hit');
    expect(fixed.create_safety).toBe('exists');
  });
});
