"""Calculator Layer.

Indicator ID:   IND_VSG_BLK
Indicator Name: Visible Street Greenery (Block Level
Type:           TYPE D

Formula: Gn = Σ(Gi * Li * Di^α) / Σ(Li * Di^α)
"""

import numpy as np
from typing import Dict, List


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_VSG_BLK",
    "name": "Visible Street Greenery (Block Level)",
    "unit": "ratio",
    "formula": "Gn = Σ(Gi * Li * Di^α) / Σ(Li * Di^α)",
    "target_direction": "POSITIVE",
    "definition": "Distance-decay weighted average of visible street greenery around a block",
    "category": "CAT_CMP",

    "calc_type": "composite",

    "components": [
        "Gi",
        "Li",
        "Di"
    ],

    "aggregation": "distance_decay_weighted_mean",

    "alpha": -1.0
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Aggregation: {INDICATOR.get('aggregation', 'distance_decay_weighted_mean')}")
print(f" Alpha: {INDICATOR.get('alpha', -1.0)}")


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(Gi: List[float], Li: List[float], Di: List[float], alpha: float = None) -> Dict:
    # v8.0 — graceful skip when called per-image. This is a composite/
    # aggregator indicator that needs other-indicators or multi-location
    # input, not a single image. The orchestrator iterates per-image with
    # image_path strings; without this guard we'd raise AttributeError on
    # the first .get() call. Downstream composite callers that pass the
    # correct dict input still execute the formula below.
    if isinstance(Gi, str):
        return {
            "success": False,
            "value": None,
            "error": "IND_VSG_BLK: composite indicator — call after per-image metrics are computed; cannot evaluate from a single image_path",
            "skip_reason": "composite_or_aggregator",
        }
    try:
        a = float(alpha) if alpha is not None else float(INDICATOR.get('alpha', -1.0))

        Gi_arr = np.array(Gi, dtype=float)
        Li_arr = np.array(Li, dtype=float)
        Di_arr = np.array(Di, dtype=float)

        n = len(Gi_arr)
        if n == 0 or len(Li_arr) != n or len(Di_arr) != n:
            return {
                'success': True,
                'value': 0,
                'alpha': a,
                'n_streets': int(n),
                'note': 'Input lists must have the same non-zero length'
            }

        Di_safe = np.where(Di_arr <= 0, np.nan, Di_arr)

        weights = Li_arr * (Di_safe ** a)

        valid = np.isfinite(weights) & np.isfinite(Gi_arr) & np.isfinite(Li_arr) & np.isfinite(Di_arr)
        Gi_v = Gi_arr[valid]
        Li_v = Li_arr[valid]
        Di_v = Di_arr[valid]
        w_v = weights[valid]

        denom = float(np.sum(w_v))
        if denom <= 0:
            return {
                'success': True,
                'value': 0,
                'alpha': a,
                'n_streets': int(n),
                'note': 'Sum of weights is zero'
            }

        numer = float(np.sum(Gi_v * w_v))
        Gn = numer / denom

        weighted_components = {
            'numerator': round(numer, 6),
            'denominator': round(denom, 6)
        }

        return {
            'success': True,
            'value': round(float(Gn), 3),
            'alpha': round(float(a), 3),
            'n_streets': int(len(Gi_v)),
            'weights': np.round(w_v, 6).tolist(),
            'weighted_components': weighted_components,
            'inputs_summary': {
                'Gi_mean': round(float(np.mean(Gi_v)) if len(Gi_v) > 0 else 0, 3),
                'Li_sum': round(float(np.sum(Li_v)) if len(Li_v) > 0 else 0, 3),
                'Di_mean': round(float(np.mean(Di_v)) if len(Di_v) > 0 else 0, 3)
            }
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
def interpret_vsg_blk(value: float) -> str:
    if value < 0.1:
        return "Very low visible greenery around block"
    elif value < 0.25:
        return "Low visible greenery around block"
    elif value < 0.5:
        return "Medium visible greenery around block"
    else:
        return "High visible greenery around block"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Visible Street Greenery (Block Level) calculator...")

    Gi_test = [0.30, 0.50, 0.10]
    Li_test = [120, 80, 200]
    Di_test = [30, 60, 15]
    alpha_test = -1.0

    result = calculate_indicator(Gi_test, Li_test, Di_test, alpha_test)

    print("\nTest inputs:")
    print(f" Gi: {Gi_test}")
    print(f" Li: {Li_test}")
    print(f" Di: {Di_test}")
    print(f" alpha: {alpha_test}")
    print(f" Gn: {result['value']}")
    print(f" Interpretation: {interpret_vsg_blk(result['value'])}")


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
