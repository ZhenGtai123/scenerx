"""Calculator Layer.

Indicator ID:   IND_FG_DEPTH_LV
Indicator Name: Foreground Maximum Depth Value (P_LV)
Type:           TYPE B (custom layer-aware)

Description:
    An absolute-value position metric: the maximum depth value across all pixels in the foreground, derived from monocular depth estimation grayscale (1-256). High values mean the foreground starts close to the observer; low values mean the foreground starts far from the observer.

Formula: P_LV = max_{i in Foreground} Di

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_FG_DEPTH_LV",
    "name": "Foreground Maximum Depth Value (P_LV)",
    "unit": "%",
    "formula": "P_LV = max_{i in Foreground} Di",
    "target_direction": "NEUTRAL",
    "definition": "An absolute-value position metric: the maximum depth value across all pixels in the foreground, derived from monocular depth estimation grayscale (1-256). High values mean the foreground starts close to the observer; low values mean the foreground starts far from the observer.",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"Di": "depth value (1-256 grayscale) of the i-th pixel in the foreground"},
    "confirmation_count": 1
}


print(f"Calculator loaded: {INDICATOR['id']}")


def _load_mask(mask_path: Optional[str], target_shape) -> Optional[np.ndarray]:
    """Load a layer mask as boolean numpy array, resized to target_shape."""
    if not mask_path:
        return None
    try:
        with Image.open(mask_path) as mask_img:
            mask_img = mask_img.convert("L")
            if mask_img.size != (target_shape[1], target_shape[0]):
                mask_img = mask_img.resize((target_shape[1], target_shape[0]), Image.NEAREST)
            return np.array(mask_img) > 127
    except Exception:
        return None



def calculate_for_layer(image_path: str, mask_path: Optional[str] = None, original_photo_path: Optional[str] = None, depth_map_path: Optional[str] = None) -> Dict:
    """Foreground Maximum Depth Value within mask."""
    # v8.0 — orchestrator now ships the depth map alongside the
    # semantic map. This indicator reads depth pixel values, not class
    # labels, so a semantic map gives meaningless results. Prefer the
    # explicit depth_map_path when present.
    if depth_map_path:
        image_path = depth_map_path
    try:
        img = Image.open(image_path)
        arr = np.array(img).astype(np.float64)
        if arr.ndim == 3: arr = arr.mean(axis=2)
        mask = _load_mask(mask_path, arr.shape[:2])
        if mask is None:
            mask = np.ones(arr.shape[:2], dtype=bool)
        vals = arr[mask]
        if len(vals) == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        return {'success': True, 'value': float(vals.max()),
                'target_pixels': int(mask.sum()), 'total_pixels': int(mask.size)}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
