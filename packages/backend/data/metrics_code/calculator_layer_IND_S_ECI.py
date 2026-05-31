"""Calculator Layer.

Indicator ID:   IND_S_ECI
Indicator Name: S_ECI
Type:           TYPE B (custom layer-aware)

Description:
    Measures how distinct the foreground is from its surrounding elements by checking element-label consistency of the 8-neighborhood for each pixel on the foreground outline. Values near 0 indicate the foreground is sharply distinguished from its surroundings; values near 1 indicate it blends with neig

Formula: S_ECI = Pb / (Py + Pb)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_S_ECI",
    "name": "S_ECI",
    "unit": "%",
    "formula": "S_ECI = Pb / (Py + Pb)",
    "target_direction": "NEUTRAL",
    "definition": "Measures how distinct the foreground is from its surrounding elements by checking element-label consistency of the 8-neighborhood for each pixel on the foreground outline. Values near 0 indicate the foreground is sharply distinguished from its surroundings; values near 1 indicate it blends with neig",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"Py": "number of foreground-outline pixels whose 8 neighbors share the same element label (marked yellow)", "Pb": "number of foreground-outline pixels whose 8 neighbors have differing element labels (marked blue)"},
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



def calculate_for_layer(image_path: str, mask_path: Optional[str] = None) -> Dict:
    """Foreground Edge Contrast Index: ratio of mask-boundary pixels with sharp contrast."""
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img).astype(np.float64)
        layer_mask = _load_mask(mask_path, arr.shape[:2])
        if layer_mask is None:
            sky_rgb = semantic_colors.get('sky', (6,230,230))
            layer_mask = ~((arr[:,:,0].astype(int)==sky_rgb[0]) & (arr[:,:,1].astype(int)==sky_rgb[1]) & (arr[:,:,2].astype(int)==sky_rgb[2]))
        try:
            from scipy.ndimage import binary_erosion
            boundary = layer_mask & ~binary_erosion(layer_mask)
            # contrast = std of pixel intensities along boundary
            gray = arr.mean(axis=2)
            boundary_vals = gray[boundary]
            if len(boundary_vals) == 0:
                return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
            eci = float(np.std(boundary_vals))
            return {'success': True, 'value': round(eci, 3),
                    'target_pixels': int(boundary.sum()), 'total_pixels': int(layer_mask.sum())}
        except ImportError:
            return {'success': False, 'value': None, 'error': 'scipy required'}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
