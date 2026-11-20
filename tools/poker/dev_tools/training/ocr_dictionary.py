"""Ordered CTC vocabularies shared by candidate preparation and inference."""
import hashlib
import json
from pathlib import Path
import string


LEGACY_PROFILE = 'compact70'
DEFAULT_PROFILE = 'punctuation73'
PROFILES = (LEGACY_PROFILE, DEFAULT_PROFILE)
_BASE = ['blank', *string.digits, *string.ascii_uppercase, *string.ascii_lowercase, *'.#:-()']
_CHARACTERS = {LEGACY_PROFILE: [*_BASE, ' '], DEFAULT_PROFILE: [*_BASE, ',', '/', '*', ' ']}


def characters_for_profile(profile=DEFAULT_PROFILE):
    if profile not in _CHARACTERS:
        raise ValueError('Unsupported OCR dictionary profile')
    return list(_CHARACTERS[profile])


def validate_characters(characters, expected_profile=None):
    matches = [profile for profile, expected in _CHARACTERS.items() if characters == expected]
    if len(matches) != 1 or (expected_profile is not None and matches[0] != expected_profile):
        raise ValueError('OCR character dictionary does not match its ordered profile')
    return matches[0]


def dictionary_text(profile=DEFAULT_PROFILE):
    return '\n'.join(characters_for_profile(profile)[1:-1]) + '\n'


def read_dictionary(path, expected_profile=None):
    text = Path(path).read_bytes().decode('utf-8')
    characters = ['blank', *text.splitlines(), ' ']
    profile = validate_characters(characters, expected_profile)
    if text != dictionary_text(profile):
        raise ValueError('OCR dictionary file differs from its canonical encoding')
    return characters


def profile_metadata(profile=DEFAULT_PROFILE):
    characters = characters_for_profile(profile)
    return {'profile': profile, 'class_count': len(characters),
            'classes_sha256': hashlib.sha256(json.dumps(characters, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'dictionary_sha256': hashlib.sha256(dictionary_text(profile).encode()).hexdigest()}


def clean_start_directory(root, profile=DEFAULT_PROFILE):
    characters_for_profile(profile)
    return Path(root) / ('production-clean-start' if profile == LEGACY_PROFILE else 'production-clean-start-' + profile)


def validate_output_width(characters, width):
    validate_characters(characters)
    if isinstance(width, bool) or not isinstance(width, int) or width != len(characters):
        raise ValueError('OCR output head width does not match its character dictionary')
