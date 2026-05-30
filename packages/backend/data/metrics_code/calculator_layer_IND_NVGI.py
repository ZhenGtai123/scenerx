"""Calculator Layer.

Indicator ID:   IND_NVGI
Indicator Name: Normalized Vegetation Greenery Index (RGB-based)
Type:           TYPE B (custom layer-aware)

Description:
    A normalized RGB-based pixel index designed to substitute for satellite NDVI when only RGB street-view data is available. Higher NVGI separates green vegetation from other features in BSV/GSV imagery.

Formula: NVGI = G0 / sqrt(R0 * B0)  where  R0 = (R_pixel - R_min)/(R_max - R_min), G0 = (G_pixel - G_min)/(G_max - G_min), B0 = (B_pixel - B_min)/(B_max - B_min)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_NVGI",
    "name": "Normalized Vegetation Greenery Index (RGB-based)",
    "unit": "%",
    "formula": "NVGI = G0 / sqrt(R0 * B0)  where  R0 = (R_pixel - R_min)/(R_max - R_min), G0 = (G_pixel - G_min)/(G_max - G_min), B0 = (B_pixel - B_min)/(B_max - B_min)",
    "target_direction": "INCREASE",
    "definition": "A normalized RGB-based pixel index designed to substitute for satellite NDVI when only RGB street-view data is available. Higher NVGI separates green vegetation from other features in BSV/GSV imagery.",
    "category": "CAT_CMP",
    "calc_type": "custom",
    "variables": "R_pixel, G_pixel, B_pixel = raw RGB values of a pixel; R_min/max, G_min/max, B_min/max = per-image min/max of each channel; R0, G0, B0 = min-max normalized channel values.",
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
    """Normalized RGB Vegetation Index: NVGI = G0 / sqrt(R0 * B0)."""
    # v8.0 — orchestrator passes the original photograph alongside the
    # semantic map. This is an RGB photometric indicator; the formula
    # only makes sense on the actual photo, not on the ADE20K palette.
    if original_photo_path:
        image_path = original_photo_path
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img).astype(np.float64)
        R, G, B = arr[:,:,0], arr[:,:,1], arr[:,:,2]
        def norm(c): 
            cmin, cmax = c.min(), c.max()
            return (c - cmin) / (cmax - cmin + 1e-10)
        R0, G0, B0 = norm(R), norm(G), norm(B)
        nvgi = G0 / (np.sqrt(R0 * B0) + 1e-10)
        mask = _load_mask(mask_path, nvgi.shape[:2])
        if mask is not None:
            vals = nvgi[mask]
        else:
            vals = nvgi.flatten()
        if len(vals) == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        return {'success': True, 'value': round(float(vals.mean()), 4),
                'target_pixels': int(len(vals)), 'total_pixels': int(len(vals))}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
