"""pytest setup: make ``apps/training`` importable as ``training.*``."""

from __future__ import annotations

import sys
from pathlib import Path

# apps/training/ -> parent of 'training' package namespace
_TRAINING_ROOT = Path(__file__).resolve().parents[1]
_APPS_DIR = _TRAINING_ROOT.parent  # apps/

# Add apps/ to sys.path so that `import training` and `training.model.alphabet`
# resolve to apps/training/{model/alphabet.py, ...}.
# The package folder on disk is named 'training' (apps/training/), so putting
# apps/ on the path makes `import training` work.
if str(_APPS_DIR) not in sys.path:
    sys.path.insert(0, str(_APPS_DIR))
