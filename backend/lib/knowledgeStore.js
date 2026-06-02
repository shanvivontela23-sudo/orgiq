'use strict';

/**
 * knowledgeStore.js
 *
 * Stores fix patterns learned from real deploy failures.
 * Built-in patterns are seeded here. New patterns are added at runtime
 * and persisted to Supabase so future deploys benefit automatically.
 *
 * Schema (connected_orgs_fix_patterns table in Supabase):
 *   id, created_at, artifact_type, error_regex, category,
 *   deterministic_fix, prompt_rule, preflight_rule, hit_count
 */

const supabase = require('./supabase');

// ── Built-in seed patterns (always available without DB) ──────────────────────
const SEED_PATTERNS = [
  {
    artifact_type:     'validationRule',
    error_regex:       'description.*too long',
    category:          'DESCRIPTION_TOO_LONG',
    deterministic_fix: 'truncate_description_255',
    prompt_rule:       'Validation rule descriptions must be 255 characters or fewer.',
    preflight_rule:    'Check description length before deploy.',
  },
  {
    artifact_type:     'validationRule',
    error_regex:       'formula.*comment|/\\*.*\\*/',
    category:          'FORMULA_HAS_COMMENTS',
    deterministic_fix: 'strip_formula_comments',
    prompt_rule:       'Validation rule formulas must not contain /* */ comments.',
    preflight_rule:    'Strip /* */ comments from errorConditionFormula.',
  },
  {
    artifact_type:     'validationRule',
    error_regex:       'fullName.*must include object',
    category:          'MISSING_OBJECT_PREFIX',
    deterministic_fix: 'prepend_object_to_fullname',
    prompt_rule:       'Validation rule fullName must be in format Object.RuleName.',
    preflight_rule:    'Validate fullName contains a dot separator.',
  },
  {
    artifact_type:     'flow',
    error_regex:       'DML.*no fault connector|fault path.*required',
    category:          'FLOW_MISSING_FAULT_PATH',
    deterministic_fix: null,
    prompt_rule:       'Every DML element in a Flow must have a faultConnector.',
    preflight_rule:    'Count DML elements and verify each has a faultConnector.',
  },
  {
    artifact_type:     'flow',
    error_regex:       'invalid reference to node',
    category:          'FLOW_INVALID_REFERENCE',
    deterministic_fix: null,
    prompt_rule:       'Every connector targetReference must point to a real element defined in the Flow.',
    preflight_rule:    'Check all connector targetReferences exist as element names.',
  },
  {
    artifact_type:     'report',
    error_regex:       "folder '.*' does not exist",
    category:          'MISSING_FOLDER',
    deterministic_fix: 'use_public_reports_folder',
    prompt_rule:       'Use an existing report folder. Default to "Public Reports" if unsure.',
    preflight_rule:    'Verify the report folder exists before deploying.',
  },
];

/**
 * Get all patterns for an artifact type (seed + learned).
 */
async function getPatternsForType(artifactType) {
  const seed = SEED_PATTERNS.filter(p =>
    p.artifact_type === artifactType || p.artifact_type === 'all'
  );

  try {
    const { data } = await supabase
      .from('fix_patterns')
      .select('*')
      .or(`artifact_type.eq.${artifactType},artifact_type.eq.all`)
      .order('hit_count', { ascending: false });

    return [...seed, ...(data || [])];
  } catch {
    return seed; // DB unavailable — use seed only
  }
}

/**
 * Record a new failure pattern we haven't seen before.
 * This lets us track unknown errors and eventually add deterministic fixes.
 */
async function recordNewPattern(errorMessage, artifactType, category = 'UNKNOWN') {
  try {
    await supabase.from('fix_patterns').upsert({
      artifact_type:  artifactType,
      error_regex:    errorMessage.slice(0, 200),
      category,
      hit_count:      1,
      is_new:         true,
      created_at:     new Date().toISOString(),
    }, { onConflict: 'error_regex,artifact_type' });
  } catch {
    // Non-critical — log and continue
    console.warn('[knowledgeStore] Could not record new pattern:', errorMessage.slice(0, 80));
  }
}

/**
 * Increment hit count for a known pattern (helps prioritize fix automation).
 */
async function incrementHitCount(category, artifactType) {
  try {
    await supabase.rpc('increment_fix_pattern_hits', { p_category: category, p_artifact_type: artifactType });
  } catch {
    // Non-critical
  }
}

/**
 * Get all prompt rules for an artifact type — inject these into repair prompts.
 */
async function getPromptRules(artifactType) {
  const patterns = await getPatternsForType(artifactType);
  return patterns
    .map(p => p.prompt_rule)
    .filter(Boolean)
    .join('\n');
}

/**
 * Get all preflight rules for an artifact type.
 */
async function getPreflightRules(artifactType) {
  const patterns = await getPatternsForType(artifactType);
  return patterns
    .map(p => p.preflight_rule)
    .filter(Boolean);
}

module.exports = {
  getPatternsForType,
  recordNewPattern,
  incrementHitCount,
  getPromptRules,
  getPreflightRules,
  SEED_PATTERNS,
};
