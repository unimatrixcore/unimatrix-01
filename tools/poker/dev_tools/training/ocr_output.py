"""Formatting contracts for recognized OCR fields; never repairs text or digits."""
import re


def canonicalize_output(text,category):
    if category=='name':
        # Anonymous player names use one literal space; keep their exact label.
        if re.fullmatch(r'Player [1-9]', text):
            return text
        # Other names retain the existing letter-spacing normalization.
        return ''.join(text.split())
    if category in ('bank','bet','pot','split_pot'):
        # The schema fixes separators around currency and BB. Parse only when
        # every non-whitespace character already matches; never repair a glyph.
        compact=''.join(text.split())
        prefix=''
        if category=='pot':
            if not compact.startswith('Pot:'):return text
            prefix='Pot: ';compact=compact[4:]
        amounts=re.findall(r'([GS])(\d+(?:\.\d)?)BB',compact)
        if amounts and ''.join(c+n+'BB' for c,n in amounts)==compact and (category=='split_pot' or len(amounts)==1):
            return prefix+' '.join(c+' '+n+' BB' for c,n in amounts)
    return text
