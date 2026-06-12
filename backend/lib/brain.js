'use strict';
/**
 * lib/brain.js
 *
 * OrgIQ persistent memory service ("the brain").
 * Stores operational intelligence across migration runs so Claude never starts
 * cold — it knows what errors happened, what fixed them, and which patterns
 * recur for each object/operation.
 *
 * Memory types:
 *   error_fix        — error code/message → what resolved it
 *   migration_pattern — per-object load behaviours (field issues, read-only cols, etc.)
 *   bulk_load_event  — summary of a completed migration job
 *   user_preference  — how the user likes things done
 *
 * Retrieval: keyword overlap + importance + recency (no external embedding API).
 * Degrades silently if brain_memories table doesn't exist yet.
 */

const supabase = require('./supabase');

const TABLE = 'brain_memories';
const MAX_MEMORY_CHARS = 1200;
const MAX_CONTEXT_CHARS = 2400;

// ── helpers ──────────────────────────────────────────────────────────────────

function isMissingBrainTableError(err) {
  const message = err?.message || String(err || '');
  return /does not exist|schema cache|could not find the table|relation .*brain_memories/i.test(message);
}

/**
 * Extract searchable keywords from free text + metadata.
 * Lowercased, deduped, stops words removed.
 */
function extractKeywords(...parts) {
  const stop = new Set(['the','a','an','in','on','for','to','of','is','was','are','with','and','or','not','this','that','it','by','at','be','as']);
  const words = parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w));
  return [...new Set(words)];
}

