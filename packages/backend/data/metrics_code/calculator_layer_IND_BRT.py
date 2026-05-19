"""Calculator Layer.

Indicator ID:   IND_BRT
Indicator Name: Perceived Brightness Score
Type:           TYPE E
"""

import numpy as np
from PIL import Image
from typing import Dict
import os


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    "id": "IND_BRT",
    "name": "Perceived Brightness Score",
    "unit": "confidence",
    "formula": "Softmax output of Siamese CNN",
    "target_direction": "INCREASE",
    "definition": "Subjective perceived brightness predicted by a Siamese CNN (softmax confidence)",
    "category": "CAT_COM",

    "calc_type": "deep_learning",

    "model_config": {
        "model_type": "SiameseCNN",
        "model_path": "./models/brightness_siamese.pth",
        "input_size": (224, 224),
        "normalize": True,
        "mean": [0.485, 0.456, 0.406],
        "std": [0.229, 0.224, 0.225],
        "num_classes": 3,
        "label_map": ["Dark", "Medium", "Bright"]
    },

    "output_type": "classification",
    "output_range": [0, 1],

    # PLACEHOLDER MODE
    "use_placeholder": True
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Mode: {'Placeholder (rule-based)' if INDICATOR.get('use_placeholder', True) else 'Deep Learning'}")


# =============================================================================
# DEEP LEARNING ENVIRONMENT
# =============================================================================
TORCH_AVAILABLE = False
try:
    import torch
    import torch.nn as nn
    import torchvision.transforms as transforms
    from torchvision import models
    TORCH_AVAILABLE = True
    print(f" PyTorch: Available (version {torch.__version__})")
except ImportError:
    print(f" PyTorch: Not installed")
    print(f" To enable full DL mode: pip install torch torchvision")


# =============================================================================
# Siamese CNN — gated by TORCH_AVAILABLE.
#
# Defining `class X(nn.Module)` at module top level when `nn` is None
# raises NameError AT IMPORT TIME, which prevents the metrics orchestrator
# from loading the calculator at all (the placeholder path becomes dead
# code in that state). Wrapping the class behind TORCH_AVAILABLE keeps
# the module importable when torch isn't installed, while the rule-based
# placeholder branch in `calculate_indicator()` continues to work.
# =============================================================================
if TORCH_AVAILABLE:
    class SiameseCNN(nn.Module):
        def __init__(self, num_classes: int = 3):
            super().__init__()
            backbone = models.resnet18(pretrained=False)
            backbone.fc = nn.Identity()
            self.backbone = backbone
            self.classifier = nn.Sequential(
                nn.Linear(512, 128),
                nn.ReLU(inplace=True),
                nn.Linear(128, num_classes)
            )

        def forward(self, x):
            feat = self.backbone(x)
            logits = self.classifier(feat)
            return logits
else:
    SiameseCNN = None  # sentinel — calculate_deep_learning refuses to run


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str) -> Dict:
    use_placeholder = INDICATOR.get('use_placeholder', True)

    if use_placeholder or not TORCH_AVAILABLE:
        return calculate_placeholder(image_path)
    else:
        return calculate_deep_learning(image_path)


def calculate_placeholder(image_path: str) -> Dict:
    try:
        img = Image.open(image_path).convert('RGB')
        rgb = np.array(img, dtype=np.float64)

        gray = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
        mean_gray = float(np.mean(gray))

        score = mean_gray / 255.0
        score = max(0.0, min(1.0, score))

        # softmax
        # Dark centered at 40, Medium at 128, Bright at 220
        def tri(x, c, w):
            d = abs(x - c)
            return max(0.0, 1.0 - d / w)

        p_dark = tri(mean_gray, 40, 80)
        p_med = tri(mean_gray, 128, 90)
        p_brt = tri(mean_gray, 220, 80)

        s = p_dark + p_med + p_brt
        if s <= 0:
            p_dark, p_med, p_brt = 1/3, 1/3, 1/3
        else:
            p_dark, p_med, p_brt = p_dark / s, p_med / s, p_brt / s

        probs = {"Dark": round(p_dark, 4), "Medium": round(p_med, 4), "Bright": round(p_brt, 4)}
        pred_class = max(probs, key=probs.get)
        confidence = float(probs[pred_class])

        return {
            'success': True,
            'value': round(float(score), 3),
            'method': 'placeholder_rule_based',
            'confidence': round(float(confidence), 3),
            'predicted_class': pred_class,
            'mean_gray': round(mean_gray, 3),
            'softmax': probs,
            'note': 'This is a placeholder estimation, not a deep learning prediction'
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'value': None,
            'method': 'placeholder_rule_based'
        }


