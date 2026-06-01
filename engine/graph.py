"""
engine/graph.py
Builds a dependency graph from Salesforce object schema and resolves load order
using Kahn's topological sort algorithm.

Usage:
    from graph import build_dependency_graph, get_self_referential_fields

    ordered = build_dependency_graph(["Account", "Contact", "Opportunity"], schema)
    # => ["Account", "Contact", "Opportunity"]

    self_ref = get_self_referential_fields("Account", schema)
    # => ["ParentId"]
"""

from collections import defaultdict, deque
from typing import List, Dict, Any


# Salesforce field types that create object-to-object dependencies
RELATIONSHIP_FIELD_TYPES = {"reference"}

# Standard fields that are always auto-handled and don't create real load-order deps
SKIP_REFERENCE_FIELDS = {"OwnerId", "CreatedById", "LastModifiedById", "MasterRecordId"}


def _get_reference_targets(field_meta: Dict[str, Any]) -> List[str]:
    """
    Extract the referenced object API names from a field's metadata.
    Handles polymorphic lookups (referenceTo is a list).
    """
    if field_meta.get("type") not in RELATIONSHIP_FIELD_TYPES:
        return []
    return field_meta.get("referenceTo", [])


def build_dependency_graph(
    objects_in_scope: List[str],
    source_org_schema: Dict[str, Any],
    load_order_overrides: Dict[str, int] = None,
) -> List[str]:
    """
    Build a directed dependency graph from Salesforce object schema and return
    a topologically sorted load order.

    Args:
        objects_in_scope:    List of Salesforce object API names to migrate.
        source_org_schema:   Dict keyed by object API name → Salesforce describe result.
                             Each value should have a "fields" list where each field has
                             at minimum: {"name": str, "type": str, "referenceTo": list}.
        load_order_overrides: Optional dict of {object_name: order_int} to pin specific
                              objects at the front of the queue (lower number = earlier).

    Returns:
        Ordered list of object API names safe to load in sequence.

    Raises:
        ValueError: if a circular dependency is detected (includes the cycle path).
    """
    scope_set = set(objects_in_scope)
    load_order_overrides = load_order_overrides or {}

    # Separate pinned objects (overrides) from the rest
    pinned = sorted(
        [(obj, order) for obj, order in load_order_overrides.items() if obj in scope_set],
        key=lambda x: x[1],
    )
    pinned_objects = {obj for obj, _ in pinned}
    unpinned_objects = [obj for obj in objects_in_scope if obj not in pinned_objects]

    # Build adjacency: obj -> set of objs it depends on (must be loaded before it)
    # Edge: A -> B means "A depends on B" (B must load first)
    dependents: Dict[str, set] = defaultdict(set)   # obj -> objects that depend on obj
    in_degree: Dict[str, int] = defaultdict(int)     # obj -> number of unresolved dependencies

    for obj in unpinned_objects:
        in_degree[obj]  # ensure every node exists

    for obj in unpinned_objects:
        schema = source_org_schema.get(obj, {})
        fields = schema.get("fields", [])

        for field in fields:
            field_name = field.get("name", "")
            if field_name in SKIP_REFERENCE_FIELDS:
                continue

            for referenced_obj in _get_reference_targets(field):
                # Only track dependencies within the migration scope
                if referenced_obj == obj:
                    continue  # self-referential — handled separately
                if referenced_obj not in scope_set:
                    continue  # dependency outside scope — skip (assume pre-exists)
                if referenced_obj in pinned_objects:
                    continue  # pinned objects are always loaded first

                if referenced_obj not in dependents[obj]:
                    dependents[obj].add(referenced_obj)
                    in_degree[obj] += 1
                    # Record that referenced_obj has obj as a dependent
                    # (we need the reverse for Kahn's)

    # Rebuild for Kahn's: prerequisites[obj] -> set of objects that must come before obj
    # dependents[obj] above is WRONG label — rename clearly
    # Let's redo with clear naming:
    prerequisites: Dict[str, set] = defaultdict(set)   # obj -> {must-come-before objs}
    successors: Dict[str, list] = defaultdict(list)     # obj -> [objects that depend on obj]
    in_deg: Dict[str, int] = {obj: 0 for obj in unpinned_objects}

    for obj in unpinned_objects:
        schema = source_org_schema.get(obj, {})
        fields = schema.get("fields", [])

        for field in fields:
            field_name = field.get("name", "")
            if field_name in SKIP_REFERENCE_FIELDS:
                continue

            for referenced_obj in _get_reference_targets(field):
                if referenced_obj == obj:
                    continue  # self-ref
                if referenced_obj not in scope_set or referenced_obj in pinned_objects:
                    continue

                if referenced_obj not in prerequisites[obj]:
                    prerequisites[obj].add(referenced_obj)
                    successors[referenced_obj].append(obj)
                    in_deg[obj] += 1

    # Kahn's algorithm
    queue = deque(
        sorted([obj for obj in unpinned_objects if in_deg[obj] == 0])
    )
    sorted_result: List[str] = []

    while queue:
        obj = queue.popleft()
        sorted_result.append(obj)

        for dependent in successors[obj]:
            in_deg[dependent] -= 1
            if in_deg[dependent] == 0:
                queue.append(dependent)

    # Detect cycles — any unpinned object not in sorted_result is part of a cycle
    remaining = [obj for obj in unpinned_objects if obj not in sorted_result]
    if remaining:
        cycle = _find_cycle(remaining, prerequisites)
        raise ValueError(
            f"Circular dependency detected among objects: {remaining}. "
            f"Cycle path: {' → '.join(cycle)}"
        )

    # Final order: pinned objects first (in override order), then topologically sorted
    final_order = [obj for obj, _ in pinned] + sorted_result
    return final_order