function canonicalSubject(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function compactText(value, max = MAX_MEMORY_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeErrorSignature(value) {
  return compactText(value, 500)
    .toLowerCase()
    .replace(/\b[a-zA-Z0-9]{15,18}\b/g, '{sf_id}')
    .replace(/\b\d+\b/g, '{n}')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeContent(existing, next) {
  const oldText = compactText(existing);
  const newText = compactText(next);
  if (!oldText) return newText;
  if (!newText || oldText === newText || oldText.includes(newText)) return oldText;

  const marker = `[Latest ${new Date().toISOString().slice(0, 10)}]`;
  return compactText(`${newText}\n${marker} Prior note: ${oldText}`);
}

/**
 * Score a memory against a set of query keywords.
 * Higher = more relevant.
 */
function scoreMemory(memory, queryKeywords) {
  const memKw = new Set(memory.keywords || []);
  const overlap = queryKeywords.filter(k => memKw.has(k)).length;
  const recencyDays = (Date.now() - new Date(memory.created_at).getTime()) / 86400000;
  const recencyScore = Math.max(0, 1 - recencyDays / 90); // decay over 90 days
  return overlap * 2 + (memory.importance || 3) + recencyScore + (memory.access_count || 0) * 0.1;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Store a memory. Safe to call fire-and-forget.
 * Upserts by (user_id, type, subject) so duplicate events update rather than grow unbounded.
 */
async function remember({ userId, orgId, type, subject, content, keywords = [], metadata = {}, importance = 3 }) {
  try {
    const normalizedSubject = canonicalSubject(subject);
    const cleanContent = compactText(content);
    const kw = [...new Set([...extractKeywords(normalizedSubject, cleanContent), ...keywords])].slice(0, 40);

    // Try to update existing memory with same subject+type first
    const { data: existing } = await supabase
      .from(TABLE)
      .select('id, content, access_count, metadata, importance')
      .eq('user_id', userId)
      .eq('type', type)
      .eq('subject', normalizedSubject)
      .maybeSingle();

    if (existing) {
      const nextMetadata = {
        ...(existing.metadata || {}),
        ...metadata,
        occurrenceCount: ((existing.metadata || {}).occurrenceCount || 1) + 1,
      };

      await supabase.from(TABLE).update({
        content:       mergeContent(existing.content, cleanContent),
        keywords:      kw,
        metadata:      nextMetadata,
        importance:    Math.max(existing.importance || 3, importance),
        last_accessed: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await supabase.from(TABLE).insert({
        user_id:    userId,
        org_id:     orgId || null,
        type,
        subject:    normalizedSubject,
        content:    cleanContent,
        keywords:   kw,
        metadata:   { ...metadata, occurrenceCount: 1 },
        importance,
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString(),
      });
    }
  } catch (err) {
    // Brain errors must never crash the main flow
    if (!isMissingBrainTableError(err)) {
      console.warn('[brain] remember failed:', err.message);
    }
  }
}

async function rememberDeployFailure({
  userId,
  orgId,
  metadataType,
  classifiedError,
  repairSucceeded = false,
}) {
  const rawError = classifiedError?.rawError || classifiedError?.question || '';
  const errorSignature = normalizeErrorSignature(rawError);
  if (!userId || !metadataType || !errorSignature) return;

  const rootCause = classifiedError.rootCause || classifiedError.root_cause || 'Unknown Salesforce deployment failure.';
  const fixStrategy = classifiedError.repairStrategy || classifiedError.promptRule || classifiedError.question || 'Ask for clarification and retry dry run.';
  const safe = Boolean(classifiedError.safeToAutoRepair || classifiedError.safe_to_auto_repair || classifiedError.deterministic);
  const confidence = typeof classifiedError.confidence === 'number'
    ? classifiedError.confidence
    : (safe ? 0.9 : 0.5);
  const subject = canonicalSubject(`${metadataType} ${classifiedError.category || 'UNKNOWN'} ${errorSignature.slice(0, 80)}`);

  await remember({
    userId,
    orgId,
    type: 'error_fix',
    subject,
    content: `${rootCause} Fix strategy: ${fixStrategy}`,
    keywords: extractKeywords(metadataType, classifiedError.category, errorSignature, rootCause, fixStrategy),
    importance: safe ? 5 : 4,
    metadata: {
      metadataType,
      errorSignature,
      errorCategory: classifiedError.category || 'UNKNOWN',
      rootCause,
      fixStrategy,
      safeToAutoRepair: safe,
      confidence,
    },
  });

  // Best-effort structured columns for the 002 schema. Kept separate so older
  // 001-only databases still work.
  try {
    const { data: existing } = await supabase
      .from(TABLE)
      .select('id, success_count, failure_count')
      .eq('user_id', userId)
      .eq('metadata_type', metadataType)
      .eq('error_signature', errorSignature)
      .maybeSingle();

    const { data: subjectMatch } = existing?.id ? { data: existing } : await supabase
      .from(TABLE)
      .select('id, success_count, failure_count')
      .eq('user_id', userId)
      .eq('type', 'error_fix')
      .eq('subject', subject)
      .maybeSingle();

    const target = existing?.id ? existing : subjectMatch;

    const counts = {
      success_count: (target?.success_count || 0) + (repairSucceeded ? 1 : 0),
      failure_count: (target?.failure_count || 0) + (repairSucceeded ? 0 : 1),
    };

    if (target?.id) {
      await supabase.from(TABLE).update({
        metadata_type: metadataType,
        error_signature: errorSignature,
        root_cause: rootCause,
        fix_strategy: fixStrategy,
        safe_to_auto_repair: safe,
        confidence,
        ...counts,
        last_seen: new Date().toISOString(),
      }).eq('id', target.id);
    } else {
      await supabase.from(TABLE).insert({
        user_id: userId,
        org_id: orgId || null,
        type: 'error_fix',
        subject,
        content: compactText(`${rootCause} Fix strategy: ${fixStrategy}`),
        keywords: extractKeywords(metadataType, classifiedError.category, errorSignature, rootCause, fixStrategy),
        importance: safe ? 5 : 4,
        metadata_type: metadataType,
        error_signature: errorSignature,
        root_cause: rootCause,
        fix_strategy: fixStrategy,
        safe_to_auto_repair: safe,
        confidence,
        ...counts,
        metadata: {
          errorCategory: classifiedError.category || 'UNKNOWN',
          occurrenceCount: 1,
        },
        created_at: new Date().toISOString(),
        last_accessed: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      });
    }
  } catch (err) {
    if (!isMissingBrainTableError(err)) {
      console.warn('[brain] structured deploy failure memory failed:', err.message);
    }
  }
}

/**
 * Recall memories relevant to a query string.
 * Returns top N memories sorted by relevance score.
 */
async function recall({ userId, orgId, query, type, limit = 6 }) {
  try {
    const queryKeywords = extractKeywords(query || '');

    let q = supabase
      .from(TABLE)
      .select('id, type, subject, content, keywords, importance, access_count, metadata, created_at')
      .eq('user_id', userId)
      .order('importance', { ascending: false })
      .order('last_accessed', { ascending: false })
      .limit(50); // fetch broad set, then re-rank locally

    if (orgId) q = q.eq('org_id', orgId);
    if (type)  q = q.eq('type', type);

    const { data: memories, error } = await q;
    if (error || !memories?.length) return [];

    // Increment access count for retrieved memories (fire-and-forget)
    const scored = memories
      .map(m => ({ ...m, _score: scoreMemory(m, queryKeywords) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, limit);

    const now = new Date().toISOString();
    for (const memory of scored) {
      supabase.from(TABLE).update({
        access_count: (memory.access_count || 0) + 1,
        last_accessed: now,
      }).eq('id', memory.id).then(() => {}).catch(() => {});
    }

    return scored;
  } catch (err) {
    if (!isMissingBrainTableError(err)) {
      console.warn('[brain] recall failed:', err.message);
    }
    return [];
  }
}

/**
 * Build a formatted context string to inject into Claude's system prompt.
 * Returns empty string if no relevant memories found.
 */
async function buildContext({ userId, orgId, query, limit = 5 }) {
  const memories = await recall({ userId, orgId, query, limit });
  if (!memories.length) return '';

  const lines = [];
  let usedChars = 0;

  for (const m of memories) {
    const prefix = {
      error_fix:         'Error fix learned',
      migration_pattern: 'Migration pattern',
      bulk_load_event:   'Past load',
      user_preference:   'User preference',
    }[m.type] || 'Memory';
    const occurrence = m.metadata?.occurrenceCount > 1 ? ` (${m.metadata.occurrenceCount}x)` : '';
    const line = `${prefix}${occurrence}: ${m.subject} — ${compactText(m.content, 450)}`;
    if (usedChars + line.length > MAX_CONTEXT_CHARS) break;
    lines.push(line);
    usedChars += line.length;
  }

  return `## What I remember from past sessions\n\n${lines.join('\n\n')}`;
}

/**
 * Auto-remember everything useful from a completed bulk load.
 * Call this after runBulkDataLoad resolves.
 */
async function rememberBulkLoad({ userId, orgId, objectApiName, operation, result, preflight, rowCount }) {
  const succeeded = result.succeeded ?? 0;
  const failed    = result.failed    ?? 0;
  const sfFailed  = result.sfJobState === 'Failed';
  const hasPattern = Boolean(
    preflight?.warnings?.length ||
    preflight?.errors?.length ||
    result.errors?.length ||
    sfFailed ||
    failed > 0
  );

  // Don't spend future prompt budget on routine all-green loads.
  if (hasPattern) {
    const subject = `${objectApiName} ${operation} load outcome`;
    let summary = sfFailed
      ? `Load failed before processing. SF error: ${result.sfErrorMessage}. ${rowCount} rows attempted.`
      : `Loaded ${succeeded}/${rowCount} rows. ${failed > 0 ? `${failed} failed.` : 'All succeeded with warnings/patterns.'}`;

    if (result.errors?.length) {
      const topErrors = [...new Set(result.errors.map(e => e.error?.split(':')[0]).filter(Boolean))].slice(0, 3);
      summary += ` Top errors: ${topErrors.join(', ')}.`;
    }

    await remember({
      userId, orgId, type: 'bulk_load_event', subject,
      content: summary,
      keywords: extractKeywords(objectApiName, operation, result.sfErrorMessage, ...(result.errors?.map(e => e.error) || [])),
      importance: sfFailed ? 5 : (failed > 0 ? 4 : 3),
      metadata: { succeeded, failed, rowCount, sfJobState: result.sfJobState, lastJobId: result.jobId },
    });
  }

  // 2. Error → fix memories (one per unique error code)
  if (result.errors?.length) {
    const byCode = {};
    for (const e of result.errors) {
      const code = e.error?.split(':')[0] || 'UNKNOWN_ERROR';
      if (!byCode[code]) byCode[code] = { count: 0, sample: e.error };
      byCode[code].count++;
    }
    for (const [code, info] of Object.entries(byCode)) {
      await remember({
        userId, orgId, type: 'error_fix',
        subject: `${code} on ${objectApiName} ${operation}`,
        content: `${info.count} rows failed with ${code} during ${objectApiName} ${operation}. Sample: "${info.sample}". Check field values and duplicate rules before next run.`,
        keywords: extractKeywords(code, objectApiName, operation),
        importance: 4,
        metadata: { errorCode: code, count: info.count, objectApiName, operation },
      });
    }
  }

  // 3. SF-level job failure
  if (sfFailed && result.sfErrorMessage) {
    await remember({
      userId, orgId, type: 'error_fix',
      subject: `SF job failure on ${objectApiName}`,
      content: `Salesforce rejected the bulk job before processing any rows. Error: "${result.sfErrorMessage}". This is usually a CSV format issue (line endings, encoding) or auth problem.`,
      keywords: extractKeywords(result.sfErrorMessage, objectApiName, 'job failed line ending'),
      importance: 5,
      metadata: { sfErrorMessage: result.sfErrorMessage, objectApiName, operation },
    });
  }

  // 4. Read-only field warnings from preflight
  const readOnlyFields = preflight?.warnings?.find(w => w.code === 'READ_ONLY_FIELDS')?.fields || [];
  if (readOnlyFields.length) {
    await remember({
      userId, orgId, type: 'migration_pattern',
      subject: `Read-only fields on ${objectApiName} ${operation}`,
      content: `These fields are read-only for ${operation} and will be ignored or cause errors: ${readOnlyFields.join(', ')}. Strip them from the CSV before upload.`,
      keywords: extractKeywords(objectApiName, operation, ...readOnlyFields, 'read only field'),
      importance: 4,
      metadata: { readOnlyFields, objectApiName, operation },
    });
  }

  // 5. Self-referential pattern
  const selfRef = preflight?.warnings?.find(w => w.code === 'SELF_REFERENTIAL_OBJECT');
  if (selfRef) {
    await remember({
      userId, orgId, type: 'migration_pattern',
      subject: `${objectApiName} requires 2-pass load`,
      content: selfRef.action,
      keywords: extractKeywords(objectApiName, 'self referential two pass parent'),
      importance: 4,
      metadata: { objectApiName, pattern: 'two_pass' },
    });
  }
}

/**
 * List all memories for a user (for the UI memory panel).
 */
async function listMemories({ userId, orgId, type, limit = 50 }) {
  try {
    let q = supabase
      .from(TABLE)
      .select('id, type, subject, content, importance, access_count, created_at, metadata')
      .eq('user_id', userId)
      .order('importance', { ascending: false })
      .order('last_accessed', { ascending: false })
      .limit(limit);

    if (orgId) q = q.eq('org_id', orgId);
    if (type)  q = q.eq('type', type);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  } catch (err) {
    if (!isMissingBrainTableError(err)) {
      console.warn('[brain] listMemories failed:', err.message);
    }
    return [];
  }
}

/**
 * Delete a specific memory (user can forget things from the UI).
 */
async function forget({ memoryId, userId }) {
  try {
    await supabase.from(TABLE).delete().eq('id', memoryId).eq('user_id', userId);
  } catch (err) {
    if (!isMissingBrainTableError(err)) {
      console.warn('[brain] forget failed:', err.message);
    }
  }
}

module.exports = {
  remember,
  recall,
  buildContext,
  rememberBulkLoad,
  rememberDeployFailure,
  listMemories,
  forget,
  extractKeywords,
  normalizeErrorSignature,
};
