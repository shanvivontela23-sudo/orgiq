"""
engine/parser.py
Parses OrgIQ mapping files (CSV, XLSX, JSON) into a structured migration config dict.

Expected columns:
  Object API Name | Source Field API Name | Target Field API Name |
  Transform Type  | Transform Value       | PII Flag              |
  Load Order Override | Notes
"""

import os
import json
import pandas as pd


# Column aliases — accept common variations in casing / spacing
COL_ALIASES = {
    "Object API Name":        ["object api name", "object", "sobject"],
    "Source Field API Name":  ["source field api name", "source field", "source"],
    "Target Field API Name":  ["target field api name", "target field", "target"],
    "Transform Type":         ["transform type", "transform"],
    "Transform Value":        ["transform value", "value"],
    "PII Flag":               ["pii flag", "pii", "is_pii"],
    "Load Order Override":    ["load order override", "load order", "order"],
    "Notes":                  ["notes", "note", "comment"],
}

REQUIRED_COLS = ["Object API Name", "Source Field API Name", "Target Field API Name"]

TRANSFORM_TYPES = {"rename", "picklist_map", "fixed_value", "remove", "passthrough", "datetime"}


def _normalise_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Remap whatever column names exist in the file to canonical names."""
    rename_map = {}
    lower_cols = {c.strip().lower(): c for c in df.columns}
    for canonical, aliases in COL_ALIASES.items():
        for alias in aliases:
            if alias in lower_cols:
                rename_map[lower_cols[alias]] = canonical
                break
    return df.rename(columns=rename_map)


def _validate_required_columns(df: pd.DataFrame, file_path: str) -> None:
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(
            f"Mapping file '{os.path.basename(file_path)}' is missing required columns: {missing}"
        )


def _load_dataframe(file_path: str) -> pd.DataFrame:
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".csv":
        return pd.read_csv(file_path, dtype=str)
    elif ext in (".xlsx", ".xls"):
        return pd.read_excel(file_path, dtype=str)
    elif ext == ".json":
        with open(file_path, "r") as f:
            data = json.load(f)
        if isinstance(data, list):
            return pd.DataFrame(data)
        elif isinstance(data, dict) and "mappings" in data:
            # Already in OrgIQ structured format — return as-is
            return None, data
        else:
            raise ValueError(f"JSON mapping file must be a list of rows or an OrgIQ structured dict.")
    else:
        raise ValueError(f"Unsupported mapping file type: '{ext}'. Accepted: .csv, .xlsx, .xls, .json")


def parse_mapping_file(file_path: str) -> dict:
    """
    Parse a mapping file and return a structured migration config.

    Returns:
        {
            "objects": ["Account", "Contact", ...],
            "load_order_overrides": {"Account": 1, "Contact": 2},
            "mappings": {
                "Account": {
                    "field_renames":      {"OldField__c": "NewField__c"},
                    "picklist_maps":      {"Industry": {"Tech": "Technology"}},
                    "fixed_values":       {"RecordTypeId": "012..."},
                    "remove_fields":      ["IsDeleted"],
                    "passthrough_fields": ["Name", "Phone"],
                    "pii_fields":         ["Email", "Phone"],
                    "datetime_fields":    ["CreatedDate"],
                }
            }
        }

    Raises:
        ValueError: on any parsing error — includes field name and row number.
        FileNotFoundError: if file_path doesn't exist.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Mapping file not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()

    # JSON shortcut — pre-structured format
    if ext == ".json":
        with open(file_path, "r") as f:
            data = json.load(f)
        if isinstance(data, dict) and "mappings" in data and "objects" in data:
            return data  # already in OrgIQ format
        elif isinstance(data, list):
            df = pd.DataFrame(data).astype(str)
        else:
            raise ValueError("JSON must be a list of mapping rows or an OrgIQ-structured dict.")
    elif ext == ".csv":
        df = pd.read_csv(file_path, dtype=str)
    elif ext in (".xlsx", ".xls"):
        df = pd.read_excel(file_path, dtype=str)
    else:
        raise ValueError(f"Unsupported file type '{ext}'. Accepted: .csv, .xlsx, .xls, .json")

    df = _normalise_columns(df)
    df = df.fillna("")

    _validate_required_columns(df, file_path)

    result = {
        "objects": [],
        "load_order_overrides": {},
        "mappings": {},
    }

    for row_idx, row in df.iterrows():
        row_num = row_idx + 2  # 1-indexed + header row

        obj = str(row.get("Object API Name", "")).strip()
        source_field = str(row.get("Source Field API Name", "")).strip()
        target_field = str(row.get("Target Field API Name", "")).strip()
        transform_type = str(row.get("Transform Type", "passthrough")).strip().lower() or "passthrough"
        transform_value = str(row.get("Transform Value", "")).strip()
        pii_flag = str(row.get("PII Flag", "")).strip().lower() in ("true", "yes", "1", "y")
        load_order_raw = str(row.get("Load Order Override", "")).strip()

        if not obj:
            raise ValueError(f"Row {row_num}: 'Object API Name' is empty.")
        if not source_field:
            raise ValueError(f"Row {row_num}: 'Source Field API Name' is empty (object: {obj}).")
        if not target_field:
            raise ValueError(f"Row {row_num}: 'Target Field API Name' is empty (object: {obj}, source field: {source_field}).")

        if transform_type not in TRANSFORM_TYPES:
            raise ValueError(
                f"Row {row_num}: Unknown Transform Type '{transform_type}' for {obj}.{source_field}. "
                f"Valid values: {sorted(TRANSFORM_TYPES)}"
            )

        # Initialise object entry
        if obj not in result["mappings"]:
            result["objects"].append(obj)
            result["mappings"][obj] = {
                "field_renames": {},
                "picklist_maps": {},
                "fixed_values": {},
                "remove_fields": [],
                "passthrough_fields": [],
                "pii_fields": [],
                "datetime_fields": [],
            }

        mapping = result["mappings"][obj]

        # Load order override
        if load_order_raw:
            try:
                result["load_order_overrides"][obj] = int(load_order_raw)
            except ValueError:
                raise ValueError(
                    f"Row {row_num}: 'Load Order Override' must be an integer, got '{load_order_raw}' (object: {obj})."
                )

        # PII tracking
        if pii_flag and source_field not in mapping["pii_fields"]:
            mapping["pii_fields"].append(source_field)

        # Apply transform
        if transform_type == "rename":
            if source_field != target_field:
                mapping["field_renames"][source_field] = target_field
            else:
                mapping["passthrough_fields"].append(source_field)

        elif transform_type == "picklist_map":
            if not transform_value:
                raise ValueError(
                    f"Row {row_num}: Transform Type 'picklist_map' requires a Transform Value "
                    f"(JSON object like {{\"Old\": \"New\"}}) for {obj}.{source_field}."
                )
            try:
                picklist_dict = json.loads(transform_value)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"Row {row_num}: Transform Value for 'picklist_map' is not valid JSON: {e} "
                    f"(object: {obj}, field: {source_field})."
                )
            mapping["picklist_maps"][source_field] = picklist_dict

        elif transform_type == "fixed_value":
            if not transform_value:
                raise ValueError(
                    f"Row {row_num}: Transform Type 'fixed_value' requires a non-empty Transform Value "
                    f"(object: {obj}, field: {source_field})."
                )
            mapping["fixed_values"][target_field] = transform_value

        elif transform_type == "remove":
            if source_field not in mapping["remove_fields"]:
                mapping["remove_fields"].append(source_field)

        elif transform_type == "passthrough":
            if source_field not in mapping["passthrough_fields"]:
                mapping["passthrough_fields"].append(source_field)

        elif transform_type == "datetime":
            if source_field not in mapping["datetime_fields"]:
                mapping["datetime_fields"].append(source_field)
            # Datetime fields are also passed through to target
            if source_field not in mapping["passthrough_fields"]:
                mapping["passthrough_fields"].append(source_field)

    # Deduplicate objects list (preserve order)
    seen = set()
    unique_objects = []
    for o in result["objects"]:
        if o not in seen:
            seen.add(o)
            unique_objects.append(o)
    result["objects"] = unique_objects

    return result


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python parser.py <mapping_file>")
        sys.exit(1)
    config = parse_mapping_file(sys.argv[1])
    print(json.dumps(config, indent=2))
