'use strict';

/**
 * routes/copilot.js
 *
 * Command layer for OrgIQ. This route classifies a user's plain-English admin
 * request into a canonical Copilot Plan. It does not execute Salesforce work.
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const anthropic = new Anthropic();

const MODULES = {
  generator: {
    route: '/generator',
    orgRoleRequired: 'target',
    intents: ['create_flow', 'edit_flow', 'create_report', 'create_validation_rule', 'create_permission_set', 'create_apex'],
  },
  objects: {
    route: '/objects',
    orgRoleRequired: 'target',
    intents: ['create_object', 'edit_object', 'add_object_field', 'create_object_tab'],
  },
  users: {
    route: '/users',
    orgRoleRequired: 'target',
    intents: ['create_user', 'bulk_create_users', 'deactivate_user', 'assign_user_permissions', 'clone_user_access'],
  },
  migrations: {
    route: '/migrations/new',
    orgRoleRequired: 'source_and_target',
    intents: ['data_load', 'data_migration', 'csv_upsert', 'csv_insert', 'csv_update'],
  },
  permissions: {
    route: '/permissions',
    orgRoleRequired: 'target',
    intents: ['manage_permissions', 'create_permission_set', 'assign_permission_set', 'profile_access'],
  },
  mapping_sheet: {
    route: '/mapping-sheet',
    orgRoleRequired: 'target',
    intents: ['mapping_sheet_analysis', 'field_gap_analysis', 'create_missing_fields'],
  },
  reports: {
    route: '/reports',
    orgRoleRequired: 'target',
    intents: ['run_report', 'review_report_history'],
  },
};

const VALID_MODULES = new Set(Object.keys(MODULES));
const VALID_RISKS = new Set(['low', 'medium', 'high', 'critical']);

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Copilot returned non-JSON response');
    return JSON.parse(match[0]);
  }
}

function normalizePlan(raw, originalPrompt, userId) {
  const targetModule = VALID_MODULES.has(raw.target_module) ? raw.target_module : 'generator';
  const moduleCfg = MODULES[targetModule];
  const confidence = Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0.5;
  const riskLevel = VALID_RISKS.has(raw.risk_level) ? raw.risk_level : 'medium';
  const highRisk = ['high', 'critical'].includes(riskLevel);

  return {
    plan_id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    user_id: userId,
    original_prompt: originalPrompt,
    intent_type: String(raw.intent_type || 'unknown_admin_request'),
    target_module: targetModule,
    suggested_route: moduleCfg.route,
    confidence,
    risk_level: riskLevel,
    org_role_required: raw.org_role_required || moduleCfg.orgRoleRequired,
    interpreted_summary: String(raw.interpreted_summary || 'Review this Salesforce admin request.'),
    reason: String(raw.reason || 'Matched request to the closest Salesforce admin workspace.'),
    extracted_data: raw.extracted_data && typeof raw.extracted_data === 'object' ? raw.extracted_data : {},
    missing_info: Array.isArray(raw.missing_info) ? raw.missing_info.slice(0, 8) : [],
    alternative_intents: Array.isArray(raw.alternative_intents) ? raw.alternative_intents.slice(0, 5) : [],
    blocked_until_answered: Boolean(raw.blocked_until_answered),
    requires_human_approval: true,
    needs_confirmation: highRisk || confidence < 0.85 || Boolean(raw.needs_confirmation),
    status: 'draft',
    created_at: new Date().toISOString(),
  };
}

function heuristicPlan(prompt, userId) {
  const text = prompt.toLowerCase();
  let targetModule = 'generator';
  let intentType = 'create_metadata';
  let riskLevel = 'medium';

  if (/\b(object|field|tab|custom object|lookup|master-detail)\b/.test(text)) {
    targetModule = 'objects';
    intentType = /\bfield\b/.test(text) ? 'add_object_field' : 'create_object';
  } else if (/\b(user|users|profile|role|permission set assignment|deactivate|mirror|clone access)\b/.test(text)) {
    targetModule = 'users';
    intentType = /\bdeactivate\b/.test(text) ? 'deactivate_user' : 'create_user';
    riskLevel = 'high';
  } else if (/\b(csv|load|upsert|insert records|update records|migration|migrate)\b/.test(text)) {
    targetModule = 'migrations';
    intentType = 'data_load';
    riskLevel = 'high';
  } else if (/\b(permission|access|fls|profile access)\b/.test(text)) {
    targetModule = 'permissions';
    intentType = 'manage_permissions';
    riskLevel = 'high';
  } else if (/\b(mapping|gap analysis|missing fields)\b/.test(text)) {
    targetModule = 'mapping_sheet';
    intentType = 'mapping_sheet_analysis';
  } else if (/\breport\b/.test(text)) {
    targetModule = 'generator';
    intentType = 'create_report';
  } else if (/\bflow|validation rule|apex|trigger\b/.test(text)) {
    targetModule = 'generator';
    intentType = /\bflow\b/.test(text) ? 'create_flow' : 'create_metadata';
    riskLevel = /\bflow|apex|trigger\b/.test(text) ? 'high' : 'medium';
  }

  return normalizePlan({
    intent_type: intentType,
    target_module: targetModule,
    confidence: 0.68,
    risk_level: riskLevel,
    interpreted_summary: prompt.slice(0, 160),
    reason: 'Local classifier matched keywords while AI classification was unavailable.',
    extracted_data: {},
    missing_info: [],
    alternative_intents: [],
    needs_confirmation: true,
  }, prompt, userId);
}

router.post('/intent', requireAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (prompt.length < 8) {
      return res.status(400).json({ error: 'Describe the Salesforce admin work you want to do.' });
    }
    if (prompt.length > 4000) {
      return res.status(400).json({ error: 'Prompt is too long. Keep it under 4,000 characters.' });
    }

    const system = `You are the OrgIQ command router for Salesforce admins, PMs, business owners, and developers.

Create a draft Copilot Plan only. Do not execute work. Do not generate Salesforce XML. Do not decide final deployment behavior.

Available target modules:
- generator: flows, reports, validation rules, permission sets, Apex, metadata generation/editing
- objects: custom objects, fields, relationships, tabs, object profile access
- users: create users, deactivate users, clone/mirror user access, assign permission sets
- migrations: CSV data load, insert/update/upsert, source-to-target migration
- permissions: permission set/profile access work not tied to object creation
- mapping_sheet: uploaded mapping sheet analysis, missing field gap analysis
- reports: running or reviewing existing reports only

Risk rules:
- low: read-only analysis, documentation, report viewing
- medium: create report, validation rule, object draft, generated metadata before deploy
- high: flow, Apex, permission changes, user changes, data load, production metadata deploy
- critical: delete/destructive work, bulk production updates, irreversible operations

Return strict JSON with:
intent_type, target_module, confidence, risk_level, org_role_required, interpreted_summary, reason,
extracted_data, missing_info, alternative_intents, blocked_until_answered, needs_confirmation.

If ambiguous, lower confidence and include alternative_intents. High-risk and critical actions require confirmation.`;

    let plan;
    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content?.map(part => part.text || '').join('\n').trim() || '{}';
      plan = normalizePlan(safeJsonParse(text), prompt, req.user.id);
    } catch (err) {
      plan = heuristicPlan(prompt, req.user.id);
      plan.router_warning = `AI classification unavailable: ${err.message}`;
    }

    res.json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
