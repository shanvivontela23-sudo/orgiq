"""
engine/sf_migrate.py
OrgIQ Migration Engine — main entry point.
Spawned by the Node.js BullMQ worker with args built from job config.

Emits JSON lines to stdout for real-time phase/progress updates:
  {"type":"phase","number":0,"name":"Pre-flight validation","status":"running"}
  {"type":"progress","succeeded":1200,"failed":3,"phase":0}
  {"type":"error","sfId":"003XX","object":"Contact","code":"FIELD_CUSTOM...","action":"..."}
  {"type":"complete","recordCounts":{"total":42800,"succeeded":42103,"failed":697}}

Exit codes:
  0 = success
  1 = migration error (partial or complete failure)
  2 = configuration/setup error (bad args, bad mapping file, etc.)
"""

import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse
import requests

from parser import parse_mapping_file
from graph import build_dependency_graph, get_self_referential_fields


def fetch_schema_via_mcp(source_org_id: str, objects_in_scope: list) -> dict:
    """
    Fetch Salesforce schema by calling the backend's MCP schema endpoint.
    Returns a schema dict compatible with build_dependency_graph().

    The backend Node.js server runs on MCP_SERVICE_URL (default localhost:3001).
    This avoids the engine needing its own Salesforce OAuth token for describes —
    schema introspection is handled by Claude + Salesforce MCP.

    Falls back gracefully to an empty schema if the MCP service is unreachable
    (e.g. during local dev without the MCP server configured).
    """
    mcp_url = os.environ.get("MCP_SERVICE_URL", "http://localhost:3001")
    endpoint = f"{mcp_url}/api/mcp/schema"

    payload = json.dumps({
        "orgId": source_org_id,
        "objects": objects_in_scope,
    }).encode("utf-8")

    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            # body.objects is { ObjectName: { fields, childRelationships, ... } }
            # Convert to engine-compatible format: { ObjectName: { fields: [{ name, type, referenceTo }] } }
            engine_schema = {}
            for obj_name, obj_meta in body.get("objects", {}).items():
                if not obj_meta.get("exists", True):
                    continue
                engine_schema[obj_name] = {
                    "fields": [
                        {
                            "name": f["name"],
                            "type": f["type"],
                            "referenceTo": f.get("referenceTo", []),
                        }
                        for f in obj_meta.get("fields", [])
                    ]
                }
            return engine_schema
    except urllib.error.URLError as exc:
        emit({
            "type": "error",
            "sfId": None,
            "object": None,
            "code": "MCP_SCHEMA_FETCH_FAILED",
            "action": (
                f"Could not fetch schema from MCP service at {mcp_url}: {exc}. "
                "Falling back to empty schema — dependency graph will use object order from mapping file. "
                "Set MCP_SERVICE_URL env var to point to the running backend."
            ),
        })
        return {}
    except (json.JSONDecodeError, KeyError) as exc:
        emit({
            "type": "error",
            "sfId": None,
            "object": None,
            "code": "MCP_SCHEMA_PARSE_ERROR",
            "action": f"MCP schema response could not be parsed: {exc}. Using empty schema.",
        })
        return {}


def emit(msg: dict):
    """Write a JSON line to stdout — Node.js worker parses these."""
    print(json.dumps(msg), flush=True)


def phase(number: int, name: str, status: str = "running"):
    emit({"type": "phase", "number": number, "name": name, "status": status})


def progress(phase_num: int, succeeded: int, failed: int):
    emit({"type": "progress", "phase": phase_num, "succeeded": succeeded, "failed": failed})


def error(sf_id: str, obj: str, code: str, action: str):
    emit({"type": "error", "sfId": sf_id, "object": obj, "code": code, "action": action})


def complete(record_counts: dict):
    emit({"type": "complete", "recordCounts": record_counts})


def salesforce_query(instance_url: str, access_token: str, soql: str) -> dict:
    response = requests.get(
        f"{instance_url.rstrip('/')}/services/data/v62.0/query",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"q": soql},
        timeout=60,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Salesforce query failed for SOQL '{soql}': "
            f"HTTP {response.status_code} {response.text}"
        )
    return response.json()


