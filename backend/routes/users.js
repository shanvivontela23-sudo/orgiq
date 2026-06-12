'use strict';

/**
 * routes/users.js
 *
 * Salesforce User Management — USR-01 to USR-04
 *
 * POST /api/users/create              — create a single user
 * POST /api/users/bulk-create         — bulk create users from CSV rows
 * POST /api/users/deactivate          — bulk deactivate users
 * POST /api/users/assign-permissions  — assign permission sets to users
 * GET  /api/users/search              — search users in the org
 * GET  /api/users/profiles            — list active profiles
 * GET  /api/users/roles               — list roles
 * GET  /api/users/permission-sets     — list permission sets
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const xlsx     = require('xlsx');
const axios    = require('axios');

const { requireAuth }          = require('../middleware/auth');
const { withSalesforceClient } = require('../middleware/withSalesforceClient');
const { withRateLimit }        = require('../lib/rateLimiter');
const supabase                 = require('../lib/supabase');
const { runBulkDataLoad }      = require('../lib/bulkApi');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const SF_API = '/services/data/v62.0';

// ── Helpers ───────────────────────────────────────────────────────────────────

function autoAlias(first = '', last = '') {
  return (first.charAt(0) + last).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
}

/**
 * Infer username from org's existing naming convention.
 * Queries an existing user, extracts their username domain suffix,
 * applies it to the new user's email local part.
 * e.g. existing: john.doe@company.com.sandbox → new: jane.smith@company.com.sandbox
 */
async function inferUsername(sf, email) {
  try {
    const result = await sf.query(
      `SELECT Username FROM User WHERE IsActive = true AND UserType = 'Standard' ORDER BY CreatedDate DESC LIMIT 1`
    );
    const existing = result.records?.[0]?.Username;
    if (!existing || !existing.includes('@')) return fallbackUsername(email);

    // Extract everything from @ onwards — this is the org's domain convention
    const domainSuffix = existing.slice(existing.indexOf('@')); // e.g. "@company.com.sandbox"
    const localPart = (email.split('@')[0] || 'user')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '.');

    return `${localPart}${domainSuffix}`;
  } catch {
    return fallbackUsername(email);
  }
}

function fallbackUsername(email = '') {
  const [local, domain] = email.split('@');
  return `${local || 'user'}.${Date.now()}@${domain || 'sfcopilot.app'}`;
}

// Sync username generator for bulk-create (no SF query available per-row).
// Appends timestamp to guarantee uniqueness across the batch.
function autoUsername(email = '') {
  const [local, domain] = email.split('@');
  const clean = (local || 'user').toLowerCase().replace(/[^a-z0-9._-]/g, '.');
  return `${clean}.${Date.now()}@${domain || 'sfcopilot.app'}`;
}

async function sfPost(sf, path, body) {
  const res = await sf.fetch(`${SF_API}${path}`, { method: 'POST', body });
  const json = await res.json();
  return { ok: res.ok, status: res.status, data: json };
}

async function sfGet(sf, path) {
  const res = await sf.fetch(`${SF_API}${path}`);
  const json = await res.json();
  return { ok: res.ok, data: json };
}

/**
 * Fetch full mirror user config: profile, role, permission sets, groups, queues, locale settings.
 */
async function fetchMirrorUser(sf, userId) {
  const [userRes, psRes, groupRes] = await Promise.all([
    sf.query(
      `SELECT Id, Name, Email, Username, ProfileId, Profile.Name, UserRoleId, UserRole.Name,
              TimeZoneSidKey, LocaleSidKey, LanguageLocaleKey, EmailEncodingKey, IsActive
       FROM User WHERE Id = '${userId}' LIMIT 1`
    ),
    sf.query(
      `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.Name
       FROM PermissionSetAssignment
       WHERE AssigneeId = '${userId}' AND PermissionSet.IsOwnedByProfile = false`
    ),
    sf.query(
      `SELECT GroupId, Group.Name, Group.Type
       FROM GroupMember WHERE UserOrGroupId = '${userId}'`
    ),
  ]);

  const user = userRes.records?.[0];
  if (!user) return null;

  const permissionSets = (psRes.records || []).map(r => ({
    id:    r.PermissionSetId,
    label: r.PermissionSet?.Label,
    name:  r.PermissionSet?.Name,
  }));

  const groups = (groupRes.records || [])
    .filter(r => r.Group?.Type === 'Regular')
    .map(r => ({ id: r.GroupId, name: r.Group?.Name }));

  const queues = (groupRes.records || [])
    .filter(r => r.Group?.Type === 'Queue')
    .map(r => ({ id: r.GroupId, name: r.Group?.Name }));

  return {
    id:                user.Id,
    name:              user.Name,
    email:             user.Email,
    username:          user.Username,
    profileId:         user.ProfileId,
    profileName:       user.Profile?.Name,
    roleId:            user.UserRoleId || null,
    roleName:          user.UserRole?.Name || null,
    timeZoneSidKey:    user.TimeZoneSidKey,
    localeSidKey:      user.LocaleSidKey,
    languageLocaleKey: user.LanguageLocaleKey,
    emailEncodingKey:  user.EmailEncodingKey,
    permissionSets,
    groups,
    queues,
  };
}

