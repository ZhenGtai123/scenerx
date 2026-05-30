"""Calculator Layer.

Indicator ID:   IND_SVF_CHG
Indicator Name: Sky View Factor Change (SVF
Type:           TYPE D

Formula: SVF_CHG = |SVF_t - SVF_{t-1}|
"""

import numpy as np
from PIL import Image
from typing import Dict


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_SVF_CHG",
    "name": "Sky View Factor Change",
    "unit": "ratio",
    "formula": "|SVF_t - SVF_{t-1}|",
    "target_direction": "NEUTRAL",
    "definition": "Absolute change in Sky View Factor between two adjacent points",
    "category": "CAT_CFG",

    "calc_type": "composite",

    "component_sources": {
        "current": "SVF_t",
        "previous": "SVF_{t-1}"
    },

    "aggregation": "absolute_difference"
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Aggregation: {INDICATOR.get('aggregation', 'absolute_difference')}")


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(SVF_t: float, SVF_t_minus_1: float) -> Dict:
    # v8.0 — graceful skip when called per-image. This is a composite/
    # aggregator indicator that needs other-indicators or multi-location
    # input, not a single image. The orchestrator iterates per-image with
    # image_path strings; without this guard we'd raise AttributeError on
    # the first .get() call. Downstream composite callers that pass the
    # correct dict input still execute the formula below.
    if isinstance(SVF_t, str):
        return {
            "success": False,
            "value": None,
            "error": "IND_SVF_CHG: composite indicator — call after per-image metrics are computed; cannot evaluate from a single image_path",
            "skip_reason": "composite_or_aggregator",
        }
    try:
        svf_current = float(SVF_t)
        svf_prev = float(SVF_t_minus_1)

        value = abs(svf_current - svf_prev)

        change_level = interpret_svf_change(value)

        return {
            'success': True,
            'value': round(float(value), 3),
            'aggregation_method': INDICATOR.get('aggregation', 'absolute_difference'),
            'SVF_t': round(svf_current, 3),
            'SVF_{t-1}': round(svf_prev, 3),
            'change_level': change_level
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
def interpret_svf_change(change: float) -> str:
    if change < 0.05:
        return "Very stable: minimal SVF change"
    elif change < 0.15:
        return "Stable: small SVF change"
    elif change < 0.30:
        return "Moderate change: noticeable SVF variation"
    else:
        return "High change: strong SVF variation"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting SVF Change calculator...")

    tests = [
        ("Very small change", 0.62, 0.60),
        ("Moderate change", 0.62, 0.40),
        ("High change", 0.85, 0.20),
    ]

    for name, svf_t, svf_prev in tests:
        result = calculate_indicator(svf_t, svf_prev)

        print(f"\n{name}:")
        print(f" SVF_t: {result['SVF_t']}")
        print(f" SVF_{'{t-1}'}: {result['SVF_{t-1}']}")
        print(f" SVF_CHG: {result['value']}")
        print(f" Level: {result['change_level']}")


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
