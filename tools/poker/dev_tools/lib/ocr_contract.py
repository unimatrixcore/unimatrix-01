"""Shared completed-text rules; importing this module opens no dataset or model.

The JSON file is also supplied to the browser. Format validity is separate from
pixel correctness, and storage's explicit blank permission is not proof that a
crop is a visually verified negative.
"""
import hashlib
import json
from pathlib import Path
import re


CONTRACT_IMPLEMENTATION_PATH = Path(__file__).resolve()
CONTRACT_PATH = CONTRACT_IMPLEMENTATION_PATH.parents[1] / 'ocr_contract.json'
_raw_contract = CONTRACT_PATH.read_bytes()
CONTRACT_SHA256 = hashlib.sha256(_raw_contract).hexdigest()
CONTRACT = json.loads(_raw_contract)
_categories = CONTRACT['categories']
_region_rules = [(rule['category'], re.compile(rule['pattern']))
                 for rule in CONTRACT['region_rules']]
_patterns = {category: re.compile(rule['pattern'])
             for category, rule in _categories.items() if 'pattern' in rule}


def category_for_region(region_id):
    """Recognize a complete configured OCR field, never a matching substring."""
    if not isinstance(region_id, str):
        return None
    for category, pattern in _region_rules:
        if pattern.fullmatch(region_id):
            return category
    return None


def validate_text(category, label, allow_blank=False):
    """Validate exact text; only known categories may store explicit blanks."""
    if not isinstance(category, str) or category not in _categories or not isinstance(label, str):
        return False
    if label == '' and allow_blank:
        return True
    rule = _categories[category]
    if 'values' in rule:
        return label in rule['values']
    return _patterns[category].fullmatch(label) is not None


def validate_label(region_id, label):
    """Persistence adapter: preserve text exactly or reject it explicitly."""
    category = category_for_region(region_id)
    if category is None:
        raise ValueError(f'Unsupported OCR region: {region_id!r}')
    if not validate_text(category, label, allow_blank=True):
        raise ValueError(f'Invalid {category} format: {label!r}')
    return label
