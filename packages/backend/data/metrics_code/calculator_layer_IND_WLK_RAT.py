"""Calculator Layer.

Indicator ID:   IND_WLK_RAT
Indicator Name: Visual Walkability Ratio (merged)
Type:           TYPE B (two_class_ratio

Formula: IND_WLK_RAT = (Pavement_pixels + Fence_pixels) / Road_pixels
"""

import numpy as np
from PIL import Image
from typing import Dict

# semantic_colors input_layer.py
from input_layer import semantic_colors


# =============================================================================
# INDICATOR DEFINITION -
# =============================================================================
INDICATOR = {
    "id": "IND_WLK_RAT",
    "name": "Visual Walkability Ratio (merged)",
    "unit": "ratio",
    "formula": "(Sidewalk + Fence) / Road",
    "target_direction": "INCREASE",  # INCREASE / DECREASE / NEUTRAL
    "definition": "The ratio of pedestrian-oriented pixels (pavement, fence) to road pixels in a street view image.",
    "category": "CAT_CMP",

    # TYPE B /
    "calc_type": "two_class_ratio",  # ratio / inverse_ratio / two_class_ratio

    "numerator_classes": [
        "sidewalk",
        "fence",
    ],

    "denominator_classes": [
        "road",
    ]
}


# =============================================================================
# COLOR LOOKUP TABLE
# =============================================================================
NUM_RGB = {}
DEN_RGB = {}

print(f"\nBuilding color lookup for {INDICATOR['id']}:")

print(" ▶ Numerator classes:")
for class_name in INDICATOR.get('numerator_classes', []):
    if class_name in semantic_colors:
        rgb = semantic_colors[class_name]
        NUM_RGB[rgb] = class_name
        print(f" {class_name}: RGB{rgb}")
    else:
        print(f" ️ NOT FOUND: {class_name}")

print(" ▶ Denominator classes:")
for class_name in INDICATOR.get('denominator_classes', []):
    if class_name in semantic_colors:
        rgb = semantic_colors[class_name]
        DEN_RGB[rgb] = class_name
        print(f" {class_name}: RGB{rgb}")
    else:
        print(f" ️ NOT FOUND: {class_name}")

print(
    f"\nCalculator ready: {INDICATOR['id']} "
    f"(NUM={len(NUM_RGB)} classes matched, DEN={len(DEN_RGB)} classes matched)"
)


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str) -> Dict:
    try:
        # Step 1:
        img = Image.open(image_path).convert('RGB')
        pixels = np.array(img)
        h, w, _ = pixels.shape
        total_pixels = h * w

        flat_pixels = pixels.reshape(-1, 3)

        # Step 2: sidewalk + fence
        numerator_count = 0
        numerator_counts = {}

        for rgb, class_name in NUM_RGB.items():
            mask = np.all(flat_pixels == rgb, axis=1)
            count = int(np.sum(mask))
            if count > 0:
                numerator_counts[class_name] = count
                numerator_count += count

        # Step 3: road
        denominator_count = 0
        denominator_counts = {}

        for rgb, class_name in DEN_RGB.items():
            mask = np.all(flat_pixels == rgb, axis=1)
            count = int(np.sum(mask))
            if count > 0:
                denominator_counts[class_name] = count
                denominator_count += count

        # Step 4:
        if denominator_count == 0:
            value = None
        else:
            value = numerator_count / denominator_count

        return {
            'success': True,
            'value': None if value is None else round(float(value), 6),
            'numerator_pixels': int(numerator_count),
            'denominator_pixels': int(denominator_count),
            'total_pixels': int(total_pixels),
            'numerator_breakdown': numerator_counts,
            'denominator_breakdown': denominator_counts
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'value': None
        }


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting calculator...")

    test_img = np.zeros((100, 100, 3), dtype=np.uint8)

    # 30% sidewalk + 10% fence, 20% road  → ratio = (40) / (20) = 2.0
    if 'sidewalk' in semantic_colors:
        test_img[0:30, :] = semantic_colors['sidewalk']

    if 'fence' in semantic_colors:
        test_img[30:40, :] = semantic_colors['fence']

    if 'road' in semantic_colors:
        test_img[40:60, :] = semantic_colors['road']

    test_path = '/tmp/test_wlk_rat.png'
    Image.fromarray(test_img).save(test_path)

    result = calculate_indicator(test_path)
    print(f" Result: {result}")

    import os
    os.remove(test_path)


# =============================================================================
# LAYER-AWARE CALCULATION (auto-added 2026-05-11)
# =============================================================================
def calculate_for_layer(semantic_map_path, mask_path=None):
    """Layer-aware wrapper. If mask_path provided, masks the semantic map
    to that layer before computing; else computes whole-image.
    
    The default strategy: copy semantic map, set non-mask pixels to 0
    (which won't match any real ADE20K color), then run calculate_indicator.
    """
    import numpy as np
    from PIL import Image
    import tempfile, os
    
    if not mask_path or not os.path.exists(mask_path):
        return calculate_indicator(semantic_map_path)
    
    try:
        sem_img = Image.open(semantic_map_path).convert('RGB')
        sem_arr = np.array(sem_img)
        with Image.open(mask_path) as m:
            m = m.convert('L')
            if m.size != (sem_arr.shape[1], sem_arr.shape[0]):
                m = m.resize((sem_arr.shape[1], sem_arr.shape[0]), Image.NEAREST)
            mask_arr = np.array(m) > 127
        # Apply mask: non-mask pixels set to black (0,0,0)
        sem_arr[~mask_arr] = 0
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            Image.fromarray(sem_arr).save(tmp.name)
            tmp_path = tmp.name
        try:
            result = calculate_indicator(tmp_path)
        finally:
            try: os.unlink(tmp_path)
            except: pass
        return result
    except Exception as e:
        return {'success': False, 'value': None, 'error': f'layer-aware wrapper failed: {e}'}
