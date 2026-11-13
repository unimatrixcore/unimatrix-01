"""Explicit text/blank/unknown decisions; never guess or repair OCR content.

Spatial/temporal agreement can reject inconsistent predictions but cannot prove
correctness: correlated views can repeat the same mistake. Evaluate accepted
errors and coverage together on the actual runtime path before release.
"""
from dataclasses import dataclass
import math

from ocr_output import canonicalize_output
from schemas import PATTERNS, valid


@dataclass(frozen=True)
class Decision:
    state: str
    text: str | None
    reason: str


def decide_views(category, predictions, required_views=5):
    """Require every expected view, successful inference and exact agreement.

    A schema-invalid nonempty prediction is unknown, never a blank negative.
    Caller must supply the actual fresh raw views, not duplicate predictions.
    Confidence is retained as evidence but never used as a correctness claim.
    """
    if category not in PATTERNS and category != 'status':
        raise ValueError('Unknown region category')
    if required_views < 2 or len(predictions) != required_views:
        return Decision('unknown', None, 'missing_views')
    texts = []
    for prediction in predictions:
        if prediction.get('error'):
            return Decision('unknown', None, 'processing_error')
        raw = prediction.get('raw_prediction')
        if not isinstance(raw, str):
            return Decision('unknown', None, 'missing_raw_prediction')
        confidence = prediction.get('confidence')
        if not isinstance(confidence, (int,float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            return Decision('unknown', None, 'invalid_confidence')
        text = canonicalize_output(raw, category)
        # Whitespace-only nonempty output is not evidence of a blank region.
        if raw and not text:
            return Decision('unknown', None, 'nonempty_unusable_output')
        if text and not valid({'category':category,'label':text}):
            return Decision('unknown', None, 'schema_invalid')
        texts.append(text)
    if len(set(texts)) != 1:
        return Decision('unknown', None, 'view_disagreement')
    if not texts[0]:
        return Decision('blank', '', 'all_views_blank')
    return Decision('text', texts[0], 'all_views_agree')


class TemporalAgreement:
    """Confirm a spatial decision on distinct, ordered capture opportunities.

    The capture layer must provide genuine frame identity/time and table epoch.
    Never reuse a cached accepted value across a rejected or missing frame.
    """
    def __init__(self, max_gap_seconds=1.5):
        if max_gap_seconds <= 0:
            raise ValueError('Maximum gap must be positive')
        self.max_gap_seconds = max_gap_seconds
        self.pending = {}

    def reset(self):
        self.pending.clear()

    def update(self, region, table_epoch, frame_id, captured_at, decision):
        if not region or not table_epoch or not frame_id or not math.isfinite(captured_at):
            raise ValueError('Fresh capture provenance is required')
        if decision.state not in ('text','blank','unknown'):
            raise ValueError('Unknown decision state')
        if decision.state == 'unknown':
            self.pending.pop(region,None)
            return decision
        current = (table_epoch,frame_id,captured_at,decision.state,decision.text)
        previous = self.pending.get(region)
        if previous and (captured_at <= previous[2] or frame_id == previous[1]):
            self.pending.pop(region,None)
            return Decision('unknown',None,'duplicate_or_out_of_order_frame')
        self.pending[region] = current
        if previous and previous[0] == table_epoch and captured_at-previous[2] <= self.max_gap_seconds and previous[3:] == current[3:]:
            return Decision(decision.state,decision.text,'two_fresh_frames_agree')
        return Decision('unknown',None,'awaiting_fresh_frame_agreement')