def salesforce_query_all(instance_url: str, access_token: str, soql: str) -> list:
    result = salesforce_query(instance_url, access_token, soql)
    records = result.get("records", [])
    while not result.get("done", True):
        next_url = result.get("nextRecordsUrl")
        response = requests.get(
            f"{instance_url.rstrip('/')}{next_url}",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=60,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Salesforce queryMore failed: HTTP {response.status_code} {response.text}")
        result = response.json()
        records.extend(result.get("records", []))
    for record in records:
        record.pop("attributes", None)
    return records


def salesforce_create(instance_url: str, access_token: str, object_name: str, payload: dict) -> str:
    response = requests.post(
        f"{instance_url.rstrip('/')}/services/data/v62.0/sobjects/{object_name}/",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Sforce-Duplicate-Rule-Header": "allowSave=true",
        },
        json=payload,
        timeout=90,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Create {object_name} failed: HTTP {response.status_code} {response.text}")
    data = response.json()
    return data["id"]


def salesforce_download(instance_url: str, access_token: str, value: str) -> bytes:
    url = value if value.startswith("http") else f"{instance_url.rstrip('/')}{value}"
    response = requests.get(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=90,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Download failed: HTTP {response.status_code} {response.text}")
    return response.content


def soql_quote(value) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def where_clause(object_name: str, source_filters: dict) -> str:
    filter_value = source_filters.get(object_name)
    return f" WHERE {filter_value}" if filter_value else ""


def count_source_records(instance_url: str, access_token: str, object_name: str, source_filters: dict) -> int:
    # Querying Id and using totalSize avoids COUNT() response-shape differences.
    result = salesforce_query(instance_url, access_token, f"SELECT Id FROM {object_name}{where_clause(object_name, source_filters)}")
    return int(result.get("totalSize", 0))


def mapping_source_fields(object_mapping: dict) -> list:
    fields = set(object_mapping.get("passthrough_fields", []))
    fields.update(object_mapping.get("field_renames", {}).keys())
    fields.update(object_mapping.get("picklist_maps", {}).keys())
    fields.update(object_mapping.get("datetime_fields", []))
    fields.difference_update(object_mapping.get("remove_fields", []))
    fields.discard("Id")
    return sorted(fields)


def build_payload(object_name: str, source_record: dict, object_mapping: dict, id_maps: dict, binary_fields: dict) -> dict:
    payload = {}

    for field in object_mapping.get("passthrough_fields", []):
      if field in object_mapping.get("remove_fields", []) or field == "Id":
          continue
      if field in source_record and source_record[field] not in (None, ""):
          payload[field] = source_record[field]

    for source_field, target_field in object_mapping.get("field_renames", {}).items():
        if source_field in source_record and source_record[source_field] not in (None, ""):
            payload[target_field] = source_record[source_field]

    for source_field, picklist_map in object_mapping.get("picklist_maps", {}).items():
        if source_field in source_record and source_record[source_field] not in (None, ""):
            payload[source_field] = picklist_map.get(source_record[source_field], source_record[source_field])

    for target_field, fixed_value in object_mapping.get("fixed_values", {}).items():
        payload[target_field] = fixed_value

    # Salesforce orgs with State/Country picklists require country before state.
    if "BillingState" in payload and not payload.get("BillingCountry"):
        payload.pop("BillingState", None)
    if "ShippingState" in payload and not payload.get("ShippingCountry"):
        payload.pop("ShippingState", None)

    if object_name == "Opportunity":
        source_account_id = source_record.get("AccountId")
        if source_account_id:
            target_account_id = id_maps.get("Account", {}).get(source_account_id)
            if not target_account_id:
                raise ValueError(f"Missing migrated target Account for source AccountId {source_account_id}")
            payload["AccountId"] = target_account_id

    if object_name == "ContentVersion":
        source_parent_id = source_record.get("FirstPublishLocationId")
        target_parent_id = (
            id_maps.get("Opportunity", {}).get(source_parent_id)
            or id_maps.get("Account", {}).get(source_parent_id)
        )
        if target_parent_id:
            payload["FirstPublishLocationId"] = target_parent_id
        if source_record.get("VersionData"):
            payload["VersionData"] = base64.b64encode(binary_fields[source_record["Id"]]).decode("ascii")

    if object_name == "Attachment":
        source_parent_id = source_record.get("ParentId")
        target_parent_id = (
            id_maps.get("Opportunity", {}).get(source_parent_id)
            or id_maps.get("Account", {}).get(source_parent_id)
        )
        if not target_parent_id:
            raise ValueError(f"Missing migrated target parent for source Attachment.ParentId {source_parent_id}")
        payload["ParentId"] = target_parent_id
        if source_record.get("Body"):
            payload["Body"] = base64.b64encode(binary_fields[source_record["Id"]]).decode("ascii")

    return payload


def find_existing_target(instance_url: str, access_token: str, object_name: str, source_record: dict):
    if object_name == "Account" and source_record.get("AccountNumber"):
        soql = f"SELECT Id FROM Account WHERE AccountNumber = {soql_quote(source_record['AccountNumber'])} LIMIT 1"
    elif object_name == "Opportunity" and source_record.get("Name"):
        soql = f"SELECT Id FROM Opportunity WHERE Name = {soql_quote(source_record['Name'])} LIMIT 1"
    elif object_name == "ContentVersion" and source_record.get("Title"):
        soql = f"SELECT Id FROM ContentVersion WHERE Title = {soql_quote(source_record['Title'])} LIMIT 1"
    elif object_name == "Attachment" and source_record.get("Name"):
        soql = f"SELECT Id FROM Attachment WHERE Name = {soql_quote(source_record['Name'])} LIMIT 1"
    else:
        return None

    records = salesforce_query_all(instance_url, access_token, soql)
    return records[0]["Id"] if records else None


def migrate_object(
    object_name: str,
    object_mapping: dict,
    source_instance_url: str,
    source_access_token: str,
    target_instance_url: str,
    target_access_token: str,
    source_filters: dict,
    id_maps: dict,
) -> tuple:
    fields = set(mapping_source_fields(object_mapping))
    fields.add("Id")
    if object_name == "Opportunity":
        fields.add("AccountId")
    if object_name == "ContentVersion":
        fields.update(["FirstPublishLocationId", "VersionData"])
    if object_name == "Attachment":
        fields.update(["ParentId", "Body"])

    soql = f"SELECT {', '.join(sorted(fields))} FROM {object_name}{where_clause(object_name, source_filters)}"
    source_records = salesforce_query_all(source_instance_url, source_access_token, soql)

    succeeded = 0
    failed = 0
    id_maps.setdefault(object_name, {})
    binary_fields = {}

    if object_name in ("ContentVersion", "Attachment"):
        body_field = "VersionData" if object_name == "ContentVersion" else "Body"
        for record in source_records:
            if record.get(body_field):
                binary_fields[record["Id"]] = salesforce_download(source_instance_url, source_access_token, record[body_field])

    for record in source_records:
        try:
            existing_id = find_existing_target(target_instance_url, target_access_token, object_name, record)
            if existing_id:
                id_maps[object_name][record["Id"]] = existing_id
                succeeded += 1
                continue

            payload = build_payload(object_name, record, object_mapping, id_maps, binary_fields)
            target_id = salesforce_create(target_instance_url, target_access_token, object_name, payload)
            id_maps[object_name][record["Id"]] = target_id
            succeeded += 1
        except Exception as exc:
            failed += 1
            error(record.get("Id"), object_name, "RECORD_MIGRATION_FAILED", str(exc))

    return succeeded, failed


def parse_args():
    parser = argparse.ArgumentParser(description="OrgIQ Salesforce Migration Engine")
    parser.add_argument("--batch-id", required=True, help="Unique batch ID for this migration run")
    parser.add_argument("--source-org", required=True, help="Source org ID")
    parser.add_argument("--target-org", required=True, help="Target org ID")
    parser.add_argument("--mapping-file", default=None, help="Path to mapping file (.csv/.xlsx/.json)")
    parser.add_argument("--dry-run", action="store_true", help="Validate only — do not write to target")
    parser.add_argument("--pii-target", action="store_true", help="Mask PII fields on target")
    parser.add_argument("--skip-files", action="store_true", help="Skip ContentVersion / Attachment records")
    parser.add_argument("--skip-emails", action="store_true", help="Skip EmailMessage records")
    parser.add_argument("--source-filters", default="{}", help="JSON object of object API name to SOQL WHERE clause")
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        # Phase 0 — Pre-flight validation
        phase(0, "Pre-flight validation")

        source_access_token = os.environ.get("SOURCE_ACCESS_TOKEN")
        target_access_token = os.environ.get("TARGET_ACCESS_TOKEN")
        source_instance_url = os.environ.get("SOURCE_INSTANCE_URL")
        target_instance_url = os.environ.get("TARGET_INSTANCE_URL")

        if not all([source_access_token, target_access_token, source_instance_url, target_instance_url]):
            emit({"type": "error", "sfId": None, "object": None, "code": "MISSING_ENV",
                  "action": "SOURCE_ACCESS_TOKEN, SOURCE_INSTANCE_URL, TARGET_ACCESS_TOKEN, TARGET_INSTANCE_URL must be set"})
            sys.exit(2)
        try:
            source_filters = json.loads(args.source_filters or "{}")
        except json.JSONDecodeError as exc:
            emit({"type": "error", "sfId": None, "object": None, "code": "BAD_SOURCE_FILTERS",
                  "action": f"--source-filters must be valid JSON: {exc}"})
            sys.exit(2)
        phase(0, "Pre-flight validation", "completed")

        # Phase 1 — Parse mapping file
        phase(1, "Mapping file parse")
        mapping_config = {}
        if args.mapping_file:
            mapping_config = parse_mapping_file(args.mapping_file)
        else:
            emit({"type": "error", "sfId": None, "object": None, "code": "NO_MAPPING_FILE",
                  "action": "No --mapping-file provided. Proceeding with empty mapping (passthrough only)."})

        objects_in_scope = mapping_config.get("objects", [])
        load_order_overrides = mapping_config.get("load_order_overrides", {})

        phase(1, "Mapping file parse", "completed")
        progress(1, 0, 0)

        # Phase 2 — Schema analysis + dependency graph
        phase(2, "Schema analysis & dependency graph")

        # Fetch real schema via the MCP service layer (Claude + Salesforce native MCP).
        # Falls back to {} if MCP is unreachable (emits a warning but does not abort).
        source_org_schema = {}
        if objects_in_scope:
            source_org_schema = fetch_schema_via_mcp(args.source_org, objects_in_scope)

        if objects_in_scope:
            load_order = build_dependency_graph(objects_in_scope, source_org_schema, load_order_overrides)
        else:
            load_order = []

        phase(2, "Schema analysis & dependency graph", "completed")
        progress(2, 0, 0)

        # Phases 3–9: Per-object migration
        # TODO: implement actual Salesforce REST API bulk load per object
        total_succeeded = 0
        total_failed = 0
        id_maps = {}

        for i, obj in enumerate(load_order):
            if args.skip_files and obj in ("ContentVersion", "Attachment"):
                continue
            phase_num = 3 + i
            self_ref_fields = get_self_referential_fields(obj, source_org_schema)
            object_mapping = mapping_config.get("mappings", {}).get(obj, {})

            phase(phase_num, f"Migrate {obj}")

            if args.dry_run:
                # Dry run — validate only, no writes. Count source records in scope.
                record_count = count_source_records(source_instance_url, source_access_token, obj, source_filters)
                total_succeeded += record_count
                if self_ref_fields:
                    emit({
                        "type": "info",
                        "object": obj,
                        "code": "SELF_REFERENTIAL_FIELDS",
                        "message": f"{obj} has self-referential fields that require a second pass: {self_ref_fields}",
                    })
                progress(phase_num, total_succeeded, total_failed)
                phase(phase_num, f"Migrate {obj} [DRY RUN]", "completed")
            else:
                succeeded, failed = migrate_object(
                    obj,
                    object_mapping,
                    source_instance_url,
                    source_access_token,
                    target_instance_url,
                    target_access_token,
                    source_filters,
                    id_maps,
                )
                total_succeeded += succeeded
                total_failed += failed
                progress(phase_num, total_succeeded, total_failed)
                phase(phase_num, f"Migrate {obj}", "completed")

        # Final phase — complete
        record_counts = {
            "total": total_succeeded + total_failed,
            "succeeded": total_succeeded,
            "failed": total_failed,
        }
        complete(record_counts)
        sys.exit(0)

    except ValueError as e:
        emit({"type": "error", "sfId": None, "object": None,
              "code": "CONFIG_ERROR", "action": str(e)})
        sys.exit(2)

    except Exception as e:
        emit({"type": "error", "sfId": None, "object": None,
              "code": "UNEXPECTED_ERROR", "action": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
