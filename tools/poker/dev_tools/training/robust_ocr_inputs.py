"""Conservative, target-independent OCR input candidates.

Images are uint8 BGR, as returned by cv2.imread. The raw candidate is always
preserved. No label, category-specific palette, or border heuristic is used.
"""
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class InputConfig:
    include_grayscale: bool = False
    scale: float = 1.0


def prepare_candidates(image: np.ndarray, category: str, config: InputConfig = InputConfig()):
    """Return named independent BGR arrays; blank target regions are retained.

    Category is accepted for consistent training/runtime integration and is not
    used to guess text or erase pixels. Scaling is opt-in and may lose detail.
    """
    if not isinstance(category, str) or not category:
        raise ValueError('category must be a nonempty string')
    if not isinstance(image, np.ndarray) or image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3 or not image.size:
        raise ValueError('image must be a nonempty uint8 BGR image')
    if not np.isfinite(config.scale) or config.scale <= 0:
        raise ValueError('scale must be finite and positive')
    raw = image.copy()
    candidates = {'raw': raw}
    if config.include_grayscale:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        candidates['grayscale'] = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    if config.scale != 1:
        size = (max(1, round(image.shape[1] * config.scale)), max(1, round(image.shape[0] * config.scale)))
        candidates = {name: cv2.resize(value, size, interpolation=cv2.INTER_CUBIC if config.scale > 1 else cv2.INTER_AREA) for name, value in candidates.items()}
    return candidates
