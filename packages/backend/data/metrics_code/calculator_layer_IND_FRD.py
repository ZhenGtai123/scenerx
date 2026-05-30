"""Calculator Layer.

Indicator ID:   IND_FRD
Indicator Name: Fractal Dimension
Type:           TYPE B (Custom Mathematical Formula

Description:
    The Fractal Dimension (FRD) indicator is a quantitative measure of
    morphological complexity and roughness, derived from fractal geometry. It
    quantifies the visual complexity of scene boundaries and edges. The
    Box-Counting method is used to estimate the fractal dimension: - Cover the
    image edges with boxes of size r - Count boxes N(r) containing at least one
    edge pixel - Repeat for multiple box sizes - Fractal dimension Db = slope of
    log(N(r)) vs log(1/r) Higher fractal dimension indicates more complex,
    irregular boundaries. Lower fractal dimension indicates simpler, smoother
    boundaries.

Formula: )
"""

import numpy as np
from PIL import Image
from typing import Dict, List, Tuple
from scipy import ndimage


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    # Basic Information
    "id": "IND_FRD",
    "name": "Fractal Dimension",
    "unit": "dimensionless",
    "formula": "Db = lim(r→0) [log N(r) / log(1/r)]",
    "formula_description": "Box-counting fractal dimension",
    "target_direction": "NEUTRAL",  # Complexity has no absolute good/bad
    "definition": "Quantitative measure of morphological complexity and roughness derived from fractal geometry",
    "category": "CAT_CFG",
    
    # TYPE B Configuration
    "calc_type": "custom",  # Custom mathematical formula
    
    # Variables
    "variables": {
        "Db": "Box-counting fractal dimension",
        "N(r)": "Number of boxes of size r covering at least one edge pixel",
        "r": "Scale/size of the box"
    },
    
    # Additional metadata
    "output_range": {
        "min": 1.0,
        "max": 2.0,
        "description": "1.0 = straight line; 2.0 = fills the plane completely"
    },
    "algorithm": "Box-counting method with edge detection",
    "note": "Higher values indicate more complex, irregular visual boundaries"
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")
print(f" Algorithm: {INDICATOR['algorithm']}")


# =============================================================================
# BOX-COUNTING ALGORITHM
# =============================================================================
def box_count(binary_image: np.ndarray, box_sizes: List[int] = None) -> Tuple[np.ndarray, np.ndarray]:
    """
    Perform box-counting on a binary image.
    
    Args:
        binary_image: 2D binary array (edges = 1, background = 0)
        box_sizes: List of box sizes to use (default: powers of 2)
        
    Returns:
        Tuple of (box_sizes, box_counts)
    """
    h, w = binary_image.shape
    min_dim = min(h, w)
    
    # Generate box sizes (powers of 2, from small to large)
    if box_sizes is None:
        max_power = int(np.floor(np.log2(min_dim)))
        min_power = 1  # Start with box size 2
        box_sizes = [2**i for i in range(min_power, max_power)]
    
    # Filter valid box sizes
    box_sizes = [s for s in box_sizes if s < min_dim and s >= 2]
    
    if len(box_sizes) < 3:
        # Need at least 3 points for regression
        box_sizes = [2, 4, 8, 16, 32, 64]
        box_sizes = [s for s in box_sizes if s < min_dim]
    
    box_counts = []
    
    for box_size in box_sizes:
        # Count boxes that contain at least one edge pixel
        count = 0
        for i in range(0, h, box_size):
            for j in range(0, w, box_size):
                # Extract box region
                box = binary_image[i:min(i+box_size, h), j:min(j+box_size, w)]
                # Count if any edge pixel in box
                if np.any(box > 0):
                    count += 1
        box_counts.append(count)
    
    return np.array(box_sizes), np.array(box_counts)


def extract_edges(image: np.ndarray) -> np.ndarray:
    """
    Extract edges from a semantic segmentation mask.
    
    Uses Sobel edge detection to find boundaries between
    different semantic classes.
    
    Args:
        image: RGB image array (semantic mask)
        
    Returns:
        Binary edge image (edges = 1, background = 0)
    """
    # Convert to grayscale using weighted average
    if len(image.shape) == 3:
        # Create a unique value for each RGB combination
        gray = (image[:,:,0].astype(np.int32) * 65536 + 
                image[:,:,1].astype(np.int32) * 256 + 
                image[:,:,2].astype(np.int32))
    else:
        gray = image.astype(np.float64)
    
    # Detect boundaries between different regions
    # Using gradient magnitude
    sobel_x = ndimage.sobel(gray.astype(np.float64), axis=1)
    sobel_y = ndimage.sobel(gray.astype(np.float64), axis=0)
    
    # Magnitude of gradient
    edges = np.sqrt(sobel_x**2 + sobel_y**2)
    
    # Threshold to binary
    threshold = np.mean(edges) + 0.5 * np.std(edges)
    binary_edges = (edges > threshold).astype(np.uint8)
    
    return binary_edges


