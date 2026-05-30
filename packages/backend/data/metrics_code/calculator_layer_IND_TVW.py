"""Calculator Layer.

Indicator ID:   IND_TVW
Indicator Name: Type of Visual Walkability
Type:           of Visual Walkability
"""

import numpy as np
from typing import Dict
import os
import pickle


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_TVW",
    "name": "Type of Visual Walkability",
    "unit": "category",
    "formula": "K-means Clustering(Gi, Si, Di, Ni)",
    "target_direction": "NEUTRAL",
    "definition": "Categorical classification of street segments via K-means clustering of visual walkability indicators",
    "category": "CAT_COM",

    "calc_type": "deep_learning",

    "model_config": {
        "model_type": "KMeans",
        "model_path": "./models/tvw_kmeans.pkl",
        "n_clusters": 5,
        "feature_order": ["Gi", "Si", "Di", "Ni"], # greenery, openness, pavement, crowdedness
        "standardize": True,                       # StandardScaler
        "scaler_path": "./models/tvw_scaler.pkl"   # StandardScaler
    },

    "output_type": "classification",

    # PLACEHOLDER MODE
    "use_placeholder": True
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Mode: {'Placeholder (rule-based)' if INDICATOR.get('use_placeholder', True) else 'K-means'}")


# =============================================================================
# sklearn
# =============================================================================
SKLEARN_AVAILABLE = False
try:
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler
    SKLEARN_AVAILABLE = True
    print(f" scikit-learn: Available")
except ImportError:
    print(f" scikit-learn: Not installed")
    print(f" To enable full K-means mode: pip install scikit-learn")


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
# Mapping from TVW's input features (Gi, Si, Di, Ni) to ADE20K class names.
# Used by `_derive_features_from_semantic_map` so the orchestrator (which
# only knows about image paths) can drive TVW without first computing four
# other indicators by hand.
TVW_FEATURE_CLASSES = {
    "Gi": ["tree", "grass", "plant;flora;plant;life", "palm;palm;tree", "flower"],
    "Si": ["sky"],
    "Di": [
        "road;route", "sidewalk;pavement", "earth;ground",
        "floor;flooring", "path",
    ],
    "Ni": [
        "person;individual;someone;somebody;mortal;soul",
        "person", "pedestrian",
        "car;auto;automobile;machine;motorcar", "bus",
        "truck;motortruck", "bicycle;bike;wheel;cycle",
        "motorbike;motorcycle",
    ],
}


def _derive_features_from_semantic_map(image_path: str) -> Dict[str, float]:
    """Compute Gi/Si/Di/Ni from a semantic-map PNG by counting ADE20K class
    pixels. Returns a dict ready for `calculate_placeholder` / KMeans. If
    the file or the class-colour map is missing, returns all-zero features
    so callers see a graceful 'Mixed walkability' classification rather
    than a crash."""
    from PIL import Image
    try:
        sem = np.array(Image.open(image_path).convert("RGB"))
    except Exception:
        return {"Gi": 0.0, "Si": 0.0, "Di": 0.0, "Ni": 0.0}
    total = sem.shape[0] * sem.shape[1]
    if total == 0:
        return {"Gi": 0.0, "Si": 0.0, "Di": 0.0, "Ni": 0.0}
    sc = globals().get("semantic_colors")
    if not sc:
        return {"Gi": 0.0, "Si": 0.0, "Di": 0.0, "Ni": 0.0}
    out: Dict[str, float] = {}
    for feat, class_names in TVW_FEATURE_CLASSES.items():
        cnt = 0
        for cn in class_names:
            rgb = sc.get(cn)
            if not rgb:
                continue
            cnt += int(np.sum(np.all(sem == np.array(rgb, dtype=np.uint8), axis=-1)))
        out[feat] = float(cnt) / float(total)
    return out


def calculate_indicator(values) -> Dict:
    """v8.0 — dual-mode entry point.

    * If `values` is already a feature dict (`Gi`/`Si`/`Di`/`Ni`), use it
      directly (the historical API).
    * If `values` is a string, it's an image_path that the metrics
      orchestrator passed — we derive the four features from the semantic
      map at that path before running the clustering. This fixes the
      "string vs dict" mismatch that was making TVW always raise.
    """
    if isinstance(values, str):
        feat = _derive_features_from_semantic_map(values)
    elif isinstance(values, dict):
        feat = {k: float(values.get(k, 0)) for k in ("Gi", "Si", "Di", "Ni")}
    else:
        return {"success": False, "value": None,
                "error": f"TVW: unsupported input type {type(values).__name__}"}
    use_placeholder = INDICATOR.get('use_placeholder', True)
    if use_placeholder or not SKLEARN_AVAILABLE:
        return calculate_placeholder(feat)
    else:
        return calculate_kmeans(feat)


