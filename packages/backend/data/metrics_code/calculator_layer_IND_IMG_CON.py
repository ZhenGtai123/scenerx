"""Calculator Layer.

Indicator ID:   IND_IMG_CON
Indicator Name: Image Contrast
Type:           TYPE B (Custom Mathematical Formula - RMS Contrast

Description:
    The Image Contrast (IMG_CON) measures the difference in luminance or color
    that makes objects distinguishable within an image. It is calculated using
    Root Mean Square (RMS) Contrast, which quantifies the standard deviation of
    pixel intensities normalized by the image dimensions and color channels.

Formula: - RMS Contrast)
"""

import numpy as np
from PIL import Image
from typing import Dict, List, Tuple


# =============================================================================
# INDICATOR DEFINITION
# =============================================================================
INDICATOR = {
    # Basic Information
    "id": "IND_IMG_CON",
    "name": "Image Contrast",
    "unit": "intensity",
    "formula": "IMG_CON = Sqrt( Sum( (I_bij - I_bar)^2 ) / (3 * M * N) )",
    "formula_description": "Root Mean Square (RMS) Contrast across all color channels",
    "target_direction": "CONTEXT",  # Depends on design intent
    "definition": "The difference in luminance or color that makes an object distinguishable, measured via Root Mean Square Contrast",
    "category": "CAT_CMP",
    
    # TYPE B Configuration
    "calc_type": "custom",  # Custom mathematical formula (RMS)
    
    # Variables
    "variables": {
        "I_bij": "Intensity value at pixel (i,j) in color channel b",
        "I_bar": "Mean intensity across all pixels and channels",
        "M": "Image height (number of rows)",
        "N": "Image width (number of columns)",
        "3": "Number of color channels (RGB)"
    },
    
    # Additional metadata
    "output_range": {
        "min": 0.0,
        "max": "~128 (for 8-bit images)",
        "description": "0 = uniform image; higher = more contrast"
    },
    "algorithm": "Root Mean Square (RMS) Contrast",
    "note": "Works on raw image pixels, not semantic segmentation. Higher values indicate more visual contrast."
}

print(f"\nCalculator ready: {INDICATOR['id']} - {INDICATOR['name']}")
print(f" Formula: {INDICATOR['formula']}")
print(f" Type: TYPE B (RMS Contrast)")


# =============================================================================
# RMS CONTRAST CALCULATION
# =============================================================================
def calculate_rms_contrast(pixels: np.ndarray) -> Tuple[float, float, Dict]:
    """
    Calculate Root Mean Square (RMS) Contrast for an image.
    
    Formula:
        RMS = Sqrt( Sum( (I_bij - I_bar)^2 ) / (3 * M * N) )
        
    This is equivalent to the population standard deviation of all 
    pixel intensity values across all color channels.
    
    Args:
        pixels: numpy array of shape (M, N, 3) with RGB values
        
    Returns:
        Tuple containing:
        - rms_contrast: The RMS contrast value
        - mean_intensity: The mean intensity (I_bar)
        - channel_stats: Per-channel statistics
    """
    # Ensure float type for calculations
    pixels_float = pixels.astype(np.float64)
    
    # Get dimensions
    M, N, C = pixels_float.shape  # Height, Width, Channels (3 for RGB)
    
    # Calculate mean intensity across all pixels and channels
    I_bar = np.mean(pixels_float)
    
    # Calculate sum of squared differences from mean
    squared_diff_sum = np.sum((pixels_float - I_bar) ** 2)
    
    # Calculate RMS contrast: Sqrt( Sum / (3 * M * N) )
    rms_contrast = np.sqrt(squared_diff_sum / (C * M * N))
    
    # Per-channel statistics
    channel_stats = {}
    channel_names = ['R', 'G', 'B']
    for i, name in enumerate(channel_names):
        channel = pixels_float[:, :, i]
        channel_stats[name] = {
            'mean': round(float(np.mean(channel)), 2),
            'std': round(float(np.std(channel)), 2),
            'min': int(np.min(channel)),
            'max': int(np.max(channel))
        }
    
    return rms_contrast, I_bar, channel_stats


def calculate_michelson_contrast(pixels: np.ndarray) -> float:
    """
    Calculate Michelson Contrast (for reference).
    
    Formula: (I_max - I_min) / (I_max + I_min)
    
    Args:
        pixels: numpy array of shape (M, N, 3) with RGB values
        
    Returns:
        float: Michelson contrast (0 to 1)
    """
    # Convert to grayscale for Michelson
    gray = 0.299 * pixels[:,:,0] + 0.587 * pixels[:,:,1] + 0.114 * pixels[:,:,2]
    I_max = np.max(gray)
    I_min = np.min(gray)
    
    if I_max + I_min == 0:
        return 0.0
    
    return (I_max - I_min) / (I_max + I_min)


