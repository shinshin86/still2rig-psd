#!/usr/bin/env python3
"""Pinned See-through worker intended to run inside a user-controlled Colab runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Optional


ROOT = Path("/content/still2rig-psd")
REPO = ROOT / "see-through"


def run(command: list[str], cwd: Optional[Path] = None) -> None:
    printable = " ".join(command)
    print(f"+ {printable}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def output(command: list[str], cwd: Optional[Path] = None) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def load_request(path: Path) -> dict:
    request = json.loads(path.read_text(encoding="utf-8"))
    required = {"jobId", "inputName", "inputSha256", "inference", "requiredGpuPattern"}
    missing = sorted(required - request.keys())
    if missing:
        raise ValueError(f"job request is missing: {', '.join(missing)}")
    if not request["jobId"].replace("-", "").replace("_", "").replace(".", "").isalnum():
        raise ValueError("unsafe job id")
    return request


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_input(request: dict) -> Path:
    name = Path(request["inputName"]).name
    if not name or name in {".", ".."}:
        raise ValueError(f"unsafe inputName: {request['inputName']!r}")
    path = ROOT / name
    resolved = path.resolve()
    if resolved.parent != ROOT.resolve() or not resolved.is_file():
        raise FileNotFoundError(path)
    actual = sha256_file(resolved)
    if actual != request["inputSha256"]:
        raise RuntimeError(f"input hash mismatch: {actual} != {request['inputSha256']}")
    return resolved


def ensure_torch() -> None:
    desired = "2.8.0+cu128"
    try:
        import torch

        if torch.__version__ == desired:
            print(f"torch already pinned: {torch.__version__}")
            return
        print(f"replacing torch {torch.__version__} with {desired}")
    except ImportError:
        print(f"installing torch {desired}")
    run([
        sys.executable,
        "-m",
        "pip",
        "install",
        "torch==2.8.0+cu128",
        "torchvision==0.23.0+cu128",
        "torchaudio==2.8.0+cu128",
        "--index-url",
        "https://download.pytorch.org/whl/cu128",
    ])


def setup(request: dict) -> None:
    inference = request["inference"]
    revision = inference["revision"]
    repository = inference["repository"]
    marker = ROOT / "setup-complete.json"
    if marker.exists():
        installed = json.loads(marker.read_text(encoding="utf-8"))
        if installed.get("revision") == revision and REPO.is_dir():
            actual = output(["git", "rev-parse", "HEAD"], cwd=REPO)
            if actual == revision:
                print(json.dumps({"stage": "setup", "cached": True, "revision": actual}))
                return

    ROOT.mkdir(parents=True, exist_ok=True)
    if not REPO.exists():
        run(["git", "clone", "--filter=blob:none", repository, str(REPO)])
    actual_remote = output(["git", "remote", "get-url", "origin"], cwd=REPO)
    if actual_remote.rstrip("/") != repository.rstrip("/").removesuffix(".git") and actual_remote.rstrip("/") != repository.rstrip("/"):
        raise RuntimeError(f"unexpected See-through origin: {actual_remote}")
    run(["git", "fetch", "origin", revision, "--depth", "1"], cwd=REPO)
    run(["git", "checkout", "--detach", revision], cwd=REPO)
    actual = output(["git", "rev-parse", "HEAD"], cwd=REPO)
    if actual != revision:
        raise RuntimeError(f"See-through revision mismatch: {actual} != {revision}")

    ensure_torch()
    run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], cwd=REPO)
    assets = REPO / "assets"
    if not assets.exists():
        assets.symlink_to(REPO / "common" / "assets", target_is_directory=True)

    import torch

    marker.write_text(json.dumps({
        "revision": actual,
        "python": platform.python_version(),
        "torch": torch.__version__,
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"stage": "setup", "cached": False, "revision": actual, "torch": torch.__version__}))


def gpu_name() -> str:
    return output(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])


def collect_hashes(root: Path) -> list[dict]:
    rows = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            rows.append({
                "file": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            })
    return rows


def run_inference(request: dict) -> None:
    ensure_input(request)
    revision = output(["git", "rev-parse", "HEAD"], cwd=REPO)
    if revision != request["inference"]["revision"]:
        raise RuntimeError("See-through checkout changed after setup")
    gpu = gpu_name()
    required_gpu = request["requiredGpuPattern"]
    if required_gpu and required_gpu.lower() not in gpu.lower():
        raise RuntimeError(f"This job requires a GPU matching {required_gpu!r}; detected {gpu!r}")

    job_id = request["jobId"]
    result_root = ROOT / "results" / job_id
    output_root = result_root / "layerdiff_output"
    if result_root.exists():
        raise FileExistsError(f"result already exists for job {job_id}; create a new local job id")
    result_root.mkdir(parents=True)
    input_path = ensure_input(request)
    inference = request["inference"]
    command = [
        sys.executable,
        "inference/scripts/inference_psd.py",
        "--srcp",
        str(input_path),
        "--save_dir",
        str(output_root),
        "--seed",
        str(inference["seed"]),
        "--resolution",
        str(inference["resolution"]),
        "--resolution_depth",
        str(inference["depthResolution"]),
        "--inference_steps",
        str(inference["inferenceSteps"]),
        "--save_to_psd",
    ]
    if inference.get("splitTopBottomLeftRight"):
        command.append("--tblr_split")
    if inference.get("groupOffload"):
        command.append("--group_offload")

    started = time.time()
    run(command, cwd=REPO)
    finished = time.time()
    if not output_root.exists() or not list(output_root.rglob("*.psd")):
        raise RuntimeError("See-through completed without a PSD output")

    import torch

    manifest = {
        "schemaVersion": 1,
        "producer": "Still2Rig PSD Colab worker 0.1.0",
        "jobId": job_id,
        "input": {
            "file": input_path.name,
            "bytes": input_path.stat().st_size,
            "sha256": request["inputSha256"],
        },
        "seeThrough": {
            "repository": inference["repository"],
            "revision": revision,
            "parameters": {
                "resolution": inference["resolution"],
                "depthResolution": inference["depthResolution"],
                "inferenceSteps": inference["inferenceSteps"],
                "seed": inference["seed"],
                "splitTopBottomLeftRight": bool(inference.get("splitTopBottomLeftRight")),
                "groupOffload": bool(inference.get("groupOffload")),
            },
        },
        "runtime": {
            "gpu": gpu,
            "python": platform.python_version(),
            "torch": torch.__version__,
            "cudaAvailable": bool(torch.cuda.is_available()),
        },
        "timing": {
            "startedUnix": started,
            "finishedUnix": finished,
            "durationSeconds": round(finished - started, 3),
        },
        "artifacts": collect_hashes(output_root),
    }
    (result_root / "run-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    archive = ROOT / f"still2rig-psd-{job_id}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in sorted(result_root.rglob("*")):
            if path.is_file():
                bundle.write(path, path.relative_to(result_root).as_posix())
    result = {"archive": str(archive), "bytes": archive.stat().st_size, "sha256": sha256_file(archive)}
    (ROOT / "latest-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"stage": "complete", **result}))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["setup", "run"])
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    request = load_request(args.request)
    ensure_input(request)
    if args.action == "setup":
        setup(request)
    else:
        run_inference(request)


if __name__ == "__main__":
    main()
