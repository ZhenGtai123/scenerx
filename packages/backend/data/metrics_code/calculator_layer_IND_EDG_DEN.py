"""Calculator Layer.

Indicator ID:   IND_EDG_DEN
Indicator Name: Edge Pixel Density
Type:           TYPE B (custom layer-aware)

Description:
    Ratio of pixels classified as 'edge' (e.g., from a Canny or similar edge detector) to total pixels in the SVI. Quantifies fine-scale visual detail / contour density, distinct from entropy-based complexity.

Formula: EdgeDensity = N(edge pixels) / N(total pixels)

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_EDG_DEN",
    "name": "Edge Pixel Density",
    "unit": "%",
    "formula": "EdgeDensity = N(edge pixels) / N(total pixels)",
    "target_direction": "NEUTRAL",
    "definition": "Ratio of pixels classified as 'edge' (e.g., from a Canny or similar edge detector) to total pixels in the SVI. Quantifies fine-scale visual detail / contour density, distinct from entropy-based complexity.",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": "N(.) = pixel count; edge pixels from low-level edge detection on the SVI",
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
    """Canny edge pixel density within the region."""

    # v8.0 — the orchestrator now ships the original photo path alongside
    # the semantic-map path. This calculator computes a photographic
    # feature, so prefer the photo when available.
    if original_photo_path:
        image_path = original_photo_path
    try:
        try:
            import cv2
            HAS_CV2 = True
        except ImportError:
            HAS_CV2 = False
        img = Image.open(image_path).convert('RGB')
        arr = np.array(img)
        gray = (0.299*arr[:,:,0] + 0.587*arr[:,:,1] + 0.114*arr[:,:,2]).astype(np.uint8)
        if HAS_CV2:
            edges = cv2.Canny(gray, 100, 200) > 0
        else:
            # Fallback: simple Sobel-like gradient threshold
            gy = np.abs(np.diff(gray.astype(np.int32), axis=0))
            gx = np.abs(np.diff(gray.astype(np.int32), axis=1))
            edges_x = np.zeros_like(gray, dtype=bool)
            edges_y = np.zeros_like(gray, dtype=bool)
            edges_x[:, :-1] = gx > 50
            edges_y[:-1, :] = gy > 50
            edges = edges_x | edges_y
        mask = _load_mask(mask_path, edges.shape[:2])
        if mask is not None:
            n_edge = int(np.sum(edges & mask))
            n_total = int(np.sum(mask))
        else:
            n_edge = int(np.sum(edges))
            n_total = int(edges.size)
        if n_total == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        return {'success': True, 'value': round(n_edge / n_total * 100.0, 3),
                'target_pixels': n_edge, 'total_pixels': n_total}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
