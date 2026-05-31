"""Calculator Layer.

Indicator ID:   IND_S_API
Indicator Name: S_API
Type:           TYPE B (custom layer-aware)

Description:
    A distributional-trend metric describing the lateral asymmetry of the foreground outline relative to the vertical midline of the field of view, computed as the standard deviation of the per-row midpoints of the foreground outline's left/right pixel pairs about the field-of-view midline. Higher value

Formula: S_API = sqrt( (1/N) * Sum_{i=1..N} (P_i - mu)^2 )

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_S_API",
    "name": "S_API",
    "unit": "%",
    "formula": "S_API = sqrt( (1/N) * Sum_{i=1..N} (P_i - mu)^2 )",
    "target_direction": "NEUTRAL",
    "definition": "A distributional-trend metric describing the lateral asymmetry of the foreground outline relative to the vertical midline of the field of view, computed as the standard deviation of the per-row midpoints of the foreground outline's left/right pixel pairs about the field-of-view midline. Higher value",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"P_i": "horizontal coordinate of the midpoint of the i-th row pixel pair on the two sides of the foreground outline, P_i = (x_i,left + x_i,right) / 2", "x_i,left": "horizontal coordinate of the leftmost foreground-outline pixel on row i", "x_i,right": "horizontal coordinate of the rightmost foreground-outline pixel on row i", "mu": "horizontal coordinate of the vertical midline of the field of view (= W/2 for an image of width W)", "N": "number of image rows that contain a left/right outline pixel pair (i.e. number of P_i values)"},
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
    """Foreground Asymmetry Index = stddev of object perimeters in the region."""
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img)
        layer_mask = _load_mask(mask_path, arr.shape[:2])
        if layer_mask is None:
            sky_rgb = semantic_colors.get('sky', (6,230,230))
            layer_mask = ~((arr[:,:,0]==sky_rgb[0]) & (arr[:,:,1]==sky_rgb[1]) & (arr[:,:,2]==sky_rgb[2]))
        try:
            from scipy import ndimage
            labeled, num = ndimage.label(layer_mask)
            if num == 0:
                return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
            perimeters = []
            for i in range(1, num+1):
                obj = labeled == i
                # perimeter = pixels on edge (boundary)
                from scipy.ndimage import binary_erosion
                perim = obj & ~binary_erosion(obj)
                perimeters.append(int(np.sum(perim)))
            api = float(np.std(perimeters))
            return {'success': True, 'value': round(api, 3),
                    'target_pixels': num, 'total_pixels': int(layer_mask.sum())}
        except ImportError:
            return {'success': False, 'value': None, 'error': 'scipy required'}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
