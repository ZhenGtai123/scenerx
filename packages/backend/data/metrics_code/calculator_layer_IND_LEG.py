"""Calculator Layer.

Indicator ID:   IND_LEG
Indicator Name: Legibility Index
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
    "id": "IND_LEG",
    "name": "Legibility Index",
    "unit": "confidence",
    "formula": "Softmax probability vector output (max probability as confidence)",
    "target_direction": "INCREASE",
    "definition": "Legibility quantified by the confidence score of a deep learning classification model (softmax max-prob)",
    "category": "CAT_COM",

    "calc_type": "deep_learning",

    "model_config": {
        "model_type": "ResNet50",
        "model_path": "./models/legibility_resnet50_cls.pth",
        "input_size": (224, 224),
        "normalize": True,
        "mean": [0.485, 0.456, 0.406],
        "std": [0.229, 0.224, 0.225],
        "num_classes": 10,
        "label_map": None   # /
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
    import torchvision.transforms as transforms
    from torchvision import models
    TORCH_AVAILABLE = True
    print(f" PyTorch: Available (version {torch.__version__})")
except ImportError:
    print(f" PyTorch: Not installed")
    print(f" To enable full DL mode: pip install torch torchvision")


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

        h, w, _ = rgb.shape
        total_pixels = h * w

        # 1) Laplacian 3x3
        gray = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]

        lap_kernel = np.array([[0, 1, 0],
                               [1, -4, 1],
                               [0, 1, 0]], dtype=np.float64)

        g = gray
        gp = np.pad(g, ((1, 1), (1, 1)), mode='edge')
        lap = (lap_kernel[0, 0] * gp[0:-2, 0:-2] + lap_kernel[0, 1] * gp[0:-2, 1:-1] + lap_kernel[0, 2] * gp[0:-2, 2:] +
               lap_kernel[1, 0] * gp[1:-1, 0:-2] + lap_kernel[1, 1] * gp[1:-1, 1:-1] + lap_kernel[1, 2] * gp[1:-1, 2:] +
               lap_kernel[2, 0] * gp[2:, 0:-2] + lap_kernel[2, 1] * gp[2:, 1:-1] + lap_kernel[2, 2] * gp[2:, 2:])

        edge_var = float(np.var(lap))

        # JPEG
        gray_std = float(np.std(gray))

        # 3) 0-1 (+)(-)
        edge_score = np.log1p(edge_var)
        noise_penalty = np.log1p(gray_std)

        raw = edge_score - 0.6 * noise_penalty

        # Sigmoid0-1
        leg = 1.0 / (1.0 + np.exp(-raw))

        return {
            'success': True,
            'value': round(float(leg), 3),
            'method': 'placeholder_rule_based',
            'confidence': round(float(leg), 3),
            'edge_variance': round(edge_var, 3),
            'gray_std': round(gray_std, 3),
            'dimensions': {'height': int(h), 'width': int(w)},
            'total_pixels': int(total_pixels),
            'note': 'This is a placeholder estimation, not a deep learning prediction',
            'predicted_class': None,
            'topk': None
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

        model_type = model_config.get('model_type', 'ResNet50')
        num_classes = int(model_config.get('num_classes', 10))

        if model_type == 'ResNet50':
            model = models.resnet50(pretrained=False)
            model.fc = torch.nn.Linear(model.fc.in_features, num_classes)
        else:
            raise ValueError(f"Unsupported model type: {model_type}")

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

        # top-k
        k = min(3, num_classes)
        topk_probs, topk_idx = torch.topk(probs, k=k)
        topk_probs = topk_probs.cpu().numpy().tolist()
        topk_idx = topk_idx.cpu().numpy().tolist()

        label_map = model_config.get('label_map', None)
        if isinstance(label_map, (list, tuple)) and pred_idx < len(label_map):
            pred_label = label_map[pred_idx]
        elif isinstance(label_map, dict) and pred_idx in label_map:
            pred_label = label_map[pred_idx]
        else:
            pred_label = pred_idx

        topk = []
        for i in range(k):
            idx_i = int(topk_idx[i])
            prob_i = float(topk_probs[i])
            if isinstance(label_map, (list, tuple)) and idx_i < len(label_map):
                lab = label_map[idx_i]
            elif isinstance(label_map, dict) and idx_i in label_map:
                lab = label_map[idx_i]
            else:
                lab = idx_i
            topk.append({'class': lab, 'prob': round(prob_i, 4)})

        return {
            'success': True,
            'value': round(float(conf_value), 3),
            'method': 'deep_learning',
            'model_type': model_type,
            'device': str(device),
            'confidence': round(float(conf_value), 3),
            'predicted_class': pred_label,
            'topk': topk
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
def interpret_legibility(score: float) -> str:
    if score < 0.2:
        return "Very low legibility: hard to identify/organize"
    elif score < 0.4:
        return "Low legibility"
    elif score < 0.6:
        return "Medium legibility"
    elif score < 0.8:
        return "High legibility"
    else:
        return "Very high legibility: easily identifiable and coherent"


# =============================================================================
# TEST CODE
# =============================================================================
if __name__ == "__main__":
    print("\nTesting Legibility Index calculator...")

    simple = np.full((120, 120, 3), 128, dtype=np.uint8)
    noisy = np.random.randint(0, 256, (120, 120, 3), dtype=np.uint8)

    for name, test_img in [('Simple', simple), ('Noisy', noisy)]:
        test_path = f'/tmp/test_leg_{name}.png'
        Image.fromarray(test_img).save(test_path)

        result = calculate_indicator(test_path)

        print(f"\n{name}:")
        print(f" Score: {result['value']} (0-1)")
        print(f" Method: {result['method']}")
        if 'edge_variance' in result:
            print(f" EdgeVar: {result['edge_variance']}, GrayStd: {result['gray_std']}")
        print(f" Interpretation: {interpret_legibility(result['value'])}")

        os.remove(test_path)


# =============================================================================
# LAYER-AWARE CALCULATION (auto-added 2026-05-11)
# =============================================================================
def calculate_for_layer(semantic_map_path, mask_path=None, original_photo_path=None):
    """Layer-aware wrapper (v8.0 — photo-aware).

    Earlier versions masked the SEMANTIC MAP and ran Laplacian/edge stats
    on that, which made every image's "legibility" equal to a function of
    the semantic palette boundaries — completely insensitive to the actual
    photographic edge complexity. We now mask the ORIGINAL PHOTO when
    supplied so the Laplacian variance / gray std are computed on real
    photographic structure.
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
