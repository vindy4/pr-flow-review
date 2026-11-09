"""Resource and writable paths for browser and packaged desktop runtimes."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RuntimePaths:
    resources: Path
    cache: Path
    data: Path


def runtime_paths(environ=None) -> RuntimePaths:
    env = os.environ if environ is None else environ
    resources = Path(env.get('PR_FLOW_RESOURCE_DIR') or Path(__file__).resolve().parent.parent)
    cache = Path(env.get('PR_FLOW_CACHE_DIR') or resources / '.cache')
    return RuntimePaths(resources, cache, Path(env.get('PR_FLOW_DATA_DIR') or cache))


def persistent_root(browser_default: Path) -> Path:
    """Preserve injected browser caches while separating durable desktop data."""
    return Path(os.environ.get('PR_FLOW_DATA_DIR') or browser_default)
