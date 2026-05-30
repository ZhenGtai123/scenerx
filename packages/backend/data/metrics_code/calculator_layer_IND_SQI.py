"""Calculator Layer.

Indicator ID:   IND_SQI
Indicator Name: Street Quality Index (Composite
Type:           TYPE D

Formula: SQI = 1.507*GVI + 0.692*SVI + 0.447*EVI - 2.412*MVI - 0.011*SFI - 0.800*PCI
"""

import numpy as np
from typing import Dict


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_SQI",
    "name": "Street Quality Index (Composite)",
    "unit": "score",
    "formula": "SQI = 1.507*GVI + 0.692*SVI + 0.447*EVI - 2.412*MVI - 0.011*SFI - 0.800*PCI - 0.060*VII + 1.414*ITI - 0.167*CCI + 0.208*SWI + 7.798*VEI - 6.344*IRI",
    "target_direction": "POSITIVE",
    "definition": "AHP-weighted composite index measuring overall visual spatial quality of an urban street",
    "category": "CAT_COM",

    "calc_type": "composite",

    "components": [
        "GVI",
        "SVI",
        "EVI",
        "MVI",
        "SFI",
        "PCI",
        "VII",
        "ITI",
        "CCI",
        "SWI",
        "VEI",
        "IRI"
    ],

    "aggregation": "weighted_sum",

    "weights": {
        "GVI": 1.507,
        "SVI": 0.692,
        "EVI": 0.447,
        "MVI": -2.412,
        "SFI": -0.011,
        "PCI": -0.800,
        "VII": -0.060,
        "ITI": 1.414,
        "CCI": -0.167,
        "SWI": 0.208,
        "VEI": 7.798,
        "IRI": -6.344
    }
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Aggregation: {INDICATOR.get('aggregation', 'weighted_sum')}")


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
            "error": "IND_SQI: composite indicator — call after per-image metrics are computed; cannot evaluate from a single image_path",
            "skip_reason": "composite_or_aggregator",
        }
    try:
        comps = INDICATOR.get('components', [])
        w = INDICATOR.get('weights', {})

        component_values = {}
        contributions = {}
        total = 0.0

        for k in comps:
            x = float(values.get(k, 0))
            wk = float(w.get(k, 0))
            component_values[k] = round(x, 3)
            contrib = wk * x
            contributions[k] = round(float(contrib), 3)
            total += contrib

        return {
            'success': True,
            'value': round(float(total), 3),
            'aggregation_method': INDICATOR.get('aggregation', 'weighted_sum'),
            'weights': {k: round(float(w.get(k, 0)), 3) for k in comps},
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
def interpret_sqi(score: float) -> str:
    if score < -1:
        return "Very low street quality"
    elif score < 0:
        return "Low street quality"
    elif score < 1:
        return "Medium street quality"
    elif score < 2:
        return "High street quality"
    else:
        return "Very high street quality"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Street Quality Index calculator...")

    test_values = {
        "GVI": 0.35,
        "SVI": 0.40,
        "EVI": 0.30,
        "MVI": 0.20,
        "SFI": 0.50,
        "PCI": 0.25,
        "VII": 0.30,
        "ITI": 0.45,
        "CCI": 0.20,
        "SWI": 0.55,
        "VEI": 0.60,
        "IRI": 0.25
    }

    result = calculate_indicator(test_values)

    print("\nTest inputs:")
    print(f" Components: {result['components']}")
    print(f" Contributions: {result['contributions']}")
    print(f" SQI: {result['value']}")
    print(f" Level: {interpret_sqi(result['value'])}")


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
