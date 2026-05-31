"""Calculator Layer.

Indicator ID:   IND_S_ERI
Indicator Name: S_ERI
Type:           TYPE B (custom layer-aware)

Description:
    A shape metric describing the irregularity of the foreground outline derived from semantic-segmented street/scenic images, based on the isoperimetric inequality. Compares the perimeter of the foreground region to the square root of its area; values near sqrt(2*pi) indicate circular outlines, values 

Formula: S_ERI = 0.25 * P / sqrt(A)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_S_ERI",
    "name": "S_ERI",
    "unit": "%",
    "formula": "S_ERI = 0.25 * P / sqrt(A)",
    "target_direction": "NEUTRAL",
    "definition": "A shape metric describing the irregularity of the foreground outline derived from semantic-segmented street/scenic images, based on the isoperimetric inequality. Compares the perimeter of the foreground region to the square root of its area; values near sqrt(2*pi) indicate circular outlines, values ",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"P": "number of pixels on the foreground outline (perimeter)", "A": "number of pixels contained within the foreground (area)"},
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
    """Foreground Edge Roughness Index = 0.25 * P / sqrt(A) where P=perimeter, A=area."""
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img)
        layer_mask = _load_mask(mask_path, arr.shape[:2])
        if layer_mask is None:
            sky_rgb = semantic_colors.get('sky', (6,230,230))
            layer_mask = ~((arr[:,:,0]==sky_rgb[0]) & (arr[:,:,1]==sky_rgb[1]) & (arr[:,:,2]==sky_rgb[2]))
        try:
            from scipy.ndimage import binary_erosion
            A = float(layer_mask.sum())
            if A == 0: return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
            P = float((layer_mask & ~binary_erosion(layer_mask)).sum())
            eri = 0.25 * P / np.sqrt(A)
            return {'success': True, 'value': round(float(eri), 4),
                    'target_pixels': int(A), 'total_pixels': int(layer_mask.size)}
        except ImportError:
            return {'success': False, 'value': None, 'error': 'scipy required'}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
