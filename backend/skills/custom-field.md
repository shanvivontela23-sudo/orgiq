# SF Copilot Skill: CustomField (Metadata API v62)
# Scope: XML structure gotchas and deploy error → fix mapping.
# Do NOT re-state best practices or governor limits — those are in the system prompt.

## Critical XML Structure Rules

### Deploy wrapper: field lives inside CustomObject
A CustomField is deployed inside a CustomObject wrapper, NOT as a standalone file:
  objects/Account.object
  <CustomObject>
    <fields>
      <fullName>My_Field__c</fullName>
      ...
    </fields>
  </CustomObject>
The <fullName> inside <fields> is just the field name WITHOUT the object prefix.
WRONG: <fullName>Account.My_Field__c</fullName>  ← object prefix inside fields block causes error.
RIGHT: <fullName>My_Field__c</fullName>

### Formula field <type> = return type, NOT "TextFormula"
For Formula fields, <type> is the RETURN TYPE of the formula:
  Text | Number | Date | DateTime | Checkbox | Currency | Percent
WRONG: <type>TextFormula</type>  ← this string does not exist in the API, causes "Invalid type" error.
RIGHT (text-returning formula): <type>Text</type>
RIGHT (number-returning formula): <type>Number</type>
Also required for formula: <formula>...</formula> and <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>

### Required type-specific elements

Text:         <length>255</length>          ← required, max 255
LongTextArea: <length>32768</length>        ← required
              <visibleLines>3</visibleLines> ← required
Number:       <precision>18</precision>     ← total digits
              <scale>0</scale>              ← decimal places
Currency:     <precision>18</precision>
              <scale>2</scale>
Percent:      <precision>18</precision>
              <scale>2</scale>
Picklist:     <valueSet> block (see below)
Lookup:       <referenceTo>ObjectApiName</referenceTo>
              <relationshipName>UniqueRelName</relationshipName>  ← no __r suffix here, no spaces
Checkbox:     <defaultValue>false</defaultValue>  ← required, true or false

### Picklist <valueSet> structure
<valueSet>
  <restricted>false</restricted>
  <valueSetDefinition>
    <sorted>false</sorted>
    <value>
      <fullName>Option_1</fullName>
      <default>true</default>   ← exactly ONE value must have <default>true</default>
      <label>Option 1</label>
    </value>
    <value>
      <fullName>Option_2</fullName>
      <default>false</default>
      <label>Option 2</label>
    </value>
  </valueSetDefinition>
</valueSet>
WRONG: omitting <default> entirely — causes "Default value required" error.
WRONG: two values with <default>true</default> — causes "Only one default allowed".

### Lookup relationshipName
Must be unique across ALL relationships on the object. No spaces, no __r suffix.
Convention: field API name without __c, e.g. field My_Account__c → relationshipName My_Account.
If there's a conflict, append an integer: My_Account_2.

### __c suffix rules
<fullName> of the field: MUST end in __c (e.g. My_Field__c).
<label>: MUST NOT contain __c (label is the human-readable name).
<type>: NEVER contains __c.

### External ID restrictions
externalId=true is only valid on: Text, Number, Email, Phone, URL, Date, DateTime, AutoNumber.
WRONG: externalId on Picklist, Lookup, Checkbox, LongTextArea — causes "Invalid external ID type".

### required=true restrictions
Cannot set required=true on a Checkbox field (checkboxes always have a value).
Cannot set required=true if existing records have null values in that field (data issue, not metadata issue — causes runtime errors, not deploy errors).

---

## Deploy Error → Fix Mapping

"Invalid type: [X]"
  → <type> value doesn't match the API enum. For Formula fields, use the return type (Text/Number/etc), not "TextFormula".

"Field [X]: Length required"
  → Add <length> for Text or LongTextArea fields.

"Field [X]: Precision and Scale required"
  → Add <precision> and <scale> for Number, Currency, Percent.

"Default value required for picklist"
  → Add <default>true</default> to exactly one <value> in <valueSetDefinition>.

"Relationship name [X] already exists"
  → <relationshipName> is not unique on this object. Append a number.

"External ID not allowed on field type [X]"
  → Remove <externalId>true</externalId> or change the field type.

"Duplicate field name: [X]"
  → A field with this API name already exists on the object. Change the <fullName>.

"Invalid field: [X] — fullName should not contain the object name"
  → Remove the object prefix from <fullName> inside the <fields> block.

"Required fields are missing: visibleLines"
  → LongTextArea needs <visibleLines> element.