async function recordAdminOp({ userId, orgId, jobType, label, status, result, detail }) {
  try {
    const now = new Date().toISOString();
    await supabase.from('migration_jobs').insert({
      id:             `admin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      user_id:        userId,
      source_org_id:  orgId,
      target_org_id:  orgId,
      mapping_config: { jobType, label, detail },
      is_dry_run:     false,
      status,
      current_phase:  1,
      phase_name:     label,
      record_counts:  result?.counts || { total: 0, succeeded: 0, failed: 0 },
      error_summary:  result?.errors?.length ? { errors: result.errors.slice(0, 20) } : null,
      started_at:     now,
      completed_at:   now,
      created_at:     now,
    });
  } catch { /* non-critical audit — never fail the main op */ }
}

// ── GET /api/users/profiles ───────────────────────────────────────────────────
router.get('/profiles', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const result = await req.sf.query(
      `SELECT Id, Name, UserType FROM Profile WHERE UserType IN ('Standard','PowerPartner','CsnOnly') ORDER BY Name ASC LIMIT 200`
    );
    res.json({ profiles: (result.records || []).map(p => ({ id: p.Id, name: p.Name, userType: p.UserType })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/roles ──────────────────────────────────────────────────────
router.get('/roles', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const result = await req.sf.query(
      `SELECT Id, Name, DeveloperName FROM UserRole ORDER BY Name ASC LIMIT 500`
    );
    res.json({ roles: (result.records || []).map(r => ({ id: r.Id, name: r.Name })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/permission-sets ────────────────────────────────────────────
router.get('/permission-sets', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const result = await req.sf.query(
      `SELECT Id, Name, Label, Description FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label ASC LIMIT 300`
    );
    res.json({
      permissionSets: (result.records || []).map(p => ({
        id: p.Id, name: p.Name, label: p.Label, description: p.Description,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/mirror ─────────────────────────────────────────────────────
// Search for a mirror user + return their full config to replicate
router.get('/mirror', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const { q = '' } = req.query;
    if (!q.trim()) return res.status(400).json({ error: 'q (name or email) is required' });

    const safe = q.replace(/'/g, "\\'");
    const result = await req.sf.query(
      `SELECT Id, Name, Email, Username, IsActive, Profile.Name, UserRole.Name
       FROM User
       WHERE IsActive = true
       AND UserType IN ('Standard', 'PowerPartner', 'CsnOnly')
       AND (Name LIKE '%${safe}%' OR Email LIKE '%${safe}%' OR Username LIKE '%${safe}%')
       ORDER BY Name ASC LIMIT 10`
    );

    res.json({
      users: (result.records || []).map(u => ({
        id:       u.Id,
        name:     u.Name,
        email:    u.Email,
        username: u.Username,
        profile:  u.Profile?.Name,
        role:     u.UserRole?.Name,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/mirror/:id ─────────────────────────────────────────────────
// Full mirror user config — profile, role, permission sets, groups, queues
router.get('/mirror/:id', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const mirror = await fetchMirrorUser(req.sf, req.params.id);
    if (!mirror) return res.status(404).json({ error: 'User not found' });
    res.json({ mirror });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/suggest-username ──────────────────────────────────────────
router.get('/suggest-username', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const { email = '' } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const username = await inferUsername(req.sf, email);
    res.json({ username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/users/search ─────────────────────────────────────────────────────
router.get('/search', requireAuth, withSalesforceClient, async (req, res) => {
  try {
    const { q = '', active } = req.query;
    const safe = q.replace(/'/g, "\\'");
    const activeClause = active === 'true' ? 'AND IsActive = true'
      : active === 'false' ? 'AND IsActive = false' : '';

    const nameFilter = safe
      ? `AND (Name LIKE '%${safe}%' OR Email LIKE '%${safe}%' OR Username LIKE '%${safe}%')`
      : '';

    const result = await req.sf.query(
      `SELECT Id, Name, Email, Username, IsActive, Profile.Name, UserRole.Name, LastLoginDate
       FROM User
       WHERE UserType IN ('Standard', 'PowerPartner', 'CsnOnly')
       ${activeClause} ${nameFilter}
       ORDER BY Name ASC LIMIT 100`
    );

    res.json({
      users: (result.records || []).map(u => ({
        id:          u.Id,
        name:        u.Name,
        email:       u.Email,
        username:    u.Username,
        isActive:    u.IsActive,
        profile:     u.Profile?.Name,
        role:        u.UserRole?.Name,
        lastLogin:   u.LastLoginDate,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users/create ────────────────────────────────────────────────────
// Supports two modes:
//   1. Mirror mode: { mirrorUserId, firstName, lastName, email } — clones everything from mirror user
//   2. Manual mode: { firstName, lastName, email, profileId, roleId, ... }
router.post('/create', requireAuth, withRateLimit('user_create', 3), withSalesforceClient, async (req, res) => {
  const { firstName, lastName, email, mirrorUserId } = req.body;

  if (!lastName || !email) {
    return res.status(400).json({ error: 'lastName and email are required' });
  }

  try {
    let config;

    // ── MIRROR MODE ──────────────────────────────────────────────────────────
    if (mirrorUserId) {
      const mirror = await fetchMirrorUser(req.sf, mirrorUserId);
      if (!mirror) return res.status(404).json({ error: 'Mirror user not found in org' });
      config = {
        profileId:         mirror.profileId,
        roleId:            mirror.roleId,
        timeZoneSidKey:    mirror.timeZoneSidKey,
        localeSidKey:      mirror.localeSidKey,
        languageLocaleKey: mirror.languageLocaleKey,
        emailEncodingKey:  mirror.emailEncodingKey,
        permissionSetIds:  mirror.permissionSets.map(p => p.id),
        groupIds:          mirror.groups.map(g => g.id),
        queueIds:          mirror.queues.map(q => q.id),
      };
    } else {
      // ── MANUAL MODE ────────────────────────────────────────────────────────
      const {
        profileId, roleId,
        timeZoneSidKey    = 'America/Los_Angeles',
        localeSidKey      = 'en_US',
        languageLocaleKey = 'en_US',
        emailEncodingKey  = 'UTF-8',
        permissionSetIds  = [],
      } = req.body;

      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required when no mirrorUserId is provided' });
      }
      config = { profileId, roleId, timeZoneSidKey, localeSidKey, languageLocaleKey, emailEncodingKey, permissionSetIds, groupIds: [], queueIds: [] };
    }

    // Infer username from org's naming convention
    const username = await inferUsername(req.sf, email);
    const alias    = autoAlias(firstName, lastName);

    const payload = {
      FirstName:         firstName || '',
      LastName:          lastName,
      Email:             email,
      Username:          username,
      Alias:             alias,
      ProfileId:         config.profileId,
      TimeZoneSidKey:    config.timeZoneSidKey,
      LocaleSidKey:      config.localeSidKey,
      LanguageLocaleKey: config.languageLocaleKey,
      EmailEncodingKey:  config.emailEncodingKey,
    };
    if (config.roleId) payload.UserRoleId = config.roleId;

    // Create the user
    const { ok, status, data } = await sfPost(req.sf, '/sobjects/User', payload);
    if (!ok) {
      const sfError = Array.isArray(data) ? data[0]?.message : data?.message || JSON.stringify(data);
      await recordAdminOp({
        userId: req.user.id, orgId: req.orgConn.id,
        jobType: 'user_create', label: `Create user ${email}`,
        status: 'failed', result: { errors: [{ error: sfError }] },
      });
      return res.status(422).json({ error: sfError, sfStatus: status });
    }

    const newUserId = data.id;
    const postErrors = [];

    // Assign permission sets (mirror or manual)
    if (config.permissionSetIds?.length) {
      try {
        const csvLines = ['AssigneeId,PermissionSetId',
          ...config.permissionSetIds.map(psId => `${newUserId},${psId}`)];
        const { runBulkDataLoad } = require('../lib/bulkApi');
        await runBulkDataLoad({
          instanceUrl: req.orgConn.instance_url,
          accessToken: req.orgConn.access_token,
          objectApiName: 'PermissionSetAssignment',
          operation: 'insert',
          csvData: csvLines.join('\n'),
        });
      } catch (psErr) {
        postErrors.push(`Permission sets: ${psErr.message}`);
      }
    }

    // Add to public groups (mirror only)
    for (const groupId of (config.groupIds || [])) {
      try {
        await sfPost(req.sf, '/sobjects/GroupMember', { GroupId: groupId, UserOrGroupId: newUserId });
      } catch (gErr) {
        postErrors.push(`Group ${groupId}: ${gErr.message}`);
      }
    }

    // Add to queues (mirror only)
    for (const queueId of (config.queueIds || [])) {
      try {
        await sfPost(req.sf, '/sobjects/GroupMember', { GroupId: queueId, UserOrGroupId: newUserId });
      } catch (qErr) {
        postErrors.push(`Queue ${queueId}: ${qErr.message}`);
      }
    }

    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'user_create',
      label: mirrorUserId ? `Create user ${email} (mirror of ${mirrorUserId})` : `Create user ${email}`,
      status: 'completed',
      result: { counts: { total: 1, succeeded: 1, failed: 0 } },
      detail: { newUserId, email, username, mirrorUserId: mirrorUserId || null, postErrors },
    });

    res.status(201).json({
      userId:       newUserId,
      username,
      alias,
      setupUrl:     `${req.orgConn.instance_url}/lightning/setup/ManageUsers/page?address=%2F${newUserId}`,
      postErrors,   // non-fatal — user created, some post-steps may have failed
      mirrored:     !!mirrorUserId,
      permSetsAssigned: config.permissionSetIds?.length || 0,
      groupsAdded:  config.groupIds?.length || 0,
      queuesAdded:  config.queueIds?.length || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users/bulk-create ───────────────────────────────────────────────
router.post('/bulk-create', requireAuth, withRateLimit('user_bulk', 1), upload.single('file'), withSalesforceClient, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  try {
    // Parse CSV/XLSX
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let rows;
    if (ext === 'xlsx' || ext === 'xls') {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } else {
      const text = req.file.buffer.toString('utf8');
      const lines = text.trim().split('\n').filter(Boolean);
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      rows = lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']));
      });
    }

    if (!rows.length) return res.status(400).json({ error: 'File has no data rows' });

    // Resolve profile names → IDs
    const profileNames = [...new Set(rows.map(r => r.ProfileName || r.Profile).filter(Boolean))];
    let profileMap = {};
    if (profileNames.length) {
      const safeNames = profileNames.map(n => `'${n.replace(/'/g, "\\'")}'`).join(',');
      const profileRes = await req.sf.query(`SELECT Id, Name FROM Profile WHERE Name IN (${safeNames})`);
      (profileRes.records || []).forEach(p => { profileMap[p.Name] = p.Id; });
    }

    // Resolve role names → IDs
    const roleNames = [...new Set(rows.map(r => r.RoleName || r.Role).filter(Boolean))];
    let roleMap = {};
    if (roleNames.length) {
      const safeNames = roleNames.map(n => `'${n.replace(/'/g, "\\'")}'`).join(',');
      const roleRes = await req.sf.query(`SELECT Id, Name FROM UserRole WHERE Name IN (${safeNames})`);
      (roleRes.records || []).forEach(r => { roleMap[r.Name] = r.Id; });
    }

    // Validate & build CSV for Bulk API
    const errors = [];
    const csvRows = ['FirstName,LastName,Email,Username,Alias,ProfileId,UserRoleId,TimeZoneSidKey,LocaleSidKey,LanguageLocaleKey,EmailEncodingKey'];

    rows.forEach((row, i) => {
      const rowNum = i + 2;
      const lastName  = row.LastName  || row.last_name  || '';
      const firstName = row.FirstName || row.first_name || '';
      const email     = row.Email     || row.email      || '';
      const profileName = row.ProfileName || row.Profile || '';
      const profileId   = profileMap[profileName] || row.ProfileId || '';
      const roleName    = row.RoleName || row.Role || '';
      const roleId      = roleMap[roleName] || row.RoleId || '';

      if (!lastName)    { errors.push({ row: rowNum, error: 'LastName is required' }); return; }
      if (!email)       { errors.push({ row: rowNum, error: 'Email is required' }); return; }
      if (!profileId)   { errors.push({ row: rowNum, error: `Profile "${profileName}" not found in org` }); return; }

      const alias    = autoAlias(firstName, lastName);
      const username = autoUsername(email);
      const tz       = row.TimeZoneSidKey    || 'America/Los_Angeles';
      const locale   = row.LocaleSidKey      || 'en_US';
      const lang     = row.LanguageLocaleKey || 'en_US';
      const enc      = row.EmailEncodingKey  || 'UTF-8';

      csvRows.push(`${firstName},${lastName},${email},${username},${alias},${profileId},${roleId},${tz},${locale},${lang},${enc}`);
    });

    if (errors.length === rows.length) {
      return res.status(422).json({ error: 'All rows have validation errors', errors });
    }

    const csvData = csvRows.join('\n');
    const result = await runBulkDataLoad({
      instanceUrl: req.orgConn.instance_url,
      accessToken: req.orgConn.access_token,
      objectApiName: 'User',
      operation: 'insert',
      csvData,
    });

    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'user_create', label: `Bulk create users (${rows.length} rows)`,
      status: result.failed === csvRows.length - 1 ? 'failed' : 'completed',
      result: {
        counts: { total: result.total, succeeded: result.succeeded, failed: result.failed },
        errors: result.errors,
      },
    });

    res.json({
      total:      result.total,
      succeeded:  result.succeeded,
      failed:     result.failed,
      errors:     result.errors,
      validationErrors: errors,
      succeededCsv: result.succeededCsv,
      failedCsv:    result.failedCsv,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users/deactivate ────────────────────────────────────────────────
router.post('/deactivate', requireAuth, withRateLimit('user_deactivate', 2), withSalesforceClient, async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || !userIds.length) {
    return res.status(400).json({ error: 'userIds array is required' });
  }

  try {
    // Build CSV for Bulk API update: Id,IsActive
    const csvLines = ['Id,IsActive', ...userIds.map(id => `${id},false`)];
    const result = await runBulkDataLoad({
      instanceUrl:   req.orgConn.instance_url,
      accessToken:   req.orgConn.access_token,
      objectApiName: 'User',
      operation:     'update',
      csvData:       csvLines.join('\n'),
    });

    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'user_create', label: `Deactivate ${userIds.length} user(s)`,
      status: result.failed > 0 && result.succeeded === 0 ? 'failed' : 'completed',
      result: {
        counts: { total: result.total, succeeded: result.succeeded, failed: result.failed },
        errors: result.errors,
      },
    });

    res.json({
      total:     result.total,
      succeeded: result.succeeded,
      failed:    result.failed,
      errors:    result.errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/users/assign-permissions ────────────────────────────────────────
router.post('/assign-permissions', requireAuth, withRateLimit('user_permissions', 3), withSalesforceClient, async (req, res) => {
  const { userIds, permissionSetIds } = req.body;
  if (!Array.isArray(userIds) || !userIds.length)          return res.status(400).json({ error: 'userIds is required' });
  if (!Array.isArray(permissionSetIds) || !permissionSetIds.length) return res.status(400).json({ error: 'permissionSetIds is required' });

  try {
    // Check existing assignments to skip duplicates
    const safeUserIds = userIds.map(id => `'${id}'`).join(',');
    const safePsIds   = permissionSetIds.map(id => `'${id}'`).join(',');
    const existing = await req.sf.query(
      `SELECT AssigneeId, PermissionSetId FROM PermissionSetAssignment
       WHERE AssigneeId IN (${safeUserIds}) AND PermissionSetId IN (${safePsIds})`
    );
    const alreadyAssigned = new Set(
      (existing.records || []).map(r => `${r.AssigneeId}::${r.PermissionSetId}`)
    );

    // Build CSV for Bulk API insert on PermissionSetAssignment
    const csvLines = ['AssigneeId,PermissionSetId'];
    let skipped = 0;
    for (const uid of userIds) {
      for (const psId of permissionSetIds) {
        if (alreadyAssigned.has(`${uid}::${psId}`)) { skipped++; continue; }
        csvLines.push(`${uid},${psId}`);
      }
    }

    const toAssign = csvLines.length - 1;
    if (toAssign === 0) {
      return res.json({ total: 0, succeeded: 0, failed: 0, skipped, errors: [], message: 'All assignments already exist — nothing to do.' });
    }

    const result = await runBulkDataLoad({
      instanceUrl:   req.orgConn.instance_url,
      accessToken:   req.orgConn.access_token,
      objectApiName: 'PermissionSetAssignment',
      operation:     'insert',
      csvData:       csvLines.join('\n'),
    });

    await recordAdminOp({
      userId: req.user.id, orgId: req.orgConn.id,
      jobType: 'permission', label: `Assign ${permissionSetIds.length} permission set(s) to ${userIds.length} user(s)`,
      status: result.failed > 0 && result.succeeded === 0 ? 'failed' : 'completed',
      result: {
        counts: { total: result.total, succeeded: result.succeeded, failed: result.failed },
        errors: result.errors,
      },
    });

    res.json({
      total:     result.total,
      succeeded: result.succeeded,
      failed:    result.failed,
      skipped,
      errors:    result.errors,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
