"""Calculator Layer.

Indicator ID:   IND_GRC_CON
Indicator Name: Grayscale Contrast (GLCM) (-GLCM
Type:           TYPE C

Formula: GRC_CON = Σ (i - j)^2 × P(i, j)
"""

import numpy as np
from PIL import Image
from typing import Dict
import os


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_GRC_CON",
    "name": "Grayscale Contrast (GLCM)",
    "unit": "dimensionless",
    "formula": "Σ (i-j)^2 × P(i,j)",
    "target_direction": "NEUTRAL",
    "definition": "GLCM contrast measuring intensity difference between neighboring pixels in grayscale",
    "category": "CAT_CMP",

    "calc_type": "custom",

    "variables": {
        "P(i,j)": "Gray Level Co-occurrence probability matrix",
        "i,j": "Gray levels",
        "d": "Pixel offset distance",
        "θ": "Direction of offset"
    },

    # TYPE C
    "use_original_image": False,
    "original_image_path": None,

    # GLCM
    "levels": 32,
    "distance": 1,
    "angles": [0, 45, 90, 135]  # degrees
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
        rgb = np.array(img, dtype=np.float64)
        h, w, _ = rgb.shape

        gray = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
        gray = np.clip(gray, 0, 255)

        # Step 3:
        levels = int(INDICATOR.get('levels', 32))
        if levels < 2:
            levels = 2

        q = np.floor(gray / 256.0 * levels).astype(np.int32)
        q[q == levels] = levels - 1

        # Step 4: GLCM
        d = int(INDICATOR.get('distance', 1))
        angles = INDICATOR.get('angles', [0, 45, 90, 135])

        def _offset_for_angle(deg: int) -> tuple:
            if deg == 0:
                return (0, d)
            if deg == 45:
                return (-d, d)
            if deg == 90:
                return (-d, 0)
            if deg == 135:
                return (-d, -d)
            return (0, d)

        def _glcm_contrast(q_img: np.ndarray, dy: int, dx: int, levels: int) -> float:
            H, W = q_img.shape
            glcm = np.zeros((levels, levels), dtype=np.float64)

            if dy >= 0:
                y1a, y1b = 0, H - dy
                y2a, y2b = dy, H
            else:
                y1a, y1b = -dy, H
                y2a, y2b = 0, H + dy

            if dx >= 0:
                x1a, x1b = 0, W - dx
                x2a, x2b = dx, W
            else:
                x1a, x1b = -dx, W
                x2a, x2b = 0, W + dx

            a = q_img[y1a:y1b, x1a:x1b].ravel()
            b = q_img[y2a:y2b, x2a:x2b].ravel()

            if a.size == 0:
                return 0.0

            idx = a * levels + b
            counts = np.bincount(idx, minlength=levels * levels).astype(np.float64)
            glcm = counts.reshape(levels, levels)

            total = glcm.sum()
            if total <= 0:
                return 0.0

            P = glcm / total

            i = np.arange(levels).reshape(-1, 1)
            j = np.arange(levels).reshape(1, -1)
            contrast = np.sum(((i - j) ** 2) * P)
            return float(contrast)

        per_angle = {}
        values = []

        for ang in angles:
            dy, dx = _offset_for_angle(int(ang))
            c = _glcm_contrast(q, dy, dx, levels)
            per_angle[str(ang)] = round(float(c), 3)
            values.append(c)

        mean_contrast = float(np.mean(values)) if len(values) > 0 else 0.0

        return {
            'success': True,
            'value': round(mean_contrast, 3),
            'levels': levels,
            'distance': d,
            'angles': angles,
            'per_angle_contrast': per_angle,
            'dimensions': {'height': int(h), 'width': int(w)},
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
# HELPER FUNCTIONS
# =============================================================================
def interpret_grc_con(value: float) -> str:
    if value < 1:
        return "Very low texture contrast: smooth grayscale surface"
    elif value < 5:
        return "Low texture contrast: subtle intensity differences"
    elif value < 15:
        return "Medium texture contrast: noticeable texture"
    else:
        return "High texture contrast: strong grayscale variations"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Grayscale Contrast (GLCM) calculator...")

    smooth = np.full((128, 128, 3), 128, dtype=np.uint8)

    checker = np.zeros((128, 128, 3), dtype=np.uint8)
    block = 8
    for i in range(0, 128, block):
        for j in range(0, 128, block):
            val = 255 if ((i // block + j // block) % 2 == 0) else 0
            checker[i:i+block, j:j+block] = val

    for name, test_img in [('Smooth', smooth), ('Checker', checker)]:
        test_path = f'/tmp/test_grc_con_{name}.png'
        Image.fromarray(test_img).save(test_path)

        result = calculate_indicator(test_path)

        print(f"\n{name}:")
        print(f" GRC_CON: {result['value']}")
        print(f" Per-angle: {result['per_angle_contrast']}")
        print(f" Interpretation: {interpret_grc_con(result['value'])}")

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