# =============================================================================
# CALCULATION FUNCTION
# =============================================================================
def calculate_indicator(image_path: str, 
                        semantic_colors: Dict[str, Tuple[int, int, int]] = None) -> Dict:
    """
    Calculate the Image Contrast (IMG_CON) indicator.
    
    TYPE B - Custom Mathematical Formula (RMS Contrast)
    
    Formula:
        IMG_CON = Sqrt( Sum( (I_bij - I_bar)^2 ) / (3 * M * N) )
        
    Note: This indicator works on raw image pixels, not semantic segmentation.
    The semantic_colors parameter is ignored but kept for API consistency.
    
    Args:
        image_path: Path to the image file (original or mask)
        semantic_colors: Not used for this indicator (ignored)
        
    Returns:
        dict: Result dictionary containing:
            - 'success' (bool): Whether calculation succeeded
            - 'value' (float): RMS contrast value
            - 'mean_intensity' (float): Mean intensity (I_bar)
            - 'image_dimensions' (dict): M, N, C dimensions
            - 'channel_stats' (dict): Per-channel statistics
            - 'michelson_contrast' (float): Alternative contrast measure
            - 'error' (str): Error message if success is False
            
    Example:
        >>> result = calculate_indicator('/path/to/image.png')
        >>> if result['success']:
        ...     print(f"RMS Contrast: {result['value']:.2f}")
        ...     print(f"Mean Intensity: {result['mean_intensity']:.2f}")
    """
    try:
        # Step 1: Load and prepare the image
        img = Image.open(image_path).convert('RGB')
        pixels = np.array(img)
        M, N, C = pixels.shape  # Height, Width, Channels
        total_pixels = M * N
        
        # Step 2: Calculate RMS Contrast
        rms_contrast, mean_intensity, channel_stats = calculate_rms_contrast(pixels)
        
        # Step 3: Calculate alternative contrast measures
        michelson = calculate_michelson_contrast(pixels)
        
        # Step 4: Additional metrics
        # Intensity range
        intensity_min = int(np.min(pixels))
        intensity_max = int(np.max(pixels))
        intensity_range = intensity_max - intensity_min
        
        # Normalized RMS (0-1 scale, dividing by 127.5 which is half of 255)
        normalized_rms = rms_contrast / 127.5
        
        # Step 5: Return results
        return {
            'success': True,
            'value': round(rms_contrast, 4),
            'mean_intensity': round(mean_intensity, 2),
            'image_dimensions': {
                'M': M,
                'N': N,
                'C': C,
                'total_pixels': total_pixels
            },
            'channel_stats': channel_stats,
            'intensity_min': intensity_min,
            'intensity_max': intensity_max,
            'intensity_range': intensity_range,
            'normalized_rms': round(normalized_rms, 4),
            'michelson_contrast': round(michelson, 4)
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
def interpret_img_con(rms_contrast: float) -> str:
    """
    Interpret the Image Contrast value.
    
    Args:
        rms_contrast: RMS contrast value
        
    Returns:
        str: Qualitative interpretation
    """
    if rms_contrast is None:
        return "Unable to interpret (no data)"
    elif rms_contrast < 10:
        return "Very low contrast: nearly uniform image"
    elif rms_contrast < 25:
        return "Low contrast: subtle variations"
    elif rms_contrast < 45:
        return "Moderate contrast: balanced variations"
    elif rms_contrast < 65:
        return "Good contrast: clear distinctions"
    elif rms_contrast < 85:
        return "High contrast: strong visual differences"
    else:
        return "Very high contrast: extreme intensity variations"


def explain_formula() -> str:
    """
    Provide educational explanation of the IMG_CON formula.
    
    Returns:
        str: Explanation text
    """
    return """
    Image Contrast (IMG_CON) Formula:
    
    IMG_CON = Sqrt( Sum( (I_bij - I_bar)^2 ) / (3 * M * N) )
    
    Expanded:
    
    1. I_bar = Mean intensity of all pixels across all channels
       I_bar = Sum(I_bij) / (3 * M * N)
    
    2. Squared differences from mean:
       For each pixel (i,j) in each channel b:
       (I_bij - I_bar)^2
    
    3. Sum all squared differences:
       Sum( (I_bij - I_bar)^2 ) over all i, j, b
    
    4. Divide by total elements (3 channels × M rows × N cols):
       Variance = Sum / (3 * M * N)
    
    5. Take square root for RMS:
       RMS = Sqrt(Variance)
    
    This is essentially the population standard deviation of all 
    pixel intensities, treating R, G, B as independent values.
    
    Interpretation:
    - RMS ≈ 0: Perfectly uniform image (all pixels same color)
    - RMS ≈ 20-40: Low to moderate contrast (typical indoor scenes)
    - RMS ≈ 40-60: Moderate to good contrast (typical outdoor scenes)
    - RMS ≈ 60-80: High contrast (strong lighting differences)
    - RMS > 80: Very high contrast (extreme variations)
    
    For 8-bit images (0-255):
    - Theoretical maximum RMS ≈ 127.5 (half black, half white)
    - Practical maximum for photos: typically 60-90
    
    Related Measures:
    - Michelson Contrast: (I_max - I_min) / (I_max + I_min)
    - Weber Contrast: (I - I_background) / I_background
    - Standard Deviation: Same as RMS for zero-mean images
    """


# =============================================================================
# STANDALONE TEST (Optional)
# =============================================================================
if __name__ == "__main__":
    import os
    
    print("\nTesting Image Contrast calculator...")
    
    # Test 1: Uniform image (all same color) - zero contrast
    test_img_1 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_1[:, :] = [128, 128, 128]  # Uniform gray
    
    test_path_1 = '/tmp/test_img_con_1.png'
    Image.fromarray(test_img_1).save(test_path_1)
    
    result_1 = calculate_indicator(test_path_1)
    
    print(f"\nTest 1: Uniform gray image (128, 128, 128)")
    print(f" Expected RMS: 0.0000")
    print(f" Calculated RMS: {result_1.get('value', 'N/A')}")
    print(f" Mean intensity: {result_1.get('mean_intensity', 'N/A')}")
    print(f" Interpretation: {interpret_img_con(result_1.get('value'))}")
    
    os.remove(test_path_1)
    
    # Test 2: High contrast (half black, half white)
    test_img_2 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_2[:50, :] = [0, 0, 0]       # Top half black
    test_img_2[50:, :] = [255, 255, 255] # Bottom half white
    
    test_path_2 = '/tmp/test_img_con_2.png'
    Image.fromarray(test_img_2).save(test_path_2)
    
    result_2 = calculate_indicator(test_path_2)
    
    print(f"\nTest 2: Half black, half white (maximum contrast)")
    print(f" Expected RMS: ~127.5")
    print(f" Calculated RMS: {result_2.get('value', 'N/A')}")
    print(f" Mean intensity: {result_2.get('mean_intensity', 'N/A')}")
    print(f" Michelson: {result_2.get('michelson_contrast', 'N/A')}")
    print(f" Interpretation: {interpret_img_con(result_2.get('value'))}")
    
    os.remove(test_path_2)
    
    # Test 3: Moderate contrast (gradient)
    test_img_3 = np.zeros((100, 100, 3), dtype=np.uint8)
    for i in range(100):
        test_img_3[i, :] = [int(i * 2.55), int(i * 2.55), int(i * 2.55)]  # Gradient 0-255
    
    test_path_3 = '/tmp/test_img_con_3.png'
    Image.fromarray(test_img_3).save(test_path_3)
    
    result_3 = calculate_indicator(test_path_3)
    
    print(f"\nTest 3: Vertical gradient (0 to 255)")
    print(f" Calculated RMS: {result_3.get('value', 'N/A')}")
    print(f" Mean intensity: {result_3.get('mean_intensity', 'N/A')}")
    print(f" Intensity range: {result_3.get('intensity_range', 'N/A')}")
    print(f" Interpretation: {interpret_img_con(result_3.get('value'))}")
    
    os.remove(test_path_3)
    
    # Test 4: Low contrast (subtle variations)
    test_img_4 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_4[:, :] = [120, 120, 120]  # Base gray
    test_img_4[:50, :] = [130, 130, 130]  # Slightly lighter top
    
    test_path_4 = '/tmp/test_img_con_4.png'
    Image.fromarray(test_img_4).save(test_path_4)
    
    result_4 = calculate_indicator(test_path_4)
    
    print(f"\nTest 4: Low contrast (120 vs 130 gray)")
    print(f" Calculated RMS: {result_4.get('value', 'N/A')}")
    print(f" Mean intensity: {result_4.get('mean_intensity', 'N/A')}")
    print(f" Intensity range: {result_4.get('intensity_range', 'N/A')}")
    print(f" Interpretation: {interpret_img_con(result_4.get('value'))}")
    
    os.remove(test_path_4)
    
    # Test 5: Colorful image
    test_img_5 = np.zeros((100, 100, 3), dtype=np.uint8)
    test_img_5[:50, :50] = [255, 0, 0]    # Red
    test_img_5[:50, 50:] = [0, 255, 0]    # Green
    test_img_5[50:, :50] = [0, 0, 255]    # Blue
    test_img_5[50:, 50:] = [255, 255, 0]  # Yellow
    
    test_path_5 = '/tmp/test_img_con_5.png'
    Image.fromarray(test_img_5).save(test_path_5)
    
    result_5 = calculate_indicator(test_path_5)
    
    print(f"\nTest 5: Four color quadrants (R, G, B, Yellow)")
    print(f" Calculated RMS: {result_5.get('value', 'N/A')}")
    print(f" Mean intensity: {result_5.get('mean_intensity', 'N/A')}")
    print(f" Channel stats: {result_5.get('channel_stats', {})}")
    print(f" Interpretation: {interpret_img_con(result_5.get('value'))}")
    
    os.remove(test_path_5)
    
    print("\n Test complete!")
    print("\n Summary:")
    print(f" - Uniform image: RMS = 0 (no contrast)")
    print(f" - Half B/W: RMS ≈ 127.5 (maximum contrast)")
    print(f" - Gradient: RMS depends on distribution")


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
