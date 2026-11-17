/**
 * T4 — evidence + create_safety contract (retrieval-maxpool incident).
 *
 * The incident's ROOT behavior: the agent read a single blended score (0.64)
 * and decided "no strong match, safe to write a new page" — then wrote a
 * duplicate on top of a fully-developed concept page. A blended RRF/cosine
 * score is not a calibrated probability (Codex#5), so keying the
 * don't-duplicate decision off a raw threshold is fragile.
 *
 * The fix (Codex#6): tell the agent WHY a result matched, not just a number.
 * `evidence` names the strongest signal that surfaced the page; `create_safety`
 * is the derived "is this page already here?" hint the agent keys off instead
 * of a raw score. Pure + deterministic; stamped on every result so MCP callers
 * and `--explain` read the same contract.
 *
 * Evidence precedence (strongest signal wins):
 *   alias_hit          — query exactly matched the page's declared chosen name
 *   exact_title_match  — query is a phrase in the page title (title boost fired)
 *   high_vector_match  — TRUE vector cosine >= VECTOR_COSINE_FLOOR (grounded;
 *                        legacy: blended base_score >= HIGH_MATCH_FLOOR when
 *                        the cosine stamp is absent)
 *   keyword_exact      — solid score but no title/alias/vector tag
 *   weak_semantic      — everything else (low-confidence tail)
 *
 * create_safety:
 *   exists   — strong evidence this IS the page; do NOT create a duplicate
 *   probable — likely the page; prefer updating over creating
 *   unknown  — weak signal; the agent should look closer before deciding
 */

import type { SearchResult } from '../types.ts';

export type Evidence =
  | 'alias_hit'
  | 'exact_title_match'
  | 'high_vector_match'
  | 'keyword_exact'
  | 'weak_semantic';

export type CreateSafety = 'exists' | 'probable' | 'unknown';

/** base_score (pre-boost) at/above this is a confident vector/keyword match. */
export const HIGH_MATCH_FLOOR = 0.85;
/** base_score at/above this is a solid (not weak) match. */
export const SOLID_MATCH_FLOOR = 0.6;

/** True query↔chunk cosine at/above this is a confident semantic match.
 *  Cosine of real embedding pairs concentrates ~[0.3, 0.6]; >= 0.75 is a
 *  strong same-subject hit. Chosen below the OLD blended band (0.85) because
 *  this threshold is grounded on a calibrated per-pair signal, not a pipeline
 *  score whose distribution varies with pool depth and list counts. */
export const VECTOR_COSINE_FLOOR = 0.75;
/** True cosine at/above this is a solid (not weak) semantic match. */
export const VECTOR_COSINE_SOLID = 0.5;

/**
 * Evidence precedence (strongest signal wins). v0.42.68 calibration: the
 * vector arm is grounded on the TRUE query↔chunk cosine (`vector_cosine`,
 * stamped by cosineReScore) when present — base_score is the pre-boost
 * RRF/keyword/title/alias PIPELINE score, not a pure cosine, so a generic
 * high scorer could previously read as create_safety='exists'. When the
 * cosine stamp is absent (keyword-only paths, image-only queries, or callers
 * that predate the stamp), the legacy base_score bands apply unchanged so
 * no caller regresses.
 */
export function classifyEvidence(r: SearchResult): Evidence {
  if (r.alias_hit) return 'alias_hit';
  if (r.title_match_boost && r.title_match_boost > 1.0) return 'exact_title_match';
  // Grounded vector arm: true cosine when the re-score stage stamped it.
  if (typeof r.vector_cosine === 'number' && Number.isFinite(r.vector_cosine)) {
    if (r.vector_cosine >= VECTOR_COSINE_FLOOR) return 'high_vector_match';
    if (r.vector_cosine >= VECTOR_COSINE_SOLID) return 'keyword_exact';
    return 'weak_semantic';
  }
  // Legacy fallback: blended pre-boost pipeline score bands (pre-calibration
  // behavior, preserved verbatim for callers without the cosine stamp).
  const base = typeof r.base_score === 'number' ? r.base_score : r.score;
  if (Number.isFinite(base) && base >= HIGH_MATCH_FLOOR) return 'high_vector_match';
  if (Number.isFinite(base) && base >= SOLID_MATCH_FLOOR) return 'keyword_exact';
  return 'weak_semantic';
}

export function createSafetyFor(evidence: Evidence): CreateSafety {
  switch (evidence) {
    case 'alias_hit':
    case 'exact_title_match':
    case 'high_vector_match':
      return 'exists';
    case 'keyword_exact':
      return 'probable';
    case 'weak_semantic':
      return 'unknown';
  }
}

/**
 * Stamp `evidence` + `create_safety` on every result in place. Called once at
 * the end of the hybrid pipeline (after the alias hop, before slice) so the
 * agent-facing result carries the contract. Idempotent.
 */
export function stampEvidence(results: SearchResult[]): void {
  for (const r of results) {
    const e = classifyEvidence(r);
    r.evidence = e;
    r.create_safety = createSafetyFor(e);
  }
}
