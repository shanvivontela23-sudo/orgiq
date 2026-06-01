/**
 * schemaContext.js
 *
 * Fetches relevant org schema and injects it into Claude prompts.
 * This is what makes Claude generate field API names that actually exist.
 *
 * Cached in Redis — doesn't query Salesforce on every generation request.
 */

const redis = require("./redisClient");

/**
 * Get relevant schema context for a generation request.
 * Extracts object names from the user's input, fetches those objects' fields.
 *
 * @param {string} orgId       - Connected org ID
 * @param {string} userInput   - User's requirement (to detect which objects they mention)
 * @param {string} artifactType - 'flow' | 'report' | etc.
 * @param {object} sfClient    - Authenticated SalesforceClient
 */
async function getOrgSchemaContext(orgId, userInput, artifactType, sfClient) {
  // Detect which objects the user is likely referring to
  const mentionedObjects = detectObjectMentions(userInput);

  if (!mentionedObjects.length) {
    return { note: "No specific objects detected — Claude will ask for object name before generating" };
  }

  const schema = {};

  for (const objName of mentionedObjects) {
    const fields = await getObjectFields(orgId, objName, sfClient);
    if (fields) schema[objName] = fields;
  }

  return schema;
}

/**
 * Get all fields for an object — cached in Redis for 24 hours
 */
async function getObjectFields(orgId, objectApiName, sfClient) {
  const cacheKey = `schema:${orgId}:${objectApiName}`;

  // Try cache first
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    // Redis miss or error — proceed to fetch from SF
  }

  if (!sfClient) return null;

  try {
    // Describe the object
    const res = await sfClient.fetch(
      `/services/data/v59.0/sobjects/${objectApiName}/describe`
    );

    if (!res.ok) return null;

    const describe = await res.json();

    // Extract only what Claude needs — not the full describe (too large)
    const fieldSummary = describe.fields.map((f) => ({
      apiName:   f.name,
      label:     f.label,
      type:      f.type,
      required:  !f.nillable && !f.defaultedOnCreate,
      picklist:  f.picklistValues?.map((pv) => pv.value) || [],
      referenceTo: f.referenceTo || [],
    }));

    const result = {
      objectApiName,
      objectLabel: describe.label,
      fields:      fieldSummary,
      recordTypes: describe.recordTypeInfos?.map((rt) => ({
        name:       rt.name,
        developerName: rt.developerName,
        isDefault:  rt.defaultRecordTypeMapping,
      })) || [],
    };

    // Cache for 24 hours
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", 86400);
    } catch (e) {
      // Cache write failed — non-critical
    }

    return result;
  } catch (err) {
    console.error(`Failed to describe ${objectApiName}:`, err.message);
    return null;
  }
}

/**
 * Detect Salesforce object names mentioned in user input.
 * Handles: "Opportunity", "Custom_Object__c", "Account", etc.
 */
function detectObjectMentions(input) {
  if (!input) return [];

  const found = new Set();
  const lower  = input.toLowerCase();

  // Standard objects — common ones
  const standardObjects = [
    "Account", "Contact", "Opportunity", "Lead", "Case", "Task", "Event",
    "Campaign", "CampaignMember", "Contract", "Order", "Quote", "Asset",
    "Product2", "Pricebook2", "PricebookEntry", "User", "ContentVersion",
    "Attachment", "Note", "EmailMessage",
  ];

  for (const obj of standardObjects) {
    if (lower.includes(obj.toLowerCase())) found.add(obj);
  }

  // Custom objects — match anything ending in __c
  const customObjectMatches = input.match(/\b[A-Z][a-zA-Z0-9_]*__c\b/g) || [];
  for (const obj of customObjectMatches) found.add(obj);

  return [...found];
}

/**
 * Warm the schema cache for an org when it first connects.
 * Called after OAuth — runs in background.
 */
async function warmSchemaCache(orgId, sfClient) {
  const commonObjects = [
    "Account", "Contact", "Opportunity", "Lead", "Case", "Task", "Event",
  ];

  console.log(`Warming schema cache for org ${orgId}...`);

  await Promise.allSettled(
    commonObjects.map((obj) => getObjectFields(orgId, obj, sfClient))
  );

  // Also get list of all custom objects
  try {
    const res = await sfClient.query(
      "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomizable = true AND QualifiedApiName LIKE '%__c' LIMIT 200"
    );

    const customObjects = res.records.map((r) => r.QualifiedApiName);
    await redis.set(`schema:${orgId}:customObjects`, JSON.stringify(customObjects), "EX", 86400);

    console.log(`Schema cache warmed: ${commonObjects.length} standard + ${customObjects.length} custom objects`);
  } catch (err) {
    console.error("Failed to fetch custom object list:", err.message);
  }
}

/**
 * Invalidate schema cache for an org (call when user requests refresh)
 */
async function invalidateSchemaCache(orgId) {
  const keys = await redis.keys(`schema:${orgId}:*`);
  if (keys.length) await redis.del(...keys);
  console.log(`Schema cache cleared for org ${orgId}: ${keys.length} keys removed`);
}

module.exports = {
  getOrgSchemaContext,
  getObjectFields,
  warmSchemaCache,
  invalidateSchemaCache,
};
