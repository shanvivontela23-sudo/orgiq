# SF Copilot Skill: Validation Rule (Metadata API v62)
# Scope: XML structure gotchas and deploy error → fix mapping.
# Do NOT re-state best practices or governor limits — those are in the system prompt.

## Critical XML Structure Rules

### fullName format
Must be: ObjectApiName.RuleApiName
  <fullName>Account.Require_Phone_on_Close</fullName>
WRONG: <fullName>Require_Phone_on_Close</fullName>  ← missing object prefix, causes package structure error

### Formula returns TRUE to BLOCK
The formula evaluates to TRUE when the record should be BLOCKED (error shown).
FALSE = record saves normally.
Common mistake: inverting the logic (writing "when it IS valid" instead of "when it is INVALID").

### XML-sensitive characters in formula
These MUST be escaped in the <errorConditionFormula> XML element:
  & → &amp;
  < → &lt;
  > → &gt;
  " → &quot;
WRONG: <errorConditionFormula>Amount < 0</errorConditionFormula>
RIGHT: <errorConditionFormula>Amount &lt; 0</errorConditionFormula>
NEVER leave formula comments (/* */ or //) in the XML — causes parse error.

### PRIORVALUE() scope
PRIORVALUE() only works in Before Update context.
It silently returns null on Before Insert — DO NOT use it in rules that fire on insert.
If rule applies to both create and update, use ISCHANGED() + PRIORVALUE() together,
or use two separate rules.

### ISNULL() vs ISBLANK()
ISNULL(): only reliable for Number, Date, DateTime, Checkbox fields.
ISBLANK(): works for Text, Picklist, and all field types. Prefer ISBLANK().
WRONG for text fields: ISNULL(Phone)
RIGHT: ISBLANK(Phone)

### ISPICKVAL() syntax
ISPICKVAL(StageName, "Closed Won")  ← string literal, exact picklist value, case-sensitive.
WRONG: StageName = "Closed Won"  ← comparison operator doesn't work on picklist in formula.

### $RecordType reference
Use DeveloperName not Name for reliability across sandbox refreshes:
  $RecordType.DeveloperName = "Enterprise"
NOT: $RecordType.Name = "Enterprise"  ← breaks if the label changes.

### Cross-object formulas
Only one level of lookup traversal is supported in validation rule formulas in most contexts.
Account.Owner.Manager.Name  ← NOT supported, causes "Field not accessible" error.
Account.Owner.Name  ← supported.

### errorDisplayField
Either a field API name (error highlights that field) or blank (error appears at top of page).
WRONG: <errorDisplayField>Account Name</errorDisplayField>  ← use API name, not label.
RIGHT: <errorDisplayField>Name</errorDisplayField>

### description length
Max 255 characters. Truncate silently or deploy fails with "Description too long".

---

## Deploy Error → Fix Mapping

"Compile error: field [X] does not exist"
  → Field API name is wrong. Case-sensitive. Add __c for custom fields.

"Compile error: Unknown function [X]"
  → Function name misspelled, or not supported on this object type (e.g. GETRECORDIDS on non-junction).

"Description too long"
  → Truncate <description> to 255 characters.

"Error parsing field: [X]"
  → XML not escaped. Replace < with &lt;, > with &gt;, & with &amp; in formula.

"Invalid formula"
  → Check parentheses balance, AND/OR argument count, ISPICKVAL syntax, quote matching.

"The validation rule formula must return a Boolean"
  → Formula evaluates to a non-Boolean. Wrap comparison or add = TRUE.

"fullName is invalid"
  → Missing Object prefix. Format must be ObjectApiName.RuleName.
