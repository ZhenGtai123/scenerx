"""Calculator Layer.

Indicator ID:   IND_VIB_GRN
Indicator Name: Vibrant Green Space
Type:           TYPE A (ratio mode)

Description:
    Pixel ratio of street-view greenery that also passes a Hue-Saturation-Value
    (HSV) colour filter for "healthy" green hues. Refines the standard GVI by
    retaining only pixels that look both vegetative AND vividly green,
    producing a perception-relevant subset of GVI.

Formula: VibrantGreen = N(pixels labelled vegetation AND HSV in healthy-green range) / N(total pixels)
"""

import numpy as np
from PIL import Image
from typing import Dict


INDICATOR = {
    "id": "IND_VIB_GRN",
    "name": "Vibrant Green Space",
    "unit": "%",
    "formula": "VibrantGreen = N(pixels labelled vegetation AND HSV in healthy-green range) / N(total pixels)",
    "target_direction": "INCREASE",
    "definition": "Pixel ratio of street-view greenery that also passes a Hue-Saturation-Value (HSV) color filter for 'healthy' green hues.",
    "category": "CAT_CMP",
    "calc_type": "ratio",
    "target_classes": ["tree", "grass", "plant;flora;plant;life", "palm;palm;tree", "flower"],
    "variables": "N(.) = pixel count; semantic class 'vegetation' from PSPNet; HSV range thresholds for healthy green hues",
    "confirmation_count": 1,
}


TARGET_RGB = {}
print(f"\nBuilding color lookup for {INDICATOR['id']}:")
for class_name in INDICATOR.get("target_classes", []):
    if class_name in semantic_colors:
        rgb = semantic_colors[class_name]
        TARGET_RGB[rgb] = class_name
        print(f"  {class_name}: RGB{rgb}")
    else:
        print(f"  NOT FOUND: {class_name}")
        for nm in semantic_colors.keys():
            if class_name.split(";")[0] in nm or nm.split(";")[0] in class_name:
                print(f"  Did you mean: '{nm}'?")
                break
print(f"\nCalculator ready: {INDICATOR['id']} ({len(TARGET_RGB)} classes matched)")


# -----------------------------------------------------------------------------
# HSV "healthy green" filter — keeps pixels in the [hue, sat, val] window
# below. The bounds are deliberately permissive: emerald canopy (~70°),
# warm grass (~90°) and freshly-watered foliage (~110°) all qualify, while
# yellowed / browned / desaturated foliage is rejected. Values are 0-1.
# -----------------------------------------------------------------------------
HSV_HEALTHY = {
    "hue_min":  60 / 360,
    "hue_max": 170 / 360,
    "sat_min": 0.20,
    "val_min": 0.20,
    "val_max": 0.97,
}


def _healthy_green_hsv_mask(rgb_array: np.ndarray) -> np.ndarray:
    """Vectorised RGB -> HSV -> boolean mask of pixels in HSV_HEALTHY range."""
    arr = rgb_array.astype(np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = np.max(arr, axis=-1)
    mn = np.min(arr, axis=-1)
    delta = mx - mn
    safe_delta = np.where(delta == 0, 1, delta)
    hue = np.zeros_like(mx)
    mr = (mx == r) & (delta > 0)
    mg = (mx == g) & (delta > 0)
    mb = (mx == b) & (delta > 0)
    hue[mr] = ((g - b)[mr] / safe_delta[mr]) % 6
    hue[mg] = (b - r)[mg] / safe_delta[mg] + 2
    hue[mb] = (r - g)[mb] / safe_delta[mb] + 4
    hue = hue / 6.0
    sat = np.where(mx == 0, 0, delta / np.where(mx == 0, 1, mx))
    val = mx
    return (
        (hue >= HSV_HEALTHY["hue_min"]) & (hue <= HSV_HEALTHY["hue_max"]) &
        (sat >= HSV_HEALTHY["sat_min"]) &
        (val >= HSV_HEALTHY["val_min"]) & (val <= HSV_HEALTHY["val_max"])
    )


def calculate_indicator(image_path: str) -> Dict:
    """Whole-image entry point. Defers to calculate_for_layer with no
    mask and no photo override, so legacy callers get the same fallback
    behaviour as the layer-aware version."""
    return calculate_for_layer(image_path, None, None)


def calculate_for_layer(semantic_map_path: str,
                        mask_path=None,
                        original_photo_path=None) -> Dict:
    """v8.0 — vegetation × healthy-green HSV intersection.

    * semantic_map_path  -> identify vegetation pixels (class-based).
    * original_photo_path -> measure each vegetation pixel's HSV on the
                              actual photo. If None, falls back to the
                              semantic palette (degenerate / near-zero).
    * mask_path           -> restrict to a spatial layer (FG / MG / BG).
    """
    import os
    try:
        with Image.open(semantic_map_path) as sem_img:
            sem_arr = np.array(sem_img.convert("RGB"))
        H, W, _ = sem_arr.shape

        veg_mask = np.zeros((H, W), dtype=bool)
        for rgb, _cn in TARGET_RGB.items():
            veg_mask |= np.all(sem_arr == np.array(rgb, dtype=np.uint8), axis=-1)

        if mask_path and os.path.exists(mask_path):
            with Image.open(mask_path) as m:
                m = m.convert("L")
                if m.size != (W, H):
                    m = m.resize((W, H), Image.NEAREST)
                layer_mask = np.array(m) > 127
            veg_mask &= layer_mask
            denom = int(np.sum(layer_mask))
        else:
            denom = H * W
        if denom == 0:
            return {"success": True, "value": 0.0,
                    "target_pixels": 0, "total_pixels": 0}

        photo_for_color = original_photo_path or semantic_map_path
        with Image.open(photo_for_color) as photo_img:
            photo_arr = np.array(photo_img.convert("RGB"))
            if photo_arr.shape[:2] != (H, W):
                photo_img = Image.open(photo_for_color).convert("RGB").resize(
                    (W, H), Image.BILINEAR,
                )
                photo_arr = np.array(photo_img)
        healthy = _healthy_green_hsv_mask(photo_arr)
        vibrant = veg_mask & healthy
        n_vibrant = int(np.sum(vibrant))
        value = (n_vibrant / denom) * 100.0
        return {
            "success": True,
            "value": round(value, 3),
            "target_pixels": n_vibrant,
            "total_pixels": denom,
            "n_vegetation_pixels": int(np.sum(veg_mask)),
            "n_healthy_green_pixels": int(np.sum(healthy)),
            "photo_source": "photo" if original_photo_path else "semantic_fallback",
        }
    except Exception as e:
        return {"success": False, "value": None, "error": str(e)}
