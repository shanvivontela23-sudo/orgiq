/**
 * bestPractices.js
 * 
 * The Salesforce best practices knowledge base.
 * Injected into EVERY Claude generation call.
 * Claude reviews this before asking questions or generating anything.
 * 
 * Maintained by Abhishek — update as Salesforce releases new versions.
 */

const FLOW_BEST_PRACTICES = `
## SALESFORCE FLOW BEST PRACTICES (API v59.0)
You MUST review and apply every applicable rule before generating.

### TRIGGER TYPE SELECTION
- Before Save flows: Use when updating fields on the SAME record. Cannot create/update OTHER records, cannot send emails, cannot call external services. Faster — runs before record is committed.
- After Save flows: Use when creating/updating OTHER records, sending emails, calling external services, or when you need the record ID.
- Scheduled flows: Use for batch operations on existing records. Not triggered by user action.
- Screen flows: Use when user interaction/input is required.
- Autolaunched flows: Use when called from Apex, Process Builder, or another Flow.
- RULE: Never use After Save if Before Save would work — Before Save is faster and uses fewer resources.

### BULKIFICATION — NON-NEGOTIABLE
- NEVER put Get Records, Create Records, Update Records, Delete Records inside a Loop.
- ALWAYS get related data BEFORE the loop using a single Get Records with a collection filter.
- ALWAYS use Assignment elements inside loops to build collections, then do one DML outside.
- WRONG pattern: Loop → Get Records → Update Records (fires once per record = governor limit death)
- RIGHT pattern: Get Records (collection) → Loop → Assignment (build collection) → Update Records (once)
- For every Loop you generate, ask yourself: "Is there any DML or query inside this loop?" If yes — restructure.

### GOVERNOR LIMITS TO RESPECT
- SOQL queries per transaction: 100 (sync), 200 (async)
- DML statements per transaction: 150
- CPU time: 10,000ms (sync), 60,000ms (async)
- Heap size: 6MB (sync), 12MB (async)
- Flow elements per transaction contribute to the SAME limits as Apex triggers on the same object.
- If the object could have 200+ records updated at once, the Flow MUST be bulkification-safe.

### ENTRY CONDITIONS
- Always add entry conditions to prevent Flow from running unnecessarily.
- Use ISCHANGED({!$Record.FieldName}) when the Flow should only fire when a specific field changes.
- Use ISNEW() for create-only logic.
- Use ISCHANGED() for update-only logic.
- Condition requirement: Use "All Conditions Are Met" (AND) by default. Use "Any Condition Is Met" (OR) only when explicitly needed.
- NEVER run a Flow on every save when conditions can filter it.

### FAULT PATHS — MANDATORY
- EVERY element that can fail MUST have a fault path connected.
- Elements that need fault paths: Create Records, Update Records, Delete Records, Get Records (when result is required), all Apex actions, all external service calls.
- Fault path minimum: log the fault message to a custom object or send a notification. Never leave fault paths empty.
- Generate a fault path on EVERY DML element. No exceptions.

### NULL SAFETY
- After every Get Records, check if the result is null before using it.
- Use a Decision element: "Was record found?" → Yes path / No path.
- Never assume Get Records will return a result.

### RECORD-TRIGGERED FLOW LIMITS (As of Winter '24)
- Maximum 2000 Flow interviews per transaction.
- Maximum active Record-Triggered Flows per object: No hard limit but performance degrades after 5. Flag to user if they already have Flows on this object.
- Always check: Is there already a Flow on this object? Could this logic merge with an existing Flow?

### FLOW NAMING CONVENTIONS
- API Name: Pascal_Case with underscores. Example: Close_Won_Follow_Up_Task
- Label: Human readable. Example: "Close Won - Create Follow Up Task"
- Description: Always generate one. Include: what it does, trigger conditions, created by OrgIQ, date.

### BEFORE YOU GENERATE — ALWAYS ASK
1. What object is this on?
2. Create, Update, or both?
3. What specific condition should trigger this? (Don't just say "when updated")
4. Should this check if a field actually changed (ISCHANGED) or run on every save?
5. What should happen if it fails?
6. Could this affect 200+ records at once?
7. Are there existing Flows or Triggers on this object?
8. Should this run for all record types or specific ones?
9. Does this need to run in system context or user context?
10. Should this be synchronous (real-time) or is async acceptable?
`;

