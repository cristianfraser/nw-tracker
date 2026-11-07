"""The JSON Schemas of the files read in more than one language, and a stdlib validator for them.

The schemas are written from the zod schemas in `server/contracts/src/schemas/` into
`server/contracts/data/schemas/` (`npm run schema -w nw-tracker-contracts -- --shared`), so the
TypeScript side and Python agree on one definition (docs/untangle-plan.md F8): the cc-cards config,
the statement line rules, the parsers' JSON outputs and the card parser's CSV columns.

`validate` covers the keywords those schemas use (JSON Schema 2020-12 as zod emits it) and raises
on any other, so a schema that grows a keyword fails here instead of being half-checked.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "server" / "contracts" / "data" / "schemas"

# Annotations: no effect on validity. `format` is backed by a `pattern` wherever zod emits it.
_ANNOTATIONS = {"$schema", "description", "default", "format"}
_KNOWN = _ANNOTATIONS | {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "items",
    "enum",
    "const",
    "anyOf",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
}


class SchemaError(ValueError):
    pass


def load_schema(name: str) -> dict:
    """`<name>.schema.json` from the contracts data folder; missing is a broken checkout."""
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))


def card_parsed_statement_columns() -> list[str]:
    return json.loads((SCHEMA_DIR / "card-parsed-statement-columns.json").read_text(encoding="utf-8"))["columns"]


def _type_ok(value: Any, t: str) -> bool:
    if t == "object":
        return isinstance(value, dict)
    if t == "array":
        return isinstance(value, list)
    if t == "string":
        return isinstance(value, str)
    if t == "boolean":
        return isinstance(value, bool)
    if t == "null":
        return value is None
    if isinstance(value, bool):
        return False
    if t == "integer":
        return isinstance(value, int) or (isinstance(value, float) and value.is_integer())
    if t == "number":
        return isinstance(value, (int, float))
    raise SchemaError(f"unknown type {t!r}")


def _errors(value: Any, schema: Any, path: str) -> list[str]:
    if schema is True or schema == {}:
        return []
    if schema is False:
        return [f"{path}: not allowed"]
    unknown = set(schema) - _KNOWN
    if unknown:
        raise SchemaError(f"{path}: unsupported schema keyword(s) {sorted(unknown)}")
    errs: list[str] = []
    if "anyOf" in schema:
        if all(_errors(value, s, path) for s in schema["anyOf"]):
            errs.append(f"{path}: matches none of anyOf")
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            return errs + [f"{path}: expected {'/'.join(types)}, got {type(value).__name__}"]
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{path}: {value!r} not in {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        errs.append(f"{path}: {value!r} is not {schema['const']!r}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(f"{path}: {value!r} does not match {schema['pattern']}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            errs.append(f"{path}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append(f"{path}: longer than {schema['maxLength']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append(f"{path}: {value} below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errs.append(f"{path}: {value} above {schema['maximum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errs.append(f"{path}: {value} not above {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            errs.append(f"{path}: {value} not below {schema['exclusiveMaximum']}")
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            errs += _errors(item, schema["items"], f"{path}[{i}]")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errs.append(f"{path}: missing {key!r}")
        for key, item in value.items():
            if "propertyNames" in schema:
                errs += _errors(key, schema["propertyNames"], f"{path}.<key {key!r}>")
            if key in props:
                errs += _errors(item, props[key], f"{path}.{key}")
            elif "additionalProperties" in schema:
                errs += _errors(item, schema["additionalProperties"], f"{path}.{key}")
    return errs


def validate(value: Any, schema: dict, what: str = "$") -> None:
    """Raises `SchemaError` listing every place `value` breaks `schema`."""
    errs = _errors(value, schema, what)
    if errs:
        raise SchemaError("; ".join(errs[:20]) + (f" (+{len(errs) - 20} more)" if len(errs) > 20 else ""))
