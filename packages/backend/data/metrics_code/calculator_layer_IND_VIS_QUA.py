"""Calculator Layer.

Indicator ID:   IND_VIS_QUA
Indicator Name: Visual Quality Index
Type:           TYPE D

Formula: VIS_QUA = Σ(Component Scores)
"""

import numpy as np
from typing import Dict


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_VIS_QUA",
    "name": "Visual Quality Index",
    "unit": "score",
    "formula": "Sum(Safety, Liveliness, Beauty, Wealth, Cheerfulness, Interestingness)",
    "target_direction": "POSITIVE",
    "definition": "Composite visual environmental quality index aggregated from multiple perceptual dimensions",
    "category": "CAT_COM",

    "calc_type": "composite",

    "components": [
        "Safety",
        "Liveliness",
        "Beauty",
        "Wealth",
        "Cheerfulness",
        "Interestingness"
    ],

    "aggregation": "sum"
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Aggregation: {INDICATOR.get('aggregation', 'sum')}")


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(values: Dict[str, float]) -> Dict:
    # v8.0 — graceful skip when called per-image. This is a composite/
    # aggregator indicator that needs other-indicators or multi-location
    # input, not a single image. The orchestrator iterates per-image with
    # image_path strings; without this guard we'd raise AttributeError on
    # the first .get() call. Downstream composite callers that pass the
    # correct dict input still execute the formula below.
    if isinstance(values, str):
        return {
            "success": False,
            "value": None,
            "error": "IND_VIS_QUA: composite indicator — call after per-image metrics are computed; cannot evaluate from a single image_path",
            "skip_reason": "composite_or_aggregator",
        }
    try:
        comps = INDICATOR.get('components', [])

        component_values = {}
        contributions = {}
        total = 0.0

        for k in comps:
            v = float(values.get(k, 0))
            component_values[k] = round(v, 3)
            contributions[k] = round(v, 3)
            total += v

        return {
            'success': True,
            'value': round(float(total), 3),
            'aggregation_method': INDICATOR.get('aggregation', 'sum'),
            'components': component_values,
            'contributions': contributions
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
def interpret_vis_qua(score: float) -> str:
    if score < 1:
        return "Very low visual quality"
    elif score < 2:
        return "Low visual quality"
    elif score < 3:
        return "Medium visual quality"
    elif score < 4:
        return "High visual quality"
    else:
        return "Very high visual quality"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Visual Quality Index calculator...")

    test_values = {
        "Safety": 0.70,
        "Liveliness": 0.55,
        "Beauty": 0.60,
        "Wealth": 0.50,
        "Cheerfulness": 0.45,
        "Interestingness": 0.65
    }

    result = calculate_indicator(test_values)

    print("\nTest inputs:")
    print(f" Components: {result['components']}")
    print(f" VIS_QUA: {result['value']}")
    print(f" Level: {interpret_vis_qua(result['value'])}")


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
