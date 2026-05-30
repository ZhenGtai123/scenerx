"""Calculator Layer.

Indicator ID:   IND_GLCM_ENT
Indicator Name: Texture Entropy (GLCM Entropy)
Type:           TYPE B (custom layer-aware)

Description:
    Gray-Level Co-occurrence Matrix entropy applied to a street-view panorama, measuring textural non-uniformity / complexity of recurring local visual patterns.

Formula: vis_texture = - Σ_{i=0..255} Σ_{j=0..255} pg_{ij} * log2 C_{ij}  where C_{ij} is the normalized GLCM entry at offset (Δx, Δy)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_GLCM_ENT",
    "name": "Texture Entropy (GLCM Entropy)",
    "unit": "%",
    "formula": "vis_texture = - Σ_{i=0..255} Σ_{j=0..255} pg_{ij} * log2 C_{ij}  where C_{ij} is the normalized GLCM entry at offset (Δx, Δy)",
    "target_direction": "NEUTRAL",
    "definition": "Gray-Level Co-occurrence Matrix entropy applied to a street-view panorama, measuring textural non-uniformity / complexity of recurring local visual patterns.",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": "C_{ij} = normalized count in the GLCM at grayscale pair (i, j); pg_{ij} = associated probability of that grayscale pair.",
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
    """GLCM entropy over the region. Uses scikit-image graycomatrix if available."""

    # v8.0 — the orchestrator now ships the original photo path alongside
    # the semantic-map path. This calculator computes a photographic
    # feature, so prefer the photo when available.
    if original_photo_path:
        image_path = original_photo_path
    try:
        img = Image.open(image_path).convert('L')  # grayscale
        arr = np.array(img)
        mask = _load_mask(mask_path, arr.shape[:2])
        if mask is not None:
            # Apply mask: set non-mask pixels to 0 (ignored as background)
            arr_masked = np.where(mask, arr, 0)
        else:
            arr_masked = arr
        try:
            from skimage.feature import graycomatrix
            # Quantize to 8 levels for speed
            arr8 = (arr_masked // 32).astype(np.uint8)
            g = graycomatrix(arr8, distances=[1], angles=[0], levels=8, symmetric=True, normed=True)
            P = g[:,:,0,0]
            P = P / (P.sum() + 1e-10)
            entropy = -np.sum(P[P>0] * np.log2(P[P>0]))
        except ImportError:
            # Fallback: simple histogram entropy
            hist, _ = np.histogram(arr_masked, bins=64)
            p = hist / (hist.sum() + 1e-10)
            entropy = -np.sum(p[p>0] * np.log2(p[p>0]))
        return {'success': True, 'value': round(float(entropy), 4),
                'target_pixels': int(arr_masked.size if mask is None else int(np.sum(mask))),
                'total_pixels': int(arr_masked.size if mask is None else int(np.sum(mask)))}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
