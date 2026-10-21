"""Validated expression definitions shared by local image processing steps."""

from __future__ import annotations

import json
import math
from pathlib import Path

CONFIG_ROOT = Path(__file__).resolve().parent.parent / "configs"
KEYS = {"name", "label", "requestLabel", "prompt", "editableLayers", "mask", "extraction",
        "registration", "split", "placeholderFrom", "checkFrontHair"}
MASK_KEYS = {"dilationRatio", "minimumDilation", "fillBounds", "mouthLimits"}


def validate_expressions(config, layer_map):
    def fail():
        raise ValueError("Invalid expression definitions. Check names, fields and types against the layer map.")

    def text(value):
        return isinstance(value, str) and bool(value.strip())

    targets = {entry["target"] for entry in layer_map["layers"]}
    if (not isinstance(config, dict) or set(config) != {"schemaVersion", "expressions"}
            or type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1
            or not isinstance(config["expressions"], list) or not config["expressions"]):
        fail()
    names = set()
    for item in config["expressions"]:
        if not isinstance(item, dict) or set(item) != KEYS:
            fail()
        name = item["name"]
        if (not text(name) or not name.isascii() or not name[0].islower()
                or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789_" for c in name)
                or name not in targets or name in names or not text(item["label"])
                or not isinstance(item["editableLayers"], list)
                or any(not isinstance(value, str) or value not in targets for value in item["editableLayers"])
                or len(set(item["editableLayers"])) != len(item["editableLayers"])
                or item["registration"] not in ("eyes", "mouth", "face", "none")
                or type(item["split"]) is not bool or type(item["checkFrontHair"]) is not bool
                or not (item["placeholderFrom"] is None or (isinstance(item["placeholderFrom"], str)
                        and item["placeholderFrom"] in targets and item["placeholderFrom"] != name))):
            fail()
        if item["prompt"] is None:
            if any(item[key] is not None for key in ("requestLabel", "mask", "extraction")) or item["editableLayers"]:
                fail()
        else:
            mask = item["mask"]
            if (not text(item["prompt"]) or not text(item["requestLabel"]) or not item["editableLayers"]
                    or item["extraction"] not in ("diff", "soft") or not isinstance(mask, dict) or not MASK_KEYS <= set(mask) or not set(mask) <= MASK_KEYS | {"region", "upperExpansionRatio"}
                    or type(mask["dilationRatio"]) not in (int, float) or not math.isfinite(mask["dilationRatio"])
                    or not 0 <= mask["dilationRatio"] <= 1
                    or type(mask["minimumDilation"]) is not int or not 0 <= mask["minimumDilation"] <= 128
                    or type(mask["fillBounds"]) is not bool or type(mask["mouthLimits"]) is not bool):
                fail()
        if item["mask"] is not None:
            mask = item["mask"]
            if "region" in mask and mask["region"] != "cheeks":
                fail()
            if "upperExpansionRatio" in mask and (type(mask["upperExpansionRatio"]) not in (int, float)
                    or not math.isfinite(mask["upperExpansionRatio"]) or not 0 <= mask["upperExpansionRatio"] <= 1):
                fail()
        if item["extraction"] == "soft" and (item["mask"].get("region") != "cheeks" or item["registration"] != "face"):
            fail()
        names.add(name)
    if any(entry.get("requiredForProduction") is True and entry["target"] not in names for entry in layer_map["layers"]):
        fail()
    return [{**item,
             "sources": [entry["source"] for entry in reversed(layer_map["layers"]) if entry["target"] == item["name"]],
             "requiredForProduction": any(entry["target"] == item["name"] and entry.get("requiredForProduction") is True
                                          for entry in layer_map["layers"])} for item in config["expressions"]]


def load_expressions(layer_map=None, definition_file=None):
    if layer_map is None:
        layer_map = json.loads((CONFIG_ROOT / "layer-map.json").read_text(encoding="utf-8"))
    config = json.loads((definition_file or CONFIG_ROOT / "expressions.json").read_text(encoding="utf-8"))
    return validate_expressions(config, layer_map)
