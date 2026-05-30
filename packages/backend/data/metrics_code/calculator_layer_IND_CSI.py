"""Calculator Layer.

Indicator ID:   IND_CSI
Indicator Name: Color Saturation Index
Type:           TYPE C
"""

import numpy as np
from PIL import Image
from typing import Dict
import os


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_CSI",
    "name": "Color Saturation Index",
    "unit": "intensity",
    "formula": "CSI = sigma_rgyb + 0.3 * mu_rgyb",
    "target_direction": "POSITIVE",
    "definition": "Color saturation/vividness computed from RGB channels using rgyb components",
    "category": "CAT_CMP",

    "calc_type": "custom",

    "variables": {
        "sigma": "Standard deviation",
        "mu": "Mean",
        "rg": "R - G",
        "yb": "0.5*(R + G) - B",
        "sigma_rgyb": "sqrt(std(rg)^2 + std(yb)^2)",
        "mu_rgyb": "sqrt(mean(rg)^2 + mean(yb)^2)"
    },

    # TYPE C
    "use_original_image": False,
    "original_image_path": None
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")
print(f" Use original image: {INDICATOR.get('use_original_image', False)}")


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str) -> Dict:
    try:
        # Step 1:
        actual_path = image_path
        image_source = 'mask'

        if INDICATOR.get('use_original_image', False):
            original_base = INDICATOR.get('original_image_path')
            if original_base:
                if 'mask' in image_path:
                    relative = image_path.split('mask')[-1]
                    for ext in ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG']:
                        test_path = original_base + relative.rsplit('.', 1)[0] + ext
                        if os.path.exists(test_path):
                            actual_path = test_path
                            image_source = 'original'
                            break

        # Step 2:
        img = Image.open(actual_path).convert('RGB')
        pixels = np.array(img, dtype=np.float64)

        h, w, _ = pixels.shape
        total_pixels = h * w

        R = pixels[:, :, 0]
        G = pixels[:, :, 1]
        B = pixels[:, :, 2]

        # Step 3: rgyb
        rg = R - G
        yb = 0.5 * (R + G) - B

        # Step 4: sigma_rgyb mu_rgyb
        rg_mean = float(np.mean(rg))
        yb_mean = float(np.mean(yb))
        rg_std = float(np.std(rg))
        yb_std = float(np.std(yb))

        sigma_rgyb = float(np.sqrt(rg_std ** 2 + yb_std ** 2))
        mu_rgyb = float(np.sqrt(rg_mean ** 2 + yb_mean ** 2))

        # Step 5: CSI
        csi = sigma_rgyb + 0.3 * mu_rgyb

        return {
            'success': True,
            'value': round(float(csi), 3),
            'sigma_rgyb': round(float(sigma_rgyb), 3),
            'mu_rgyb': round(float(mu_rgyb), 3),
            'rg_stats': {
                'mean': round(rg_mean, 3),
                'std': round(rg_std, 3),
                'min': round(float(np.min(rg)), 3),
                'max': round(float(np.max(rg)), 3)
            },
            'yb_stats': {
                'mean': round(yb_mean, 3),
                'std': round(yb_std, 3),
                'min': round(float(np.min(yb)), 3),
                'max': round(float(np.max(yb)), 3)
            },
            'dimensions': {'height': h, 'width': w},
            'total_pixels': int(total_pixels),
            'image_source': image_source,
            'actual_path': actual_path
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'value': None
        }


# =============================================================================
# HELPER FUNCTIONS CSI
# =============================================================================
def interpret_csi(csi: float) -> str:
    if csi < 10:
        return "Low saturation: muted colors"
    elif csi < 25:
        return "Medium-low saturation"
    elif csi < 45:
        return "Medium saturation"
    elif csi < 70:
        return "High saturation: vivid colors"
    else:
        return "Very high saturation: extremely vivid colors"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Color Saturation Index calculator...")

    test_gray = np.full((100, 100, 3), 128, dtype=np.uint8)

    test_vivid = np.zeros((120, 120, 3), dtype=np.uint8)
    test_vivid[0:40, :, :] = [255, 0, 0]
    test_vivid[40:80, :, :] = [0, 255, 0]
    test_vivid[80:120, :, :] = [0, 0, 255]

    for name, test_img in [('Gray', test_gray), ('Vivid', test_vivid)]:
        test_path = f'/tmp/test_csi_{name}.png'
        Image.fromarray(test_img).save(test_path)

        result = calculate_indicator(test_path)

        print(f"\n{name}:")
        print(f" CSI: {result['value']}")
        print(f" sigma_rgyb: {result['sigma_rgyb']}")
        print(f" mu_rgyb: {result['mu_rgyb']}")
        print(f" Interpretation: {interpret_csi(result['value'])}")

        os.remove(test_path)


# =============================================================================
# LAYER-AWARE CALCULATION (auto-added 2026-05-11)
# =============================================================================
def calculate_for_layer(semantic_map_path, mask_path=None, original_photo_path=None):
    """Layer-aware wrapper (v8.0 — photo-aware).

    Earlier versions called calculate_indicator() on the SEMANTIC MAP after
    masking it, which made photographic metrics (colour stats, GLCM entropy,
    fractal dimension, perceived brightness) degenerate to a function of the
    ADE20K class palette. We now mask the ORIGINAL PHOTO when supplied; if
    no photo path is given we fall back to the legacy semantic-map behaviour
    so older callers keep working.

    The masking strategy: copy the photo, set out-of-layer pixels to black
    (0,0,0), save to a temp file, and call calculate_indicator on that.
    """
    import numpy as np
    from PIL import Image
    import tempfile, os

    src_path = original_photo_path or semantic_map_path
    if not mask_path or not os.path.exists(mask_path):
        return calculate_indicator(src_path)

    try:
        with Image.open(src_path) as src_img:
            src_arr = np.array(src_img.convert("RGB"))
        with Image.open(mask_path) as m:
            m = m.convert("L")
            if m.size != (src_arr.shape[1], src_arr.shape[0]):
                m = m.resize((src_arr.shape[1], src_arr.shape[0]), Image.NEAREST)
            mask_arr = np.array(m) > 127
        src_arr[~mask_arr] = 0
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            Image.fromarray(src_arr).save(tmp.name)
            tmp_path = tmp.name
        try:
            result = calculate_indicator(tmp_path)
        finally:
            try: os.unlink(tmp_path)
            except: pass
        return result
    except Exception as e:
        return {"success": False, "value": None,
                "error": f"layer-aware wrapper failed: {e}"}
