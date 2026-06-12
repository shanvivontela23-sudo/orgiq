# SF Copilot Skill: Flow (Metadata API v62)
# Scope: XML structure gotchas and deploy error → fix mapping.
# Do NOT re-state best practices or governor limits — those are in the system prompt.

## Critical XML Structure Rules

### processType
Record-triggered flows MUST have:
  <processType>AutoLaunchedFlow</processType>
Screen flows:
  <processType>Flow</processType>
Scheduled flows:
  <processType>AutoLaunchedFlow</processType>
WRONG (causes "The process type is not supported" error):
  <processType>Workflow</processType>  ← never use this

### start element
<start> MUST be the FIRST element in the flow body, before <decisions>, <recordLookups>, <assignments>.
The connector inside <start> points to the first real element.
<start>
  <locationX>176</locationX>
  <locationY>0</locationY>
  <connector><targetReference>FirstElement</targetReference></connector>
  <filterLogic>and</filterLogic>
  <object>Account</object>
  <recordTriggerType>CreateAndUpdate</recordTriggerType>
  <triggerType>RecordAfterSave</triggerType>
</start>

### triggerType values (exact strings)
RecordAfterSave    ← after save (create/update other records, email, callouts)
RecordBeforeSave   ← before save (same-record field updates only)
Scheduled          ← scheduled
WRONG: "AfterSave", "Before_Save", "afterSave" all fail with "Invalid enum value"

### recordTriggerType values
CreateAndUpdate | Create | Update | Delete
WRONG: "CreateOrUpdate" fails silently or errors

### Element name uniqueness
Every <name> attribute across ALL elements (assignments, decisions, loops, recordLookups, screens, subflows) MUST be unique within the flow. Duplicate names cause "Duplicate developer name" error. Add a numeric suffix if needed.

### Connector references
Every <targetReference> must exactly match an element <name>. Case-sensitive. A missing or misspelled reference causes "Target reference not found".

### Formula syntax in decisions
Decision outcome formulas use {!VariableName} syntax, not $Variable.Name.
WRONG: {$Record.Amount}    RIGHT: {!$Record.Amount}

### Fault connectors
Every DML element (Create/Update/Delete Records), action call, and subflow MUST have a <faultConnector> or the deploy fails with "Fault connector required".

### Variables
Input variables for autolaunched flows:
  <variables>
    <name>inputRecord</name>
    <dataType>SObject</dataType>
    <isInput>true</isInput>
    <isOutput>false</isOutput>
    <objectType>Account</objectType>
  </variables>
Do NOT use <inputVariables> — that's a deprecated PB/WFR element.

---

## Deploy Error → Fix Mapping

"A flow trigger requires a valid object"
  → <object> is missing or the API name is wrong (check case, __c suffix).

"Duplicate developer name"
  → Two elements share the same <name>. Rename one.

"The process type is not supported for this trigger type"
  → <processType> and <triggerType> are incompatible. Use AutoLaunchedFlow for record-triggered.

"Target reference [X] not found"
  → A <targetReference> or <connector> points to a name that doesn't exist. Fix the spelling.

"Fault connector required on [element]"
  → Add <faultConnector><targetReference>FaultPath</targetReference></faultConnector> to the element, and add a corresponding fault-handler assignment element.

"Invalid enum value: [X] for field triggerType"
  → Use exact enum strings above.

"The flow contains elements that are not connected"
  → An element has no incoming connector AND is not the start element. Either connect it or delete it.

"Field [X] does not exist on [Object]"
  → Field API name is wrong. Verify against org schema. Remember __c suffix for custom fields.