def calculate_fractal_dimension(binary_edges: np.ndarray) -> Dict:
    """
    Calculate the box-counting fractal dimension.
    
    Args:
        binary_edges: Binary edge image
        
    Returns:
        Dictionary with fractal dimension and fitting statistics
    """
    # Perform box counting
    box_sizes, box_counts = box_count(binary_edges)
    
    # Filter out zero counts
    valid_mask = box_counts > 0
    box_sizes = box_sizes[valid_mask]
    box_counts = box_counts[valid_mask]
    
    if len(box_sizes) < 3:
        return {
            'fractal_dimension': None,
            'r_squared': None,
            'error': 'Insufficient data points for regression'
        }
    
    # Calculate log values
    log_sizes = np.log(1.0 / box_sizes)  # log(1/r)
    log_counts = np.log(box_counts)       # log(N(r))
    
    # Linear regression: log(N) = D * log(1/r) + c
    # where D is the fractal dimension
    coefficients = np.polyfit(log_sizes, log_counts, 1)
    fractal_dim = coefficients[0]  # Slope is the fractal dimension
    intercept = coefficients[1]
    
    # Calculate R-squared
    predicted = np.polyval(coefficients, log_sizes)
    ss_res = np.sum((log_counts - predicted) ** 2)
    ss_tot = np.sum((log_counts - np.mean(log_counts)) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
    
    return {
        'fractal_dimension': fractal_dim,
        'r_squared': r_squared,
        'intercept': intercept,
        'box_sizes': box_sizes.tolist(),
        'box_counts': box_counts.tolist(),
        'log_sizes': log_sizes.tolist(),
        'log_counts': log_counts.tolist()
    }


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str) -> Dict:
    """
    Calculate the Fractal Dimension (FRD) indicator using box-counting.
    
    TYPE B - Custom Mathematical Formula
    
    Algorithm:
    1. Load the semantic segmentation mask image
    2. Extract edges (boundaries between semantic classes)
    3. Apply box-counting at multiple scales
    4. Fit linear regression to log(N(r)) vs log(1/r)
    5. The slope is the fractal dimension
    
    Args:
        image_path: Path to the semantic segmentation mask image
        
    Returns:
        dict: Result dictionary containing:
            - 'success' (bool): Whether calculation succeeded
            - 'value' (float): Fractal dimension (1.0 to 2.0)
            - 'r_squared' (float): Goodness of fit (0 to 1)
            - 'edge_density' (float): Proportion of edge pixels
            - 'n_box_sizes' (int): Number of box sizes used
            - 'error' (str): Error message if success is False
            
    Example:
        >>> result = calculate_indicator('/path/to/mask.png')
        >>> if result['success']:
        ...     print(f"Fractal Dimension: {result['value']:.3f}")
        ...     print(f"R-squared: {result['r_squared']:.3f}")
    """
    try:
        # Step 1: Load and prepare the image
        img = Image.open(image_path).convert('RGB')
        pixels = np.array(img)
        h, w, _ = pixels.shape
        total_pixels = h * w
        
        # Step 2: Extract edges
        binary_edges = extract_edges(pixels)
        
        # Calculate edge density
        edge_pixels = np.sum(binary_edges > 0)
        edge_density = edge_pixels / total_pixels
        
        # Handle case with no edges
        if edge_pixels < 10:
            return {
                'success': True,
                'value': 1.0,  # Minimum fractal dimension (no complexity)
                'r_squared': 0.0,
                'edge_pixels': int(edge_pixels),
                'edge_density': round(edge_density * 100, 3),
                'total_pixels': int(total_pixels),
                'n_box_sizes': 0,
                'note': 'Insufficient edge pixels for reliable calculation'
            }
        
        # Step 3: Calculate fractal dimension
        frd_result = calculate_fractal_dimension(binary_edges)
        
        if frd_result['fractal_dimension'] is None:
            return {
                'success': True,
                'value': 1.0,
                'r_squared': 0.0,
                'edge_pixels': int(edge_pixels),
                'edge_density': round(edge_density * 100, 3),
                'total_pixels': int(total_pixels),
                'n_box_sizes': 0,
                'note': frd_result.get('error', 'Calculation failed')
            }
        
        fractal_dim = frd_result['fractal_dimension']
        
        # Clamp to valid range [1.0, 2.0]
        fractal_dim = max(1.0, min(2.0, fractal_dim))
        
        # Step 4: Return results
        return {
            'success': True,
            'value': round(fractal_dim, 3),
            'r_squared': round(frd_result['r_squared'], 3),
            'intercept': round(frd_result['intercept'], 3),
            'edge_pixels': int(edge_pixels),
            'edge_density': round(edge_density * 100, 3),
            'total_pixels': int(total_pixels),
            'n_box_sizes': len(frd_result['box_sizes']),
            'box_sizes': frd_result['box_sizes'],
            'box_counts': frd_result['box_counts']
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
def interpret_fractal_dimension(frd: float) -> str:
    """
    Interpret the fractal dimension value.
    
    Args:
        frd: Fractal dimension value (1.0 to 2.0)
        
    Returns:
        str: Qualitative interpretation
    """
    if frd is None:
        return "Unable to interpret (no data)"
    elif frd < 1.2:
        return "Very low complexity: simple, smooth boundaries"
    elif frd < 1.4:
        return "Low complexity: relatively simple edges"
    elif frd < 1.6:
        return "Moderate complexity: typical urban scene"
    elif frd < 1.8:
        return "High complexity: intricate, detailed boundaries"
    else:
        return "Very high complexity: highly irregular patterns"


def explain_fractal_dimension() -> str:
    """
    Provide educational explanation of fractal dimension.
    
    Returns:
        str: Explanation text
    """
    return """
    Fractal Dimension (Box-Counting):
    
    • Range: 1.0 to 2.0 for 2D images
    • 1.0 = A perfectly straight line
    • 1.26 = Koch curve (classic fractal)
    • 1.5 = Moderately complex boundary
    • 2.0 = Fills the entire plane
    
    In urban scenes:
    • Lower values: Clean architecture, smooth surfaces
    • Higher values: Complex vegetation, irregular buildings
    """


# =============================================================================
# STANDALONE TEST (Optional)
# =============================================================================
if __name__ == "__main__":
    import os
    
    print("\nTesting Fractal Dimension calculator...")
    
    # Test 1: Simple horizontal line (expected: ~1.0)
    test_img_1 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_1[50, :] = [255, 255, 255]  # Single horizontal line
    
    test_path_1 = '/tmp/test_frd_1.png'
    Image.fromarray(test_img_1).save(test_path_1)
    
    result_1 = calculate_indicator(test_path_1)
    
    print(f"\nTest 1: Single horizontal line")
    print(f" Expected: ~1.0 (straight line)")
    print(f" Calculated: {result_1.get('value', 'N/A')}")
    print(f" R-squared: {result_1.get('r_squared', 'N/A')}")
    
    os.remove(test_path_1)
    
    # Test 2: Checkerboard pattern (expected: higher complexity)
    test_img_2 = np.zeros((128, 128, 3), dtype=np.uint8)
    for i in range(0, 128, 8):
        for j in range(0, 128, 8):
            if (i // 8 + j // 8) % 2 == 0:
                test_img_2[i:i+8, j:j+8] = [255, 0, 0]
            else:
                test_img_2[i:i+8, j:j+8] = [0, 255, 0]
    
    test_path_2 = '/tmp/test_frd_2.png'
    Image.fromarray(test_img_2).save(test_path_2)
    
    result_2 = calculate_indicator(test_path_2)
    
    print(f"\nTest 2: Checkerboard pattern")
    print(f" Expected: Higher complexity (more edges)")
    print(f" Calculated: {result_2.get('value', 'N/A')}")
    print(f" R-squared: {result_2.get('r_squared', 'N/A')}")
    print(f" Edge density: {result_2.get('edge_density', 'N/A')}%")
    
    os.remove(test_path_2)
    
    # Test 3: Random noise (expected: high complexity ~2.0)
    np.random.seed(42)
    test_img_3 = np.random.randint(0, 256, (100, 100, 3), dtype=np.uint8)
    
    test_path_3 = '/tmp/test_frd_3.png'
    Image.fromarray(test_img_3).save(test_path_3)
    
    result_3 = calculate_indicator(test_path_3)
    
    print(f"\nTest 3: Random noise")
    print(f" Expected: ~2.0 (maximum complexity)")
    print(f" Calculated: {result_3.get('value', 'N/A')}")
    print(f" R-squared: {result_3.get('r_squared', 'N/A')}")
    print(f" Interpretation: {interpret_fractal_dimension(result_3.get('value'))}")
    
    os.remove(test_path_3)
    
    print("\n Test cleanup complete")


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
