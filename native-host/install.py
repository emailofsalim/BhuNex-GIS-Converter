#!/usr/bin/env python3
"""Installs the BhuNex GIS Converter native messaging host.

Writes the host manifest into the per-user location Chrome reads, with the
extension id supplied on the command line. Nothing is installed system-wide and
nothing runs as administrator: the helper is a user-level tool that only the
named extension may talk to.

    python3 install.py --extension-id <id>
    python3 install.py --extension-id <id> --uninstall

The extension id is shown on chrome://extensions with Developer mode enabled,
and in the extension's own Settings → Native engine panel.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Both of these keep their original spelling through the rename to
# BhuNex GIS Converter, because both are addresses rather than labels. The host
# name must match `HOST_NAME` in the extension and the manifest already written
# into the browser's per-user directory; the script name must match the absolute
# path recorded inside that manifest. Renaming either would leave a helper
# installed before the rename unreachable, reported to the user as "DWG support
# is not installed" while they are looking at the installed helper.
HOST_NAME = "com.universal_bhunex_converter.host"
HERE = Path(__file__).resolve().parent
HOST_SCRIPT = HERE / "universal_bhunex_host.py"


def manifest_directories() -> list[Path]:
    """Per-user native messaging directories for the Chromium family."""
    home = Path.home()
    if sys.platform.startswith("win"):
        # Windows resolves the manifest through the registry rather than a
        # directory, so the manifest is written beside the host and registered.
        return [HERE]
    if sys.platform == "darwin":
        support = home / "Library" / "Application Support"
        return [
            support / "Google" / "Chrome" / "NativeMessagingHosts",
            support / "Google" / "Chrome Beta" / "NativeMessagingHosts",
            support / "Chromium" / "NativeMessagingHosts",
            support / "Microsoft Edge" / "NativeMessagingHosts",
        ]
    config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    return [
        config / "google-chrome" / "NativeMessagingHosts",
        config / "google-chrome-beta" / "NativeMessagingHosts",
        config / "chromium" / "NativeMessagingHosts",
        config / "microsoft-edge" / "NativeMessagingHosts",
    ]


def build_manifest(extension_id: str) -> dict[str, object]:
    return {
        "name": HOST_NAME,
        "description": "BhuNex GIS Converter DWG helper (drives your installed ODA File Converter).",
        # Chrome executes this path directly, so it must be absolute.
        "path": str(HOST_SCRIPT),
        "type": "stdio",
        # Only this extension may connect. Widening it would let any installed
        # extension drive a local executable.
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }


def register_windows(manifest_path: Path, uninstall: bool) -> None:
    import winreg  # noqa: PLC0415 - Windows-only import

    key_path = rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
    if uninstall:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            print(f"removed registry key HKCU\\{key_path}")
        except FileNotFoundError:
            print("registry key was not present")
        return
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, None, 0, winreg.REG_SZ, str(manifest_path))
    print(f"registered HKCU\\{key_path} -> {manifest_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--extension-id", help="The extension id from chrome://extensions.")
    parser.add_argument("--uninstall", action="store_true", help="Remove the host manifest.")
    args = parser.parse_args()

    if not args.uninstall and not args.extension_id:
        parser.error("--extension-id is required unless --uninstall is given")

    if not HOST_SCRIPT.is_file():
        print(f"error: {HOST_SCRIPT} is missing", file=sys.stderr)
        return 1

    # The manifest names the script by absolute path, and Chrome runs it
    # directly on macOS and Linux, so it has to be executable.
    if not sys.platform.startswith("win"):
        HOST_SCRIPT.chmod(HOST_SCRIPT.stat().st_mode | 0o111)

    installed = 0
    for directory in manifest_directories():
        manifest_path = directory / f"{HOST_NAME}.json"
        if args.uninstall:
            if manifest_path.exists():
                manifest_path.unlink()
                print(f"removed {manifest_path}")
                installed += 1
            continue
        # Only install where the browser is actually present, except on Windows
        # where the manifest lives beside the host.
        if not directory.parent.exists() and not sys.platform.startswith("win"):
            continue
        directory.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(build_manifest(args.extension_id), indent=2) + "\n", encoding="utf-8")
        print(f"installed {manifest_path}")
        installed += 1
        if sys.platform.startswith("win"):
            register_windows(manifest_path, uninstall=False)

    if sys.platform.startswith("win") and args.uninstall:
        register_windows(HERE / f"{HOST_NAME}.json", uninstall=True)

    if installed == 0:
        print("no Chromium-family browser directories were found; nothing to do", file=sys.stderr)
        return 1

    if not args.uninstall:
        print("\nNext steps:")
        print("  1. Install ODA File Converter (free) from opendesign.com if you have not already.")
        print("  2. Set its path in native-host/host-config.json, or leave it empty to auto-detect.")
        print("  3. Restart the browser, then check Settings -> Native engine in the extension.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
