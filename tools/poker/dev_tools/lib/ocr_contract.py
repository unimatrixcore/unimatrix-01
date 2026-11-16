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
    if 'max_utf16' in rule and len(label.encode('utf-16-le', errors='surrogatepass')) // 2 > rule['max_utf16']:
        return False
    if 'prefix_max_utf16' in rule and len(label.rpartition(', NLHE')[0].encode('utf-16-le', errors='surrogatepass')) // 2 > rule['prefix_max_utf16']:
        return False
    if 'values' in rule and rule.get('values_exhaustive') is not False:
        return label in rule['values']
    return _patterns[category].fullmatch(label) is not None


def normalize_text(category, label, legacy_currency_icons=False):
    value = label.strip()
    aliases = CONTRACT.get('normalization', {})
    if category == 'suit':
        glyph = value.replace('\ufe0e', '').replace('\ufe0f', '')
        return aliases.get('suit_aliases', {}).get(glyph, glyph.lower())
    if category == 'card':
        rank = value.upper()
        return aliases.get('rank_aliases', {}).get(rank, rank)
    if category == 'dealer':
        return value.upper()
    if category == 'name':
        return value.replace('…', '...')
    if category == 'status':
        collapsed = ' '.join(value.split())
        return next((v for v in _categories['status']['values'] if v.lower() == collapsed.lower()), value)
    if category in ('winner', 'popup', 'combination', 'round_id'):
        return value
    value = ' '.join(value.split())
    if category == 'table_info':
        return value
    compact = ''.join(value.split())
    timer = re.fullmatch(aliases['pause_tokens'], compact, re.I) if category == 'pot' else None
    if timer:
        return f'Run It Twice pause ({timer[1]} sec)'
    if category == 'bank' and compact.lower() == 'all-in':
        return 'All-In'
    prefix = 'Pot: ' if category == 'pot' and compact[:4].lower() == 'pot:' else ''
    body = compact[4:] if prefix else compact
    amounts = list(re.finditer(aliases['amount_tokens'], body, re.I))
    if amounts and ''.join(m[0] for m in amounts) == body:
        parts = []
        for match in amounts:
            number = match[2].upper()
            formatted = 'No Chips' if number == 'NOCHIPS' else number[:-2] + ' BB' if number.endswith('BB') else number
            parts.append(match[1].upper() + ' ' + formatted)
        formatted = prefix + ' '.join(parts)
        if validate_text(category, formatted):
            return formatted
    return value


def normalize_region_text(region_id, category, label, legacy_currency_icons=False, currency_format=None):
    return label.strip() if currency_format is not None and category in ('bank', 'bet', 'pot', 'split_pot', 'amount', 'table_info') else normalize_text(category, label, legacy_currency_icons)


def validate_text_with_currency_format(category, label, allow_blank=False, currency_format=None):
    if currency_format is None or category not in ('bank', 'bet', 'pot', 'split_pot', 'amount', 'table_info'):
        return validate_text(category, label, allow_blank)
    if not isinstance(label, str):
        return False
    if label == '' and allow_blank:
        return True
    number = CONTRACT['format']['number_pattern']
    if category in CONTRACT['format']['short_cash_categories']:
        number += '[KMBTQP]?'
    def pattern(name):
        tokens = sorted((currency_format.index(token), token) for token in ('{0}', '{value}') if token in currency_format)
        result, offset = '', 0
        for index, (at, token) in enumerate(tokens):
            result += re.escape(currency_format[offset:at]) + (f'(?P<{name}>{number})' if index == 0 else f'(?P={name})')
            offset = at + len(token)
        return result + re.escape(currency_format[offset:])
    item = '[GS] ' + pattern('amount')
    if category == 'amount':
        item = r'\+?' + item
    elif category == 'bank':
        item = f'(?:{item}|[GS] No Chips|All-In)'
    elif category == 'pot':
        item = fr'(?:Pot: {item}|Run It Twice pause \([0-9]+ sec\))'
    elif category == 'split_pot':
        item = f'{item}(?:[ \t\r\n\f\v]+{item})*' if '{0}' not in currency_format and '{value}' not in currency_format else None
        if item is None:
            regex = re.compile('[GS] ' + pattern('amount') + r'(?=\s|\Z)')
            remaining, count = label, 0
            while match := regex.match(remaining):
                remaining = remaining[match.end():]
                count += 1
                if not remaining:
                    return True
                trimmed = remaining.lstrip()
                if trimmed == remaining:
                    return False
                remaining = trimmed
            return count > 0 and not remaining
    elif category == 'table_info':
        item = r'\S[^\r\n]*, NLHE - ' + item + '/' + pattern('big')
    return re.fullmatch(item, label) is not None


def validate_label(region_id, label):
    """Persistence adapter: preserve text exactly or reject it explicitly."""
    category = category_for_region(region_id)
    if category is None:
        raise ValueError(f'Unsupported OCR region: {region_id!r}')
    if not validate_text(category, label, allow_blank=True):
        raise ValueError(f'Invalid {category} format: {label!r}')
    return label