def calculate_deep_learning(image_path: str) -> Dict:
    try:
        model_config = INDICATOR.get('model_config', {})
        model_path = model_config.get('model_path', '')

        if not os.path.exists(model_path):
            return {
                'success': False,
                'error': f'Model file not found: {model_path}',
                'value': None,
                'method': 'deep_learning',
                'fallback': 'Run with use_placeholder=True or provide model file'
            }

        num_classes = int(model_config.get('num_classes', 3))
        label_map = model_config.get('label_map', None)

        model = SiameseCNN(num_classes=num_classes)
        model.load_state_dict(torch.load(model_path, map_location='cpu'))
        model.eval()

        device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        model = model.to(device)

        input_size = model_config.get('input_size', (224, 224))
        mean = model_config.get('mean', [0.485, 0.456, 0.406])
        std = model_config.get('std', [0.229, 0.224, 0.225])

        transform = transforms.Compose([
            transforms.Resize(input_size),
            transforms.ToTensor(),
            transforms.Normalize(mean=mean, std=std)
        ])

        img = Image.open(image_path).convert('RGB')
        img_tensor = transform(img).unsqueeze(0).to(device)

        with torch.no_grad():
            logits = model(img_tensor)  # [1, C]
            probs = torch.softmax(logits, dim=1).squeeze(0)  # [C]

        conf, pred = torch.max(probs, dim=0)
        conf_value = float(conf.cpu().numpy())
        pred_idx = int(pred.cpu().numpy())

        if isinstance(label_map, (list, tuple)) and pred_idx < len(label_map):
            pred_label = label_map[pred_idx]
        elif isinstance(label_map, dict) and pred_idx in label_map:
            pred_label = label_map[pred_idx]
        else:
            pred_label = pred_idx

        # softmax dict
        probs_list = probs.cpu().numpy().tolist()
        softmax = {}
        for i in range(num_classes):
            if isinstance(label_map, (list, tuple)) and i < len(label_map):
                k = label_map[i]
            elif isinstance(label_map, dict) and i in label_map:
                k = label_map[i]
            else:
                k = str(i)
            softmax[k] = round(float(probs_list[i]), 4)

        # Brightness Score Bright
        # Bright max conf
        if isinstance(label_map, (list, tuple)) and "Bright" in label_map:
            bright_idx = label_map.index("Bright")
            value = float(probs_list[bright_idx])
        else:
            value = conf_value

        return {
            'success': True,
            'value': round(float(value), 3),
            'method': 'deep_learning',
            'model_type': model_config.get('model_type', 'SiameseCNN'),
            'device': str(device),
            'confidence': round(float(conf_value), 3),
            'predicted_class': pred_label,
            'softmax': softmax
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'value': None,
            'method': 'deep_learning'
        }


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================
def interpret_brightness(score: float) -> str:
    if score < 0.2:
        return "Very dark appearance"
    elif score < 0.4:
        return "Dark appearance"
    elif score < 0.6:
        return "Moderate brightness"
    elif score < 0.8:
        return "Bright appearance"
    else:
        return "Very bright appearance"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Perceived Brightness Score calculator...")

    dark = np.zeros((120, 120, 3), dtype=np.uint8) + 20
    mid = np.zeros((120, 120, 3), dtype=np.uint8) + 128
    bright = np.zeros((120, 120, 3), dtype=np.uint8) + 235

    for name, test_img in [('Dark', dark), ('Medium', mid), ('Bright', bright)]:
        test_path = f'/tmp/test_brt_{name}.png'
        Image.fromarray(test_img).save(test_path)

        result = calculate_indicator(test_path)

        print(f"\n{name}:")
        print(f" Score: {result['value']} (0-1)")
        print(f" Method: {result['method']}")
        if 'mean_gray' in result:
            print(f" Mean gray: {result['mean_gray']}")
        if 'predicted_class' in result:
            print(f" Pred: {result['predicted_class']} (conf={result.get('confidence')})")
        print(f" Interpretation: {interpret_brightness(result['value'])}")

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
