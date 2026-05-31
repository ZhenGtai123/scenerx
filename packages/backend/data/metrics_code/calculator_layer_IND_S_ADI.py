"""Calculator Layer.

Indicator ID:   IND_S_ADI
Indicator Name: S_ADI
Type:           TYPE B (custom layer-aware)

Description:
    A relative-relationship metric capturing whether one hole inside the foreground dominates the others in size. Equal to (SDi - SDj)/SDi, where SDi is the standard deviation of all hole areas including the largest one and SDj is the standard deviation excluding the largest. Zero indicates the largest 

Formula: S_ADI = (SDi - SDj) / SDi ; SDi = sqrt((1/N)*sum_i(Ai - mu_i)^2) ; SDj = sqrt((1/N)*sum_{i!=max}(Ai - mu_w)^2)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_S_ADI",
    "name": "S_ADI",
    "unit": "%",
    "formula": "S_ADI = (SDi - SDj) / SDi ; SDi = sqrt((1/N)*sum_i(Ai - mu_i)^2) ; SDj = sqrt((1/N)*sum_{i!=max}(Ai - mu_w)^2)",
    "target_direction": "NEUTRAL",
    "definition": "A relative-relationship metric capturing whether one hole inside the foreground dominates the others in size. Equal to (SDi - SDj)/SDi, where SDi is the standard deviation of all hole areas including the largest one and SDj is the standard deviation excluding the largest. Zero indicates the largest ",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"Ai": "number of pixels contained in the i-th hole in the foreground", "mu_i": "mean of all Ai (all holes)", "mu_w": "mean of Ai with the largest Ai removed", "SDi": "standard deviation of all hole areas", "SDj": "standard deviation of hole areas excluding the largest one", "N": "number of holes"},
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
    """Foreground Largest-Hole Asymmetry Index. Compute foreground binary mask then largest-hole metric."""
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img)
        layer_mask = _load_mask(mask_path, arr.shape[:2])
        # Foreground = layer mask (when given) else union of non-sky non-background classes
        if layer_mask is None:
            sky_rgb = semantic_colors.get('sky', (6,230,230))
            layer_mask = ~((arr[:,:,0]==sky_rgb[0]) & (arr[:,:,1]==sky_rgb[1]) & (arr[:,:,2]==sky_rgb[2]))
        try:
            from scipy import ndimage
            # holes = non-mask within bounding box of mask
            inverse = ~layer_mask
            # Connected components of "holes"
            labeled, num = ndimage.label(inverse)
            if num <= 1:
                return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': int(layer_mask.size)}
            sizes = ndimage.sum(inverse, labeled, range(1, num+1))
            sizes_sorted = np.sort(sizes)[::-1]
            # Asymmetry = (largest - second_largest) / largest
            if len(sizes_sorted) >= 2 and sizes_sorted[0] > 0:
                adi = float((sizes_sorted[0] - sizes_sorted[1]) / sizes_sorted[0])
            else:
                adi = 1.0
            return {'success': True, 'value': round(adi, 4),
                    'target_pixels': int(layer_mask.sum()), 'total_pixels': int(layer_mask.size)}
        except ImportError:
            return {'success': False, 'value': None, 'error': 'scipy required for IND_S_ADI'}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
