"""Training/runtime adapter for the same JSON completed-text contract as review."""
import importlib.util
from pathlib import Path
import re

# A release can carry the collector library below its training scripts. Resolve
# either layout without importing Flask, opening a database or changing sys.path.
_root = Path(__file__).resolve().parent
_paths = [_root.parent / 'lib/ocr_contract.py', _root / 'lib/ocr_contract.py']
_contract_source = next((path for path in _paths if path.is_file()), None)
if _contract_source is None:
    raise ImportError('Collector lib/ocr_contract.py is required; no schema fallback is permitted')
_spec = importlib.util.spec_from_file_location('_collector_ocr_contract', _contract_source)
_contract = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_contract)

CONTRACT = _contract.CONTRACT
CONTRACT_PATH = _contract.CONTRACT_PATH
CONTRACT_IMPLEMENTATION_PATH = _contract.CONTRACT_IMPLEMENTATION_PATH
CONTRACT_SHA256 = _contract.CONTRACT_SHA256
category_for_region = _contract.category_for_region
validate_text = _contract.validate_text
# Preserve the compatibility fingerprint pointer, not a second validator copy.
_source = _contract_source.with_name('database.py')
REGION_IDS = {'name': 'seats[0].name', 'status': 'seats[0].status',
              'card': 'community_cards[0]', 'bank': 'seats[0].bank',
              'bet': 'seats[0].bet', 'dealer': 'seats[0].dealer',
              'pot': 'pot', 'split_pot': 'split_pot', 'round_id': 'round_id'}
STATUSES = set(CONTRACT['categories']['status']['values'])
PATTERNS = {category: rule.get('pattern') or '(?:' + '|'.join(re.escape(value) for value in rule['values']) + ')'
            for category, rule in CONTRACT['categories'].items() if category != 'status'}
MONEY = PATTERNS['bet']


def valid(row):
    """Validate exact nonempty training/runtime text (dealer also permits empty).

    Other blank targets require independent reviewed-negative provenance; format
    validation alone must never turn an unlabelled crop into a negative target.
    """
    if not isinstance(row, dict):
        return False
    return validate_text(row.get('category'), row.get('label'))
