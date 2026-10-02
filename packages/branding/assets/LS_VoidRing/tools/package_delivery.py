"""Package the design kit and check the approved master and exported previews."""
import hashlib
import json
import zipfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
expected = "d485e60e8772bea2b537535af48b4f392ea329728a26e1050a4dd5e50c1c0285"
# The approved PNG must not change when rebuilding motion assets.
master = ROOT / "icon/icon_master.png"
digest = hashlib.sha256(master.read_bytes()).hexdigest()
assert digest == expected, ("approved master changed", digest)
for name, count, duration in [("preview.gif", 216, 7200), ("idle_breath_preview.gif", 108, 3600)]:
    with Image.open(ROOT / name) as gif:
        # Pillow can merge consecutive identical screenshots and retain their delay.
        assert count - 2 <= gif.n_frames <= count, (name, gif.n_frames)
        elapsed = 0
        for i in range(gif.n_frames):
            gif.seek(i)
            elapsed += gif.info["duration"]
        assert elapsed == duration
for name, count in [("idle_breath",108),("loading_orbit",60),("thinking_pulse",96)]:
    assert len(list((ROOT / "motion/fluid_frames" / name).glob("*.png"))) == count
report = json.loads((ROOT / "qa/validation.json").read_text(encoding="utf-8"))
assert not report["browserErrors"]
for item in report["motion"][:3]:
    assert item["blackBodyGeometryStationary"]
    assert item["innerReflectionChange"] > .05
    assert item["refractedRimChange"] > .05
archive = ROOT.parent / "LS_VoidRing_delivery.zip"
files = sorted(p for p in ROOT.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as kit:
    for p in files:
        kit.write(p, str(Path("LS_VoidRing") / p.relative_to(ROOT)))
with zipfile.ZipFile(archive) as kit:
    assert kit.testzip() is None
print(f"Verified master {digest}; packaged {len(files)} files ({archive.stat().st_size/1024**2:.2f} MiB): {archive}")
