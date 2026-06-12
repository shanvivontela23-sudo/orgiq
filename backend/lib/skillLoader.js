'use strict';

const fs   = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '../skills');
const cache      = new Map();

/**
 * Load a skill file by name (without extension).
 * Returns the markdown string, or null if not found.
 * In-memory cached after first read.
 */
function loadSkill(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const content = fs.readFileSync(path.join(SKILLS_DIR, `${name}.md`), 'utf8');
    cache.set(name, content);
    return content;
  } catch {
    return null;
  }
}

/**
 * Resolve the right skill for a given Metadata API type string.
 * Matches loosely so callers don't need to know exact file names.
 */
function skillForType(metadataType = '') {
  const t = metadataType.toLowerCase().replace(/[^a-z]/g, '');
  if (t.includes('flow'))                                       return loadSkill('flow');
  if (t.includes('validationrule') || t === 'validation')      return loadSkill('validation-rule');
  if (t.includes('customfield') || t.includes('fieldsblock'))  return loadSkill('custom-field');
  // CustomObject.fields deploy wrapper → custom-field skill
  if (t.includes('customobject'))                              return loadSkill('custom-field');
  return null;
}

/** Wrap skill content for injection into a system prompt. */
function formatSkillBlock(skill) {
  if (!skill) return '';
  return `\n## SKILL KNOWLEDGE — APPLY BEFORE REPAIRING\n${skill}\n`;
}

module.exports = { loadSkill, skillForType, formatSkillBlock };
