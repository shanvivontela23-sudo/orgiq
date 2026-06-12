'use strict';

/**
 * routes/permissions.js
 *
 * Permission Set Management — PRM-01 to PRM-03
 */

const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { withSalesforceClient } = require('../middleware/withSalesforceClient');
const { withRateLimit } = require('../lib/rateLimiter');
const { deployArtifact } = require('../lib/metadataDeployer');
const supabase = require('../lib/supabase');

const router = express.Router();
const SF_API = '/services/data/v62.0';

function toApiName(label = '') {
  const normalized = label.trim()
    .replace(/[^a-zA-Z0-9 _]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return /^[A-Za-z]/.test(normalized) ? normalized : `X${normalized}`;
}

function escapeXml(v = '') {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function bool(v) {
  return v ? 'true' : 'false';
}

function buildPermissionSetXml({ label, description, license, objectPermissions = [], fieldPermissions = [] }) {
  const objectBlocks = objectPermissions
    .filter(p => p.object)
    .map(p => `  <objectPermissions>
    <allowCreate>${bool(p.create)}</allowCreate>
    <allowDelete>${bool(p.delete)}</allowDelete>
    <allowEdit>${bool(p.edit)}</allowEdit>
    <allowRead>${bool(p.read || p.create || p.edit || p.delete || p.viewAll || p.modifyAll)}</allowRead>
    <modifyAllRecords>${bool(p.modifyAll)}</modifyAllRecords>
    <object>${escapeXml(p.object)}</object>
    <viewAllRecords>${bool(p.viewAll || p.modifyAll)}</viewAllRecords>
  </objectPermissions>`)
    .join('\n');

  const fieldBlocks = fieldPermissions
    .filter(p => p.field)
    .map(p => `  <fieldPermissions>
    <editable>${bool(p.editable)}</editable>
    <field>${escapeXml(p.field)}</field>
    <readable>${bool(p.readable || p.editable)}</readable>
  </fieldPermissions>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>${escapeXml(description || `Created by SF Copilot for ${label}`)}</description>
  <hasActivationRequired>false</hasActivationRequired>
  <label>${escapeXml(label)}</label>
${license ? `  <license>${escapeXml(license)}</license>\n` : ''}${objectBlocks ? `${objectBlocks}\n` : ''}${fieldBlocks ? `${fieldBlocks}\n` : ''}</PermissionSet>`;
}

async function recordPermissionOp({ userId, orgId, label, status, detail, counts = { total: 1, succeeded: 1, failed: 0 }, errors = [] }) {
  try {
    const now = new Date().toISOString();
    await supabase.from('migration_jobs').insert({
      id:             `perm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      user_id:        userId,
      source_org_id:  orgId,
      target_org_id:  orgId,
      mapping_config: { jobType: 'permission', label, detail },
      is_dry_run:     false,
      status,
      current_phase:  1,
      phase_name:     label,
      record_counts:  counts,
      error_summary:  errors.length ? { errors: errors.slice(0, 20) } : null,
      started_at:     now,
      completed_at:   now,
      created_at:     now,
    });
  } catch {
    // Audit write should not fail the admin action.
  }
}

router.get('/objects', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const response = await req.sf.fetch(`${SF_API}/sobjects`);
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.message || 'Could not load objects' });

    const objects = (data.sobjects || [])
      .filter(o => o.queryable && !o.deprecatedAndHidden)
      .map(o => ({
        apiName: o.name,
        label: o.label,
        custom: o.custom,
        createable: o.createable,
        updateable: o.updateable,
        deletable: o.deletable,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, 500);

    res.json({ objects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/fields', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const objectApiName = String(req.query.objectApiName || '').trim();
    if (!objectApiName) return res.status(400).json({ error: 'objectApiName is required' });

    const response = await req.sf.fetch(`${SF_API}/sobjects/${encodeURIComponent(objectApiName)}/describe`);
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data?.message || `Could not describe ${objectApiName}` });

    const fields = (data.fields || [])
      .filter(f => !f.deprecatedAndHidden)
      .map(f => ({
        apiName: f.name,
        label: f.label,
        type: f.type,
        readable: true,
        editable: f.updateable,
        createable: f.createable,
        custom: f.custom,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    res.json({ objectApiName, fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create', requireAuth, withRateLimit('permission_create', 3), withSalesforceClient, async (req, res) => {
  try {
    const {
      label,
      apiName,
      description = '',
      license = '',
      objectPermissions = [],
      fieldPermissions = [],
    } = req.body || {};

    if (!label?.trim()) return res.status(400).json({ error: 'Permission set label is required' });
    const cleanApiName = toApiName(apiName || label);
    const artifactXml = buildPermissionSetXml({
      label: label.trim(),
      description,
      license,
      objectPermissions,
      fieldPermissions,
    });

    const check = await deployArtifact({
      artifactXml,
      artifactType: 'permissionSet',
      apiName: cleanApiName,
      sfClient: req.sf,
      checkOnly: true,
    });
    if (!check.success) {
      await recordPermissionOp({
        userId: req.user.id,
        orgId: req.orgConn.id,
        label: `Create permission set ${cleanApiName}`,
        status: 'failed',
        detail: { apiName: cleanApiName, checkOnly: true },
        counts: { total: 1, succeeded: 0, failed: 1 },
        errors: check.errors || [{ message: check.error?.message || 'checkOnly failed' }],
      });
      return res.status(400).json({
        error: check.error?.message || 'Permission set failed dry run.',
        errors: check.errors,
        checkOnly: true,
      });
    }

    const deploy = await deployArtifact({
      artifactXml,
      artifactType: 'permissionSet',
      apiName: cleanApiName,
      sfClient: req.sf,
      checkOnly: false,
    });
    if (!deploy.success) {
      await recordPermissionOp({
        userId: req.user.id,
        orgId: req.orgConn.id,
        label: `Create permission set ${cleanApiName}`,
        status: 'failed',
        detail: { apiName: cleanApiName },
        counts: { total: 1, succeeded: 0, failed: 1 },
        errors: deploy.errors || [{ message: deploy.error?.message || 'deploy failed' }],
      });
      return res.status(400).json({ error: deploy.error?.message || 'Permission set deploy failed.', errors: deploy.errors });
    }

    await recordPermissionOp({
      userId: req.user.id,
      orgId: req.orgConn.id,
      label: `Create permission set ${cleanApiName}`,
      status: 'completed',
      detail: {
        apiName: cleanApiName,
        objectPermissions: objectPermissions.length,
        fieldPermissions: fieldPermissions.length,
      },
    });

    res.status(201).json({
      apiName: cleanApiName,
      label: label.trim(),
      deployId: deploy.asyncId,
      setupUrl: `${req.orgConn.instance_url}/lightning/setup/PermSets/page?address=%2F${cleanApiName}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
