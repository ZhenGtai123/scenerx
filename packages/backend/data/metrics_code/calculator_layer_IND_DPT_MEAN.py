"""Calculator Layer.

Indicator ID:   IND_DPT_MEAN
Indicator Name: Average Scene Depth
Type:           TYPE B (custom layer-aware)

Description:
    Per-image average of pixel-wise scene depth values estimated by a monocular depth-estimation network (e.g., DPT-Large, MiDaS) applied to a street-view image; reflects the mean perceived distance to objects in the visible scene.

Formula: Depth_mean = (1 / (M*N)) * sum_{i,j} D(i,j), where D(i,j) is the predicted depth value at pixel (i,j) of an MxN image

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_DPT_MEAN",
    "name": "Average Scene Depth",
    "unit": "%",
    "formula": "Depth_mean = (1 / (M*N)) * sum_{i,j} D(i,j), where D(i,j) is the predicted depth value at pixel (i,j) of an MxN image",
    "target_direction": "NEUTRAL",
    "definition": "Per-image average of pixel-wise scene depth values estimated by a monocular depth-estimation network (e.g., DPT-Large, MiDaS) applied to a street-view image; reflects the mean perceived distance to objects in the visible scene.",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": "D(i,j) = predicted scene-depth value at pixel (i,j), produced by a pretrained depth-estimation model (DPT-Large in Ma et al. 2023); M, N = image dimensions",
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



def calculate_for_layer(image_path: str, mask_path: Optional[str] = None, original_photo_path: Optional[str] = None, depth_map_path: Optional[str] = None) -> Dict:
    """Mean depth value. Expects image_path to point to a depth map (grayscale 0-255 or 0-65535)."""
    # v8.0 — orchestrator now ships the depth map alongside the
    # semantic map. This indicator reads depth pixel values, not class
    # labels, so a semantic map gives meaningless results. Prefer the
    # explicit depth_map_path when present.
    if depth_map_path:
        image_path = depth_map_path
    try:
        img = Image.open(image_path)
        arr = np.array(img).astype(np.float64)
        if arr.ndim == 3: arr = arr.mean(axis=2)  # if RGB depth, average
        mask = _load_mask(mask_path, arr.shape[:2])
        if mask is not None:
            vals = arr[mask]
        else:
            vals = arr.flatten()
        if len(vals) == 0:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        return {'success': True, 'value': round(float(vals.mean()), 3),
                'target_pixels': int(len(vals)), 'total_pixels': int(len(vals))}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
