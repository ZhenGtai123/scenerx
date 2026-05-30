"""Calculator Layer.

Indicator ID:   IND_VSD
Indicator Name: Vegetation Structural Diversity
Type:           TYPE B

Formula: )
"""

import numpy as np
from PIL import Image
from typing import Dict


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_VSD",
    "name": "Vegetation Structural Diversity",
    "unit": "dimensionless",
    "formula": "VSD = -Σ(pᵢ × ln(pᵢ))",
    "target_direction": "POSITIVE",
    "definition": "Shannon-Wiener index measuring diversity of vegetation vertical layers (tree/shrub/herb)",
    "category": "CAT_CFG",

    "calc_type": "custom",

    "variables": {
        "pi": "Proportion of specific vegetation type pixels relative to total vegetation pixels",
        "VSD": "Vegetation Structural Diversity (Shannon-Wiener index)",
        "n": "Number of unique vegetation layers detected"
    }
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")


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

        # Step 2: Sum pixels per vertical vegetation stratum.
        #
        # VSD wants a 3-layer Shannon entropy (canopy / mid / ground), but
        # the underlying semantic segmentation is ADE20K-150 which does NOT
        # have "shrub" or "herb" classes — only "tree", "grass", "plant;
        # flora;plant;life", "palm;palm;tree", and "flower". The original
        # code asked for `['tree','shrub','herb']` directly against
        # semantic_colors, so on real ADE20K outputs only `tree` matched.
        # Result: total_veg ended up dominated by a single layer, every
        # p_i = 1.0, ln(1) = 0, VSD = 0 for every image, every zone — which
        # surfaced in the UI as "IND_VSD returned 0 for every zone".
        #
        # Fix: map the 3 vertical strata onto the actual ADE20K class names
        # they correspond to, then sum class pixel counts within each
        # stratum bucket before computing entropy.
        LAYER_TO_ADE20K_CLASSES = {
            'tree':  ['tree', 'palm;palm;tree'],          # canopy stratum
            'shrub': ['plant;flora;plant;life'],          # mid stratum
            'herb':  ['grass', 'flower'],                  # ground stratum
        }

        layer_counts: dict = {}
        for layer, class_names in LAYER_TO_ADE20K_CLASSES.items():
            stratum_total = 0
            for class_name in class_names:
                rgb = semantic_colors.get(class_name)
                if rgb is None:
                    continue
                mask = np.all(flat_pixels == rgb, axis=1)
                stratum_total += int(np.sum(mask))
            if stratum_total > 0:
                layer_counts[layer] = stratum_total

        total_veg = sum(layer_counts.values())
        unmatched_pixels = total_pixels - total_veg

        if total_veg == 0:
            return {
                'success': True,
                'value': 0,
                'n_layers': 0,
                'max_possible_entropy': 0,
                'normalized_entropy': 0,
                'total_pixels': int(total_pixels),
                'matched_pixels': 0,
                'unmatched_pixels': int(unmatched_pixels),
                'layer_distribution': {},
                'note': 'No vegetation layers detected in image'
            }

        # Step 3:
        probabilities = [count / total_veg for count in layer_counts.values()]

        # Step 4: Shannon-Wiener ln
        vsd = 0.0
        for p in probabilities:
            if p > 0:
                vsd -= p * np.log(p)

        # Step 5:
        n_layers = len(layer_counts)
        max_entropy = np.log(n_layers) if n_layers > 1 else 0
        normalized_entropy = vsd / max_entropy if max_entropy > 0 else 0

        return {
            'success': True,
            'value': round(float(vsd), 3),
            'n_layers': int(n_layers),
            'max_possible_entropy': round(float(max_entropy), 3),
            'normalized_entropy': round(float(normalized_entropy), 3),
            'total_pixels': int(total_pixels),
            'matched_pixels': int(total_veg),
            'unmatched_pixels': int(unmatched_pixels),
            'layer_distribution': layer_counts,
            'top_layers': dict(sorted(layer_counts.items(),
                                      key=lambda x: x[1],
                                      reverse=True)[:3])
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
def interpret_vsd(vsd: float, n_layers: int) -> str:
    if n_layers <= 1:
        return "Very low diversity: dominated by a single vegetation layer"

    max_h = np.log(n_layers)
    ratio = vsd / max_h if max_h > 0 else 0

    if ratio < 0.3:
        return "Low diversity: dominated by one layer"
    elif ratio < 0.6:
        return "Medium diversity: moderate layer balance"
    elif ratio < 0.8:
        return "High diversity: diverse layer distribution"
    else:
        return "Very high diversity: nearly uniform layer distribution"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Vegetation Structural Diversity calculator...")

    # - 1/3 tree, 1/3 shrub, 1/3 herb
    test_img = np.zeros((90, 90, 3), dtype=np.uint8)

    if all(k in semantic_colors for k in ['tree', 'shrub', 'herb']):
        test_img[0:30, :] = semantic_colors['tree']
        test_img[30:60, :] = semantic_colors['shrub']
        test_img[60:90, :] = semantic_colors['herb']

        test_path = '/tmp/test_vsd.png'
        Image.fromarray(test_img).save(test_path)

        result = calculate_indicator(test_path)

        print(" Test: 1/3 tree + 1/3 shrub + 1/3 herb")
        print(" Expected: ln(3) ≈ 1.099 (uniform distribution)")
        print(f" Result: {result['value']}")
        print(f" Layers: {result['n_layers']}")
        print(f" Interpretation: {interpret_vsd(result['value'], result['n_layers'])}")

        import os
        os.remove(test_path)
    else:
        print(" ️ Required classes not found in semantic_colors")


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
