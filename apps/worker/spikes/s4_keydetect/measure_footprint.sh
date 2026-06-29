#!/bin/bash
# S4: measure the worker-container footprint delta of librosa vs essentia.
# Run inside a throwaway venv to get a clean before/after site-packages size.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

site_size() { python -c "import site; print(site.getsitepackages()[0])" | xargs du -sh 2>/dev/null | cut -f1; }

echo "=== baseline site-packages: $(site_size) ==="

echo "=== librosa ==="
pip install -q -r "$HERE/requirements_librosa.txt" && pip show librosa | grep -E "Name|Version"
python -c "import librosa; print('librosa OK', librosa.__version__)"
echo "site-packages after librosa: $(site_size)"

echo "=== essentia ==="
if pip install -q -r "$HERE/requirements_essentia.txt" 2>/tmp/essentia_install.log; then
  pip show essentia 2>/dev/null | grep -E "Name|Version"
  python -c "import essentia; print('essentia OK')" 2>&1 || echo "essentia import failed"
  echo "site-packages after essentia: $(site_size)"
else
  echo "essentia install FAILED — see /tmp/essentia_install.log"
  tail -3 /tmp/essentia_install.log
fi
