"""Calculator Layer.

Indicator ID:   IND_CPX
Indicator Name: Visual Complexity
Type:           TYPE B (Custom Mathematical Formula

Description:
    The Visual Complexity (CPX) indicator quantifies the information entropy of
    a visual scene using Shannon entropy. It measures the complexity and
    diversity of semantic class distribution in street-level imagery. Higher
    entropy values indicate more complex scenes with diverse elements
    distributed more uniformly. Lower entropy indicates simpler scenes dominated
    by fewer classes. Visual complexity is related to: - Scene interest and
    engagement - Wayfinding difficulty - Cognitive load - Aesthetic richness

Formula: )
"""

import numpy as np
from PIL import Image
from typing import Dict, List, Tuple


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    # Basic Information
    "id": "IND_CPX",
    "name": "Visual Complexity",
    "unit": "bits",
    "formula": "H = -Σ(pᵢ × log₂(pᵢ))",
    "target_direction": "NEUTRAL",  # Complexity has no absolute good/bad
    "definition": "Information entropy of visual scene measuring semantic class distribution complexity",
    "category": "CAT_CFG",
    
    # TYPE B Configuration
    "calc_type": "custom",  # Custom mathematical formula
    
    # Variables
    "variables": {
        "H": "Shannon entropy (information entropy) of the visual scene",
        "pᵢ": "Proportion of pixels belonging to semantic category i",
        "Σ": "Sum over all semantic categories in the image",
        "n": "Number of unique semantic classes detected in the image"
    },
    
    # Additional metadata
    "output_range": {
        "min": 0,
        "max": "log₂(n) where n is the number of classes",
        "description": "0 bits = single class; higher values = more diverse/uniform distribution"
    },
    "note": "Uses all semantic classes from the configuration; neutral target direction as optimal complexity depends on context"
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")
print(f" Unit: {INDICATOR['unit']}")


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str) -> Dict:
    """
    Calculate the Visual Complexity (CPX) indicator using Shannon Entropy.
    
    TYPE B - Custom Mathematical Formula
    
    Algorithm:
    1. Load the semantic segmentation mask image
    2. Count pixels for each semantic class
    3. Calculate probability distribution: pᵢ = count_i / total
    4. Calculate Shannon entropy: H = -Σ(pᵢ × log₂(pᵢ))
    
    Args:
        image_path: Path to the semantic segmentation mask image
        
    Returns:
        dict: Result dictionary containing:
            - 'success' (bool): Whether calculation succeeded
            - 'value' (float): Shannon entropy in bits
            - 'n_classes' (int): Number of detected semantic classes
            - 'max_possible_entropy' (float): Theoretical maximum entropy
            - 'normalized_entropy' (float): Normalized entropy (0-1)
            - 'class_distribution' (dict): Pixel counts by class
            - 'top_classes' (dict): Top 5 classes by pixel count
            - 'error' (str): Error message if success is False
            
    Example:
        >>> result = calculate_indicator('/path/to/mask.png')
        >>> if result['success']:
        ...     print(f"Visual Complexity: {result['value']:.3f} bits")
        ...     print(f"Classes detected: {result['n_classes']}")
        ...     print(f"Normalized: {result['normalized_entropy']:.2%}")
    """
    try:
        # Step 1: Load and prepare the image
        img = Image.open(image_path).convert('RGB')
        pixels = np.array(img)
        h, w, _ = pixels.shape
        total_pixels = h * w
        flat_pixels = pixels.reshape(-1, 3)
        
        # Step 2: Count pixels for each semantic class
        class_counts = {}
        
        for class_name, rgb in semantic_colors.items():
            # Create boolean mask for this class
            mask = np.all(flat_pixels == rgb, axis=1)
            count = np.sum(mask)
            if count > 0:
                class_counts[class_name] = int(count)
        
        # Step 3: Calculate probability distribution
        total_counted = sum(class_counts.values())
        
        # Handle edge case: no semantic classes detected
        if total_counted == 0:
            return {
                'success': True,
                'value': 0.0,
                'n_classes': 0,
                'max_possible_entropy': 0.0,
                'normalized_entropy': 0.0,
                'total_pixels': int(total_pixels),
                'matched_pixels': 0,
                'unmatched_pixels': int(total_pixels),
                'class_distribution': {},
                'top_classes': {},
                'note': 'No semantic classes detected in image'
            }
        
        # Calculate probability for each class
        probabilities = {}
        for class_name, count in class_counts.items():
            probabilities[class_name] = count / total_counted
        
        # Step 4: Calculate Shannon Entropy
        # H = -Σ(pᵢ × log₂(pᵢ))
        entropy = 0.0
        for p in probabilities.values():
            if p > 0:  # Avoid log(0)
                entropy -= p * np.log2(p)
        
        # Step 5: Calculate additional metrics
        n_classes = len(class_counts)
        
        # Theoretical maximum entropy (uniform distribution)
        max_entropy = np.log2(n_classes) if n_classes > 1 else 0.0
        
        # Normalized entropy (0-1 range)
        normalized_entropy = entropy / max_entropy if max_entropy > 0 else 0.0
        
        # Unmatched pixels (e.g., black background)
        unmatched_pixels = total_pixels - total_counted
        
        # Top 5 classes by pixel count
        top_classes = dict(sorted(class_counts.items(), 
                                  key=lambda x: x[1], 
                                  reverse=True)[:5])
        
        # Step 6: Return results
        return {
            'success': True,
            'value': round(entropy, 3),
            'n_classes': n_classes,
            'max_possible_entropy': round(max_entropy, 3),
            'normalized_entropy': round(normalized_entropy, 3),
            'total_pixels': int(total_pixels),
            'matched_pixels': int(total_counted),
            'unmatched_pixels': int(unmatched_pixels),
            'match_ratio': round(total_counted / total_pixels * 100, 2),
            'class_distribution': class_counts,
            'class_probabilities': {k: round(v, 4) for k, v in probabilities.items()},
            'top_classes': top_classes
        }
        
    except FileNotFoundError:
        return {
            'success': False,
            'error': f'Image file not found: {image_path}',
            'value': None
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
def interpret_complexity(entropy: float, n_classes: int) -> str:
    """
    Interpret the entropy value and provide a qualitative description.
    
    Args:
        entropy: Calculated Shannon entropy value
        n_classes: Number of detected semantic classes
        
    Returns:
        str: Qualitative interpretation of the complexity level
    """
    if entropy is None or n_classes is None:
        return "Unable to interpret (no data)"
    
    if n_classes <= 1:
        return "Very low complexity: nearly uniform scene"
    
    # Calculate normalized ratio
    max_h = np.log2(n_classes)
    ratio = entropy / max_h if max_h > 0 else 0
    
    if ratio < 0.3:
        return "Low complexity: dominated by few classes"
    elif ratio < 0.5:
        return "Moderate-low complexity: uneven class distribution"
    elif ratio < 0.7:
        return "Moderate complexity: diverse class distribution"
    elif ratio < 0.85:
        return "High complexity: rich, varied scene"
    else:
        return "Very high complexity: nearly uniform distribution across classes"


def calculate_theoretical_max(n_classes: int) -> float:
    """
    Calculate the theoretical maximum entropy for n classes.
    
    Args:
        n_classes: Number of semantic classes
        
    Returns:
        float: Maximum possible entropy in bits
    """
    if n_classes <= 1:
        return 0.0
    return np.log2(n_classes)


# =============================================================================
# STANDALONE TEST (Optional)
# =============================================================================
if __name__ == "__main__":
    import os
    
    print("\nTesting Visual Complexity (Shannon Entropy) calculator...")
    
    # Test 1: Two classes, equal distribution (expected: ~1.0 bits)
    test_img_1 = np.zeros((100, 100, 3), dtype=np.uint8)
    if 'grass' in semantic_colors and 'sky' in semantic_colors:
        test_img_1[0:50, :] = semantic_colors['grass']
        test_img_1[50:100, :] = semantic_colors['sky']
        
        test_path_1 = '/tmp/test_cpx_1.png'
        Image.fromarray(test_img_1).save(test_path_1)
        
        result_1 = calculate_indicator(test_path_1)
        
        print(f"\nTest 1: 50% grass + 50% sky")
        print(f" Expected entropy: ~1.0 bits (2 classes, equal)")
        print(f" Calculated: {result_1['value']} bits")
        print(f" Normalized: {result_1['normalized_entropy']}")
        print(f" Interpretation: {interpret_complexity(result_1['value'], result_1['n_classes'])}")
        
        os.remove(test_path_1)
    
    # Test 2: Four classes, equal distribution (expected: ~2.0 bits)
    test_img_2 = np.zeros((100, 100, 3), dtype=np.uint8)
    classes_test = ['grass', 'sky', 'building;edifice', 'road;route']
    available_classes = [c for c in classes_test if c in semantic_colors]
    
    if len(available_classes) >= 4:
        test_img_2[0:25, :] = semantic_colors['grass']
        test_img_2[25:50, :] = semantic_colors['sky']
        test_img_2[50:75, :] = semantic_colors['building;edifice']
        test_img_2[75:100, :] = semantic_colors['road;route']
        
        test_path_2 = '/tmp/test_cpx_2.png'
        Image.fromarray(test_img_2).save(test_path_2)
        
        result_2 = calculate_indicator(test_path_2)
        
        print(f"\nTest 2: 25% each of 4 classes")
        print(f" Expected entropy: ~2.0 bits (4 classes, equal)")
        print(f" Calculated: {result_2['value']} bits")
        print(f" Normalized: {result_2['normalized_entropy']}")
        print(f" Interpretation: {interpret_complexity(result_2['value'], result_2['n_classes'])}")
        
        os.remove(test_path_2)
    
    # Test 3: Unequal distribution (expected: < maximum)
    test_img_3 = np.zeros((100, 100, 3), dtype=np.uint8)
    if 'sky' in semantic_colors and 'tree' in semantic_colors:
        test_img_3[0:90, :] = semantic_colors['sky']    # 90%
        test_img_3[90:100, :] = semantic_colors['tree']  # 10%
        
        test_path_3 = '/tmp/test_cpx_3.png'
        Image.fromarray(test_img_3).save(test_path_3)
        
        result_3 = calculate_indicator(test_path_3)
        
        print(f"\nTest 3: 90% sky + 10% tree (unequal)")
        print(f" Expected entropy: ~0.47 bits (2 classes, unequal)")
        print(f" Calculated: {result_3['value']} bits")
        print(f" Normalized: {result_3['normalized_entropy']}")
        print(f" Interpretation: {interpret_complexity(result_3['value'], result_3['n_classes'])}")
        
        os.remove(test_path_3)
    
    print("\n Test cleanup complete")


# =============================================================================
# LAYER-AWARE CALCULATION (auto-added 2026-05-11)
# =============================================================================
def calculate_for_layer(semantic_map_path, mask_path=None, original_photo_path=None):
    """v8.0 photo-aware layer wrapper.

    Earlier versions masked the SEMANTIC MAP (ADE20K palette colours) and
    ran the RMS-contrast / Shannon-entropy formula on that, which made
    every image's score a function of which classes happened to be
    present — not of the actual photographic structure. We now mask the
    ORIGINAL PHOTO when supplied; fall back to the semantic map only when
    no photo path is passed so legacy callers still work.
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
