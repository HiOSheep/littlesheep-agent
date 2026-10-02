"""Export the approved sphere texture and its whole-corona fluid animations.

Requires Node.js, sharp, Playwright, Chromium and Pillow.
"""
from pathlib import Path
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent
subprocess.run(["node", str(TOOLS / "prepare_sphere_layers.mjs")], check=True)
subprocess.run(["node", str(TOOLS / "render_brand_assets.mjs")], check=True)
subprocess.run(["node", str(TOOLS / "verify_brand_assets.mjs")], check=True)
subprocess.run([sys.executable, str(TOOLS / "export_preview.py")], check=True)