const REPORT_BEST_PRACTICES = `
## SALESFORCE REPORT BEST PRACTICES (API v59.0)
You MUST review and apply every applicable rule before generating.

### REPORT TYPE SELECTION
- Tabular: Simple list of records. No grouping, no totals. Use for exports or simple lists.
- Summary: Records grouped by one or more fields with subtotals. Most common type. Use when user needs totals per group.
- Matrix: Two-dimensional grouping (rows AND columns). Use for cross-tabulation (e.g., revenue by region by quarter).
- Joined: Multiple report types in one report. Complex — only suggest if explicitly needed. Warn about performance.
- RULE: Default to Summary unless user explicitly needs Tabular or Matrix.

### FILTERS — ALWAYS CLARIFY
- Date filters: Use relative dates (THIS_QUARTER, LAST_N_DAYS:30) not absolute dates — reports stay relevant over time.
- "My records" vs "All records": Always ask. Default to "All records" for managers, "My records" for reps.
- Active records only: Ask if this applies (Contacts, Leads, Users especially).
- Never generate a report with no filters on a high-volume object (Leads, Activities, Cases) — performance issue.

### PERFORMANCE RULES
- Reports over 2,000 rows: Warn user. Report will still run but may time out in dashboard.
- Joined reports: Performance is significantly worse. Only use if no other option.
- Formula fields in groupings: Avoid — Salesforce cannot use indexes on formula fields, very slow.
- Avoid reporting on Activities (Task/Event) without date filters — these tables are massive.
- Cross-object formula fields in filters: Avoid — not indexed, full table scan.

### FOLDERS AND SHARING
- Always ask which folder the report should go in.
- Default: "Private" (only creator can see). Ask if it should be shared with a role, group, or public.
- Reports with sensitive data (salary, SSN, medical): Flag to user — folder-level sharing is not enough, check FLS.

### DASHBOARD COMPATIBILITY
- If report will be used on a dashboard: Must be Summary or Matrix (not Tabular for charts).
- Grouped date fields needed for time-series charts.
- Maximum 20 columns recommended for dashboard source reports.

### SCHEDULING
- Ask if this report should be emailed on a schedule.
- Scheduled reports run as the user who scheduled them — their record access applies.
- Maximum 5 scheduled reports per org on Developer Edition, unlimited on Enterprise+.

### BEFORE YOU GENERATE — ALWAYS ASK
1. What object(s) does this report cover?
2. Do you need grouping and totals, or just a flat list?
3. What date range? (Relative like "this quarter" or absolute?)
4. Your records only, your team's records, or all records?
5. What specific fields do you need as columns?
6. Any filters to narrow the data?
7. Which folder should this live in?
8. Will this be used on a dashboard?
9. Does it need to be scheduled and emailed to anyone?
10. Could this return more than 2,000 records?
`;

const APEX_BEST_PRACTICES = `
## SALESFORCE APEX BEST PRACTICES (API v59.0)
You MUST review and apply every applicable rule before generating.

### TRIGGER ARCHITECTURE
- One trigger per object — ALWAYS. No exceptions.
- Trigger body: Only one line — call the handler class method.
- Handler class: Contains all logic. Allows unit testing without DML context.
- Pattern to always use:
  Trigger: MyObjectTrigger on MyObject__c (before insert, after insert, before update, after update)
  Handler: MyObjectTriggerHandler class with static methods per context
- Check if a trigger already exists on the object before generating a new one. If yes — add to existing handler, don't create a new trigger.

### BULKIFICATION — EVERY TIME
- triggers receive up to 200 records at once.
- NEVER: for(MyObject__c obj : Trigger.new) { SOQL or DML inside }
- ALWAYS: Collect IDs → one SOQL outside loop → Map for lookup → loop processes from Map
- ALWAYS: Build list/map inside loop → one DML outside loop
- Template pattern:
  Map<Id, RelatedObject__c> relatedMap = new Map<Id, RelatedObject__c>(...);
  List<MyObject__c> toUpdate = new List<MyObject__c>();
  for(MyObject__c obj : Trigger.new) { ... toUpdate.add(obj); }
  update toUpdate;

### SECURITY — MANDATORY
- Always use WITH SECURITY_ENFORCED on SOQL or stripInaccessible() on results.
- Check CRUD before DML: Schema.sObjectType.Account.isCreateable()
- Never hardcode IDs (Record Type IDs, Profile IDs, Role IDs — all differ between orgs).
- Never hardcode URLs or org-specific values.
- Use Custom Metadata or Custom Settings for configurable values.

### TEST CLASSES — ALWAYS GENERATE WITH THE CLASS
- Minimum 75% coverage. Generate for 90%+.
- Test methods required: positive test, negative test, bulk test (200 records), admin/user context.
- Always use @TestSetup for data creation.
- Never use SeeAllData=true.
- Always use Test.startTest() / Test.stopTest() for async code.
- Assert specific outcomes — not just that code ran without error.

### GOVERNOR LIMITS IN APEX
- SOQL: 100 per sync transaction. Use aggregate queries where possible.
- DML: 150 per sync transaction.
- Callouts: 100 per transaction. Cannot mix DML and callouts in same context — use @future or Queueable.
- CPU: 10,000ms sync. Move heavy processing to Batch or Queueable.
- Heap: 6MB sync. Don't store entire query results in memory if you only need a few fields.

### BEFORE YOU GENERATE — ALWAYS ASK
1. What object is this for?
2. Trigger, Class, Batch, Scheduled, or Queueable?
3. What trigger events? (before/after insert/update/delete)
4. Is there already a trigger on this object?
5. What is the maximum volume of records this could process?
6. Does this make callouts? (affects async requirements)
7. Should this respect field-level security?
8. What should happen on error — silent fail, log, notify?
`;

