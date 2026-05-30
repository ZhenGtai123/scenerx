"""Calculator Layer.

Indicator ID:   IND_EXG
Indicator Name: Excess Green Index (Pixel-Color Vegetation Index)
Type:           TYPE B (custom layer-aware)

Description:
    A pixel-level RGB-derived index that enhances green vegetation contrast in street-view images. Computed for every pixel from the normalized RGB bands; image-level EXG values can be averaged or thresholded (e.g. via Otsu) to extract vegetation without semantic segmentation.

Formula: ExG = 2*G - R - B ; per-image vegetation visibility = #{pixels: ExG > Otsu(ExG)} / Pixels_total

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_EXG",
    "name": "Excess Green Index (Pixel-Color Vegetation Index)",
    "unit": "%",
    "formula": "ExG = 2*G - R - B ; per-image vegetation visibility = #{pixels: ExG > Otsu(ExG)} / Pixels_total",
    "target_direction": "INCREASE",
    "definition": "A pixel-level RGB-derived index that enhances green vegetation contrast in street-view images. Computed for every pixel from the normalized RGB bands; image-level EXG values can be averaged or thresholded (e.g. via Otsu) to extract vegetation without semantic segmentation.",
    "category": "CAT_CMP",
    "calc_type": "custom",
    "variables": "G, R, B = normalized green/red/blue band values of a pixel after segmentation-mean normalization (range 0-1); Otsu(ExG) = automatically chosen threshold per image.",
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
    """Excess Green Index threshold count. ExG = 2G-R-B, Otsu threshold."""
    # v8.0 — orchestrator passes the original photograph alongside the
    # semantic map. This is an RGB photometric indicator; the formula
    # only makes sense on the actual photo, not on the ADE20K palette.
    if original_photo_path:
        image_path = original_photo_path
    try:
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img).astype(np.float64) / 255.0
        R, G, B = arr[:,:,0], arr[:,:,1], arr[:,:,2]
        exg = 2*G - R - B
        # Otsu threshold via histogram
        hist, edges = np.histogram(exg.flatten(), bins=256)
        if hist.sum() == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        p = hist / hist.sum()
        omega = np.cumsum(p)
        mu = np.cumsum(p * (edges[:-1] + np.diff(edges)/2))
        muT = mu[-1]
        sigma_b = (muT * omega - mu) ** 2 / (omega * (1 - omega) + 1e-10)
        thresh_idx = np.argmax(sigma_b)
        thresh = edges[thresh_idx]
        green_mask = exg > thresh
        mask = _load_mask(mask_path, exg.shape[:2])
        if mask is not None:
            n_green = int(np.sum(green_mask & mask))
            n_total = int(np.sum(mask))
        else:
            n_green = int(np.sum(green_mask))
            n_total = int(green_mask.size)
        if n_total == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        return {'success': True, 'value': round(n_green / n_total * 100.0, 3),
                'target_pixels': n_green, 'total_pixels': n_total}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
