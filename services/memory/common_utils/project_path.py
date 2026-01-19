from pathlib import Path

# Get the directory where this file is located
utils_dir = Path(__file__).parent
# profiling directory is the parent directory of utils
profiling_dir = utils_dir.parent
CURRENT_DIR = profiling_dir
# repo root is two levels up from profiling/ (profiling -> src -> repo)
PROJECT_DIR = profiling_dir.parents[1]


def get_base_scan_path():
    """Get the base scan path"""
    return CURRENT_DIR