const VALIDATION_RULE_BEST_PRACTICES = `
## SALESFORCE VALIDATION RULE BEST PRACTICES

### FORMULA GUIDANCE
- Use ISCHANGED() to only validate when a field changes, not on every save.
- Use ISNEW() / NOT(ISNEW()) to separate create vs update behavior.
- Use ISPICKVAL() for picklist comparisons, never TEXT() comparison.
- Use ISBLANK() not = '' for text fields.
- Null-safe: always account for null values in formulas.

### ERROR MESSAGE RULES
- Error message must be specific: tell user exactly what to fix.
- Bad: "Invalid value"
- Good: "Close Date must be in the future for Opportunities in Proposal stage"
- Always specify the error location: field-level (near the field) vs page-level.
- For field-level errors: specify which field the error should appear on.

### BYPASS PATTERNS
- Always ask: Should admins/system admins bypass this rule?
- If yes: Add $Profile.Name != 'System Administrator' to formula
- If using Permission Sets for bypass: $Permission.Bypass_Validation_Rules

### BEFORE YOU GENERATE — ALWAYS ASK
1. What object is this on?
2. Should it fire on Create, Update, or both?
3. Should System Administrators be able to bypass it?
4. What exact condition makes the record invalid?
5. What should the error message say?
6. Should the error appear on a specific field or at the top of the page?
`;

const PERMISSION_SET_BEST_PRACTICES = `
## SALESFORCE PERMISSION SET BEST PRACTICES

### DESIGN PRINCIPLES
- Permission Sets grant access — never restrict. Restriction is done at Profile level.
- One Permission Set per functional role/feature, not one massive Permission Set.
- Group related Permission Sets with Permission Set Groups.
- Never clone a Profile's permissions into a Permission Set — defeats the purpose.

### WHAT TO INCLUDE
- Object permissions: Read, Create, Edit, Delete, View All, Modify All
- Field permissions: Read, Edit (per field per object)
- Tab visibility
- App visibility
- System permissions (only what's strictly needed)
- Apex class access
- Visualforce page access

### PRINCIPLE OF LEAST PRIVILEGE
- Only grant what is explicitly needed for the use case.
- Never grant Modify All or View All unless specifically required.
- Never grant Delete unless specifically required.
- Document why each permission was granted.

### BEFORE YOU GENERATE — ALWAYS ASK
1. What is the specific use case / job function?
2. Which objects need access?
3. Read only or read/write?
4. Any specific fields that should be visible/editable?
5. Should this include system permissions (e.g., API access, Export reports)?
6. Will this be grouped with other Permission Sets?
`;

// ─── MASTER EXPORT ────────────────────────────────────────────────────────────

const BEST_PRACTICES = {
  flow:            FLOW_BEST_PRACTICES,
  report:          REPORT_BEST_PRACTICES,
  apex:            APEX_BEST_PRACTICES,
  validationRule:  VALIDATION_RULE_BEST_PRACTICES,
  permissionSet:   PERMISSION_SET_BEST_PRACTICES,
};

/**
 * Get best practices for a specific artifact type
 */
function getBestPractices(artifactType) {
  const bp = BEST_PRACTICES[artifactType];
  if (!bp) throw new Error(`No best practices defined for artifact type: ${artifactType}`);
  return bp;
}

/**
 * Get all best practices (for the interrogator phase
 * when artifact type isn't known yet)
 */
function getAllBestPractices() {
  return Object.values(BEST_PRACTICES).join("\n\n---\n\n");
}

module.exports = { getBestPractices, getAllBestPractices, BEST_PRACTICES };