def calculate_for_layer(semantic_map_path, mask_path=None,
                        original_photo_path=None) -> Dict:
    """Layer-aware wrapper for TVW.

    We compute Gi/Si/Di/Ni from the semantic map restricted to `mask_path`
    when given (so 'foreground walkability', 'background walkability'
    etc. each get their own clustering label).
    """
    import os
    from PIL import Image
    try:
        sem = np.array(Image.open(semantic_map_path).convert("RGB"))
    except Exception as e:
        return {"success": False, "value": None, "error": str(e)}
    H, W, _ = sem.shape
    if mask_path and os.path.exists(mask_path):
        with Image.open(mask_path) as m:
            m = m.convert("L")
            if m.size != (W, H):
                m = m.resize((W, H), Image.NEAREST)
            layer_mask = np.array(m) > 127
        sem[~layer_mask] = 0
        denom = int(np.sum(layer_mask))
    else:
        denom = H * W
    if denom == 0:
        return {"success": True, "value": 0, "cluster": 0,
                "label": "no pixels in layer", "method": "layer-aware"}
    sc = globals().get("semantic_colors") or {}
    feat: Dict[str, float] = {}
    for k, class_names in TVW_FEATURE_CLASSES.items():
        cnt = 0
        for cn in class_names:
            rgb = sc.get(cn)
            if not rgb:
                continue
            cnt += int(np.sum(np.all(sem == np.array(rgb, dtype=np.uint8), axis=-1)))
        feat[k] = float(cnt) / float(denom)
    use_placeholder = INDICATOR.get('use_placeholder', True)
    if use_placeholder or not SKLEARN_AVAILABLE:
        return calculate_placeholder(feat)
    return calculate_kmeans(feat)


def calculate_placeholder(values: Dict[str, float]) -> Dict:
    try:
        Gi = float(values.get("Gi", 0))
        Si = float(values.get("Si", 0))
        Di = float(values.get("Di", 0))
        Ni = float(values.get("Ni", 0))

        if (Gi >= 0.5) and (Si >= 0.5) and (Di >= 0.5) and (Ni <= 0.3):
            cluster = 1
            label = "High walkability (green-open-paved, low crowdedness)"
        elif (Gi <= 0.3) and (Si <= 0.3) and (Ni >= 0.6):
            cluster = 2
            label = "Low walkability (low green-open, high crowdedness)"
        else:
            cluster = 0
            label = "Mixed walkability"

        return {
            'success': True,
            'value': cluster,
            'cluster': int(cluster),
            'method': 'placeholder_rule_based',
            'features_used': {
                'Gi': round(Gi, 3),
                'Si': round(Si, 3),
                'Di': round(Di, 3),
                'Ni': round(Ni, 3)
            },
            'label': label,
            'note': 'This is a placeholder rule-based classification, not K-means clustering'
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'value': None,
            'method': 'placeholder_rule_based'
        }


def calculate_kmeans(values: Dict[str, float]) -> Dict:
    try:
        cfg = INDICATOR.get('model_config', {})
        model_path = cfg.get('model_path', '')
        scaler_path = cfg.get('scaler_path', None)
        feature_order = cfg.get('feature_order', ["Gi", "Si", "Di", "Ni"])
        use_scaler = bool(cfg.get('standardize', True))
        if not os.path.exists(model_path):
            return {
                'success': False,
                'value': None,
                'error': f'KMeans model file not found at {model_path}',
                'fallback_hint': 'Set use_placeholder=True in INDICATOR or provide a trained model',
            }

        with open(model_path, 'rb') as fh:
            kmeans = pickle.load(fh)
        scaler = None
        if use_scaler and scaler_path and os.path.exists(scaler_path):
            with open(scaler_path, 'rb') as fh:
                scaler = pickle.load(fh)

        x = np.array([float(values.get(k, 0)) for k in feature_order],
                     dtype=float).reshape(1, -1)
        if scaler is not None:
            x = scaler.transform(x)
        cluster = int(kmeans.predict(x)[0])
        return {
            'success': True,
            'value': cluster,
            'cluster': cluster,
            'method': 'kmeans',
            'features_used': {k: round(float(values.get(k, 0)), 3)
                              for k in feature_order},
        }

    except Exception as e:
        return {
            'success': False,
            'value': None,
            'error': str(e),
            'method': 'kmeans',
        }
