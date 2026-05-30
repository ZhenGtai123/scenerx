"""Calculator Layer.

Indicator ID:   IND_FG_DEPTH_ECI
Indicator Name: Foreground Depth Continuity Index (P_ECI)
Type:           TYPE B (custom layer-aware)

Description:
    A distributional trend metric measuring how smoothly depth values transition across the foreground. Computed as the coefficient of variation of the per-row/column coefficients of variation of the absolute differences between depth values of neighboring-pixel pairs. Zero means depth values are contin

Formula: P_ECI = sqrt( (1/N) * sum_j (CV_j - mu_CV)^2 ) / mu_CV ; CV_j = sqrt((1/Mj)*sum_i(Cij - mu_j)^2) / mu_j ; Cij = |idx_i - idx_{i+1}|

This calculator computes a non-ratio statistic (non-ratio statistic) over the raw
RGB / semantic pixels of the image, optionally restricted to a spatial
layer mask (foreground / middleground / background) via
`calculate_for_layer`.
"""

import numpy as np
from PIL import Image
from typing import Dict, Optional


INDICATOR = {
    "id": "IND_FG_DEPTH_ECI",
    "name": "Foreground Depth Continuity Index (P_ECI)",
    "unit": "%",
    "formula": "P_ECI = sqrt( (1/N) * sum_j (CV_j - mu_CV)^2 ) / mu_CV ; CV_j = sqrt((1/Mj)*sum_i(Cij - mu_j)^2) / mu_j ; Cij = |idx_i - idx_{i+1}|",
    "target_direction": "NEUTRAL",
    "definition": "A distributional trend metric measuring how smoothly depth values transition across the foreground. Computed as the coefficient of variation of the per-row/column coefficients of variation of the absolute differences between depth values of neighboring-pixel pairs. Zero means depth values are contin",
    "category": "CAT_CFG",
    "calc_type": "custom",
    "variables": {"Cij": "absolute difference in depth values between the i-th pair of neighboring pixels in the j-th row or column", "mu_j": "mean of all Cij in the j-th row or column", "CV_j": "coefficient of variation of all Cij in the j-th row or column", "mu_CV": "average of CV_j across all rows and columns", "Mj": "number of Cij in the j-th row or column", "N": "total number of rows and columns in the foreground"},
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
    """Foreground Depth Continuity Index. Coefficient of variation of row-wise CV of depth differences."""
    # v8.0 — orchestrator now ships the depth map alongside the
    # semantic map. This indicator reads depth pixel values, not class
    # labels, so a semantic map gives meaningless results. Prefer the
    # explicit depth_map_path when present.
    if depth_map_path:
        image_path = depth_map_path
    try:
        img = Image.open(image_path)
        arr = np.array(img).astype(np.float64)
        if arr.ndim == 3: arr = arr.mean(axis=2)
        mask = _load_mask(mask_path, arr.shape[:2])
        if mask is None:
            mask = np.ones(arr.shape[:2], dtype=bool)
        # row-wise CV of depth differences in masked area
        cvs = []
        for r in range(arr.shape[0]):
            row_mask = mask[r,:]
            row_vals = arr[r, row_mask]
            if len(row_vals) > 1:
                diffs = np.abs(np.diff(row_vals))
                if diffs.mean() > 0:
                    cvs.append(float(np.std(diffs) / diffs.mean()))
        if not cvs:
            return {'success': True, 'value': 0.0, 'target_pixels': 0, 'total_pixels': 0}
        mu_cv = float(np.mean(cvs))
        eci = float(np.std(cvs) / mu_cv) if mu_cv > 0 else 0.0
        return {'success': True, 'value': round(eci, 4),
                'target_pixels': int(mask.sum()), 'total_pixels': int(mask.size)}
    except Exception as e:
        return {'success': False, 'value': None, 'error': str(e)}



def calculate_indicator(image_path: str) -> Dict:
    """Whole-image calculation (no mask)."""
    return calculate_for_layer(image_path, None)
