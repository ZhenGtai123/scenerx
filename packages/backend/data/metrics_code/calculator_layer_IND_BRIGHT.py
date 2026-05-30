"""Calculator Layer.

Indicator ID:   IND_BRIGHT
Indicator Name: Image Brightness (Mean RGB Luminance)
Type:           TYPE B (custom layer-aware)

Description:
    Brightness is the perception elicited by the luminance of a visual target; in this study it reflects the illumination condition captured in a GSV image and is computed as the mean digital number across all pixels and the three visible (RGB) bands.

Formula: Brightness = (1/(3*M*N)) * sum_{b=1..3} sum_{i=0..N-1} sum_{j=0..M-1} I_bij

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_BRIGHT",
    "name": "Image Brightness (Mean RGB Luminance)",
    "unit": "%",
    "formula": "Brightness = (1/(3*M*N)) * sum_{b=1..3} sum_{i=0..N-1} sum_{j=0..M-1} I_bij",
    "target_direction": "NEUTRAL",
    "definition": "Brightness is the perception elicited by the luminance of a visual target; in this study it reflects the illumination condition captured in a GSV image and is computed as the mean digital number across all pixels and the three visible (RGB) bands.",
    "category": "CAT_CMP",
    "calc_type": "custom",
    "variables": {"I_bij": "digital number of pixel (i, j) in band b of a GSV image", "M": "image width in pixels", "N": "image height in pixels"},
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
    """Mean RGB luminance over the region. Reads the *photo* image, NOT the semantic mask."""

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
        if pixels.size == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        # Brightness = (1/3) * mean(R) + mean(G) + mean(B), normalized to 0-255
        brightness = float(pixels.mean())
        return {'success': True, 'value': round(brightness, 3),
                'target_pixels': int(len(pixels)), 'total_pixels': int(len(pixels))}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