def _find_cycle(nodes: List[str], prerequisites: Dict[str, set]) -> List[str]:
    """
    DFS to find and return the cycle path among a subset of nodes.
    Returns the cycle as a list of object names.
    """
    visited = set()
    path = []
    path_set = set()

    def dfs(node: str) -> bool:
        visited.add(node)
        path.append(node)
        path_set.add(node)

        for prereq in prerequisites.get(node, []):
            if prereq not in nodes:
                continue
            if prereq not in visited:
                if dfs(prereq):
                    return True
            elif prereq in path_set:
                # Found the cycle — trim path to the cycle
                cycle_start = path.index(prereq)
                path[cycle_start:] = path[cycle_start:] + [prereq]
                return True

        path.pop()
        path_set.discard(node)
        return False

    for node in nodes:
        if node not in visited:
            path.clear()
            path_set.clear()
            if dfs(node):
                return path

    return nodes  # fallback


def get_self_referential_fields(object_name: str, schema: Dict[str, Any]) -> List[str]:
    """
    Returns the API names of fields on object_name where the lookup target is
    the same object (e.g., Account.ParentId → Account).

    These fields must be handled in a second pass after the object's initial load.

    Args:
        object_name: Salesforce object API name (e.g., "Account").
        schema:      Dict keyed by object API name → Salesforce describe result.

    Returns:
        List of field API names that are self-referential.
    """
    obj_schema = schema.get(object_name, {})
    fields = obj_schema.get("fields", [])
    self_ref = []

    for field in fields:
        if field.get("type") not in RELATIONSHIP_FIELD_TYPES:
            continue
        targets = field.get("referenceTo", [])
        if object_name in targets:
            self_ref.append(field["name"])

    return self_ref


if __name__ == "__main__":
    import json
    import sys

    # Quick smoke test with dummy schema
    dummy_schema = {
        "Account": {
            "fields": [
                {"name": "ParentId", "type": "reference", "referenceTo": ["Account"]},
                {"name": "OwnerId", "type": "reference", "referenceTo": ["User"]},
            ]
        },
        "Contact": {
            "fields": [
                {"name": "AccountId", "type": "reference", "referenceTo": ["Account"]},
                {"name": "OwnerId", "type": "reference", "referenceTo": ["User"]},
            ]
        },
        "Opportunity": {
            "fields": [
                {"name": "AccountId", "type": "reference", "referenceTo": ["Account"]},
                {"name": "OwnerId", "type": "reference", "referenceTo": ["User"]},
            ]
        },
        "Case": {
            "fields": [
                {"name": "AccountId", "type": "reference", "referenceTo": ["Account"]},
                {"name": "ContactId", "type": "reference", "referenceTo": ["Contact"]},
            ]
        },
    }

    objects = ["Contact", "Opportunity", "Case", "Account"]
    order = build_dependency_graph(objects, dummy_schema)
    print("Load order:", " → ".join(order))

    self_ref = get_self_referential_fields("Account", dummy_schema)
    print("Account self-referential fields:", self_ref)
