"""Calculator Layer.

Indicator ID:   IND_S_PSI
Indicator Name: S_PSI
Type:           TYPE B (custom layer-aware)

Description:
    A distributional trend metric describing how similar in shape the multiple holes (open patches inside the foreground) are. Computed as the coefficient of variation of the perimeter-area shape descriptor (0.25*Pi/sqrt(Ai)) across all N holes. Zero means all holes are similar in shape; larger values m

Formula: S_PSI = sqrt( (1/N) * sum_i ( (0.25*Pi/sqrt(Ai)) - mu )^2 ) / mu , where mu = (1/N) sum_i (0.25*Pi/sqrt(Ai))

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_S_PSI",
    "name": "S_PSI",
    "unit": "%",
    "formula": "S_PSI = sqrt( (1/N) * sum_i ( (0.25*Pi/sqrt(Ai)) - mu )^2 ) / mu , where mu = (1/N) sum_i (0.25*Pi/sqrt(Ai))",
    "target_direction": "NEUTRAL",
    "definition": "A distributional trend metric describing how similar in shape the multiple holes (open patches inside the foreground) are. Computed as the coefficient of variation of the perimeter-area shape descriptor (0.25*Pi/sqrt(Ai)) across all N holes. Zero means all holes are similar in shape; larger values m",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"Pi": "perimeter pixels of the i-th hole inside the foreground", "Ai": "area pixels of the i-th hole inside the foreground", "N": "number of holes inside the foreground", "mu": "mean of the per-hole shape ratios"},
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
    """Foreground Hole-Shape Similarity Index: CV of (0.25*P_hole/sqrt(A_hole)) across holes."""
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img)
        layer_mask = _load_mask(mask_path, arr.shape[:2])
        if layer_mask is None:
            sky_rgb = semantic_colors.get('sky', (6,230,230))
            layer_mask = ~((arr[:,:,0]==sky_rgb[0]) & (arr[:,:,1]==sky_rgb[1]) & (arr[:,:,2]==sky_rgb[2]))
        try:
            from scipy import ndimage
            from scipy.ndimage import binary_erosion
            inv = ~layer_mask
            labeled, num = ndimage.label(inv)
            if num == 0:
                return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
            roundnesses = []
            for i in range(1, num+1):
                hole = labeled == i
                A = float(hole.sum())
                if A < 5: continue  # skip tiny noise
                P = float((hole & ~binary_erosion(hole)).sum())
                roundnesses.append(0.25 * P / np.sqrt(A))
            if not roundnesses:
                return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
            mu = float(np.mean(roundnesses))
            psi = float(np.std(roundnesses) / mu) if mu > 0 else 0.0
            return {'success': True, 'value': round(psi, 4),
                    'target_pixels': len(roundnesses), 'total_pixels': int(layer_mask.size)}
        except ImportError:
            return {'success': False, 'value': None, 'error': 'scipy required'}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
