"""Calculator Layer.

Indicator ID:   IND_CRI
Indicator Name: Color Richness Index of Vegetation
Type:           TYPE B (custom layer-aware)

Description:
    Improvement on visual entropy by weighting each segmented vegetation region's entropy contribution by a Hasler-Susstrunk colorfulness factor (sigma_rgyb + 0.3 * mu_rgyb). Blends information richness with colorfulness over plant communities.

Formula: CR = sum_{i=1..n} M * P_i * log(P_i) where M = sigma_rgyb + 0.3 * mu_rgyb; rg = R - G; yb = 0.5*(R + G) - B; sigma_rgyb = sqrt(sigma_rg^2 + sigma_yb^2); mu_rgyb = sqrt(mu_rg^2 + mu_yb^2)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_CRI",
    "name": "Color Richness Index of Vegetation",
    "unit": "%",
    "formula": "CR = sum_{i=1..n} M * P_i * log(P_i) where M = sigma_rgyb + 0.3 * mu_rgyb; rg = R - G; yb = 0.5*(R + G) - B; sigma_rgyb = sqrt(sigma_rg^2 + sigma_yb^2); mu_rgyb = sqrt(mu_rg^2 + mu_yb^2)",
    "target_direction": "NEUTRAL",
    "definition": "Improvement on visual entropy by weighting each segmented vegetation region's entropy contribution by a Hasler-Susstrunk colorfulness factor (sigma_rgyb + 0.3 * mu_rgyb). Blends information richness with colorfulness over plant communities.",
    "category": "CAT_CMP",
    "calc_type": "custom",
    "variables": "P_i = pixel proportion of the i-th vegetation region in the segmentation; M = colorfulness factor combining standard deviation and mean of rg / yb opponent channels",
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



def calculate_for_layer(image_path: str, mask_path: Optional[str] = None, original_photo_path: Optional[str] = None) -> Dict:
    """Hasler-Susstrunk colorfulness (sigma_rgyb + 0.3*mu_rgyb) over the region."""

    # v8.0 — the orchestrator now ships the original photo path alongside
    # the semantic-map path. This calculator computes a photographic
    # feature, so prefer the photo when available.
    if original_photo_path:
        image_path = original_photo_path
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img).astype(np.float64)
        mask = _load_mask(mask_path, arr.shape[:2])
        if mask is not None:
            pixels = arr[mask]
        else:
            pixels = arr.reshape(-1, 3)
        if len(pixels) == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        R, G, B = pixels[:,0], pixels[:,1], pixels[:,2]
        rg = R - G
        yb = 0.5 * (R + G) - B
        sigma = np.sqrt(np.var(rg) + np.var(yb))
        mu = np.sqrt(np.mean(rg)**2 + np.mean(yb)**2)
        colorfulness = float(sigma + 0.3 * mu)
        return {'success': True, 'value': round(colorfulness, 3),
                'target_pixels': int(len(pixels)), 'total_pixels': int(len(pixels))}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
