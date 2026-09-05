#!/usr/bin/env python3
"""Universal Geo Converter — Chrome native messaging host.

A Chrome extension cannot execute a native converter, so DWG support runs
through this small local helper, which drives the user's own installed ODA File
Converter. The ODA invocation, the isolated per-job temp directory and the
output validation are carried over from the Pakhar CAD GIS prototype's
``backend/services/dwg_converter.py``; what is new is the stdio framing and the
refusal to touch anything outside its own job directory.

Protocol (Chrome native messaging): each message is a 4-byte little-endian
length followed by that many bytes of UTF-8 JSON.

  ->  {"id": "...", "op": "ping" | "health" | "convert", "payload": {...}}
  <-  {"id": "...", "ok": true,  "result": {...}, "engine": {...}}
  <-  {"id": "...", "ok": false, "error": {"code", "what", "why", "action"}}

Every error carries what happened, why, and the safe next action — the same
contract the extension's own errors follow.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HOST_VERSION = "1.0.0"
CONFIG_PATH = Path(__file__).resolve().parent / "host-config.json"

# DWG files start with "AC10xx". Checking the magic before invoking a converter
# keeps a mislabelled file from reaching the subprocess at all.
DWG_MAGIC_PREFIX = b"AC10"

DEFAULT_CONFIG: dict[str, Any] = {
    "odaExecutable": "",
    "odaOutputVersion": "ACAD2018",
    "odaOutputType": "DXF",
    "odaRecursive": "0",
    "odaAudit": "1",
    "conversionTimeoutSeconds": 180,
    "maxInputMb": 400,
}


class HostError(Exception):
    """An error with the four fields every user-facing failure must carry."""

    def __init__(self, code: str, what: str, why: str, action: str) -> None:
        super().__init__(f"{what} {why} {action}")
        self.code = code
        self.what = what
        self.why = why
        self.action = action

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "what": self.what, "why": self.why, "action": self.action}


@dataclass
class EngineInfo:
    name: str
    version: str
    path: str
    ready: bool

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "version": self.version, "path": self.path, "ready": self.ready}


def load_config() -> dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.is_file():
        try:
            config.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except json.JSONDecodeError as error:
            raise HostError(
                "HOST_CONFIG_INVALID",
                f"The helper configuration at {CONFIG_PATH} could not be read.",
                f"It is not valid JSON: {error}.",
                "Fix or delete host-config.json, then re-run the installer.",
            ) from error
    # The environment variable wins so a user can point at a different install
    # without editing the file.
    override = os.environ.get("UGC_ODA_EXECUTABLE")
    if override:
        config["odaExecutable"] = override
    return config


def find_oda(config: dict[str, Any]) -> Path | None:
    """Locates ODA File Converter, preferring the configured path."""
    configured = str(config.get("odaExecutable") or "").strip()
    if configured:
        candidate = Path(configured)
        return candidate if candidate.is_file() else None

    # Fall back to the default install locations, newest version first so a
    # machine with several installs uses the most recent.
    candidates: list[Path] = []
    if sys.platform.startswith("win"):
        for root in (Path("C:/Program Files"), Path("C:/Program Files (x86)")):
            base = root / "ODA"
            if base.is_dir():
                candidates.extend(sorted(base.glob("ODAFileConverter*/ODAFileConverter.exe"), reverse=True))
    elif sys.platform == "darwin":
        candidates.extend(sorted(Path("/Applications").glob("ODAFileConverter*.app/Contents/MacOS/ODAFileConverter"), reverse=True))
    else:
        for name in ("ODAFileConverter", "odafileconverter"):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))
        candidates.extend(sorted(Path("/usr/bin").glob("ODAFileConverter*"), reverse=True))

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def engine_info(config: dict[str, Any]) -> EngineInfo:
    executable = find_oda(config)
    if executable is None:
        return EngineInfo("ODA File Converter", "not found", "", False)
    # The version is taken from the install directory name; ODA File Converter
    # has no --version flag, and launching it to ask would open its GUI.
    version = executable.parent.name if executable.parent.name.startswith("ODAFileConverter") else "unknown"
    return EngineInfo("ODA File Converter", version, str(executable), True)


def read_message() -> dict[str, Any] | None:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    (length,) = struct.unpack("<I", raw_length)
    # Chrome caps a message to the host at 4 GB, but anything above the
    # configured input limit is refused before it is buffered.
    if length > 512 * 1024 * 1024:
        raise HostError(
            "HOST_MESSAGE_TOO_LARGE",
            "The extension sent a message larger than 512 MB.",
            "Native messaging buffers the whole message in memory, which would exhaust the helper.",
            "Convert the DWG to DXF with ODA File Converter directly, then import the DXF.",
        )
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def write_message(message: dict[str, Any]) -> None:
    body = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(body)))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def convert_dwg(payload: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    engine = engine_info(config)
    if not engine.ready:
        raise HostError(
            "ODA_NOT_INSTALLED",
            "ODA File Converter was not found on this machine.",
            "The helper looked at the configured path and the default install locations and found no executable.",
            "Install ODA File Converter (free, from opendesign.com), then set its path in native-host/host-config.json and restart the browser.",
        )

    source_name = str(payload.get("sourceName") or "input.dwg")
    encoded = payload.get("sourceBase64")
    if not encoded:
        raise HostError(
            "DWG_NO_PAYLOAD",
            "The conversion request carried no file data.",
            "sourceBase64 was empty.",
            "Retry the conversion; if it keeps happening, re-add the file to the queue.",
        )

    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as error:  # noqa: BLE001 - any decode failure is the same user-facing fault
        raise HostError(
            "DWG_PAYLOAD_CORRUPT",
            "The file data could not be decoded.",
            f"The base64 payload is malformed: {error}.",
            "Re-add the file to the queue and convert again.",
        ) from error

    max_bytes = int(config.get("maxInputMb", 400)) * 1024 * 1024
    if len(data) > max_bytes:
        raise HostError(
            "DWG_TOO_LARGE",
            f"The DWG is {len(data) / 1024 / 1024:.0f} MB, above the {max_bytes / 1024 / 1024:.0f} MB helper limit.",
            "The helper holds the file in memory while ODA runs.",
            "Raise maxInputMb in native-host/host-config.json, or convert the drawing to DXF with ODA File Converter directly.",
        )

    if not data[:4].startswith(DWG_MAGIC_PREFIX):
        raise HostError(
            "DWG_NOT_A_DWG",
            "The file is not a DWG drawing.",
            f"A DWG begins with the version marker AC10xx; this file begins with {data[:6]!r}.",
            "Check the file — a DXF or a renamed file cannot be converted by the DWG engine.",
        )

    # Every job gets its own temp directory and it is always removed, so the
    # helper never accumulates user drawings on disk.
    job_dir = Path(tempfile.mkdtemp(prefix="ugc_dwg_"))
    try:
        input_dir = job_dir / "input"
        output_dir = job_dir / "output"
        input_dir.mkdir()
        output_dir.mkdir()

        # The name is taken apart rather than trusted: a path separator in it
        # would otherwise write outside the job directory.
        safe_name = Path(source_name).name or "input.dwg"
        if not safe_name.lower().endswith(".dwg"):
            safe_name += ".dwg"
        (input_dir / safe_name).write_bytes(data)

        command = [
            engine.path,
            str(input_dir),
            str(output_dir),
            str(config.get("odaOutputVersion", "ACAD2018")),
            str(config.get("odaOutputType", "DXF")),
            str(config.get("odaRecursive", "0")),
            str(config.get("odaAudit", "1")),
            "*.DWG",
        ]

        try:
            completed = subprocess.run(  # noqa: S603 - the executable is user-configured, not attacker-supplied
                command,
                capture_output=True,
                text=True,
                timeout=int(config.get("conversionTimeoutSeconds", 180)),
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as error:
            raise HostError(
                "ODA_TIMEOUT",
                f"ODA File Converter did not finish within {config.get('conversionTimeoutSeconds', 180)} seconds.",
                "Large or damaged drawings can exceed the timeout, and ODA may also be waiting on a dialog.",
                "Raise conversionTimeoutSeconds in host-config.json, or open the drawing in ODA File Converter once to clear any prompt.",
            ) from error
        except OSError as error:
            raise HostError(
                "ODA_LAUNCH_FAILED",
                "ODA File Converter could not be started.",
                str(error),
                "Check that the path in host-config.json points at the executable and that it is runnable.",
            ) from error

        produced = sorted(output_dir.glob("*.dxf")) + sorted(output_dir.glob("*.DXF"))
        if completed.returncode != 0 or not produced:
            detail = (completed.stderr or completed.stdout or "no converter output").strip()
            raise HostError(
                "ODA_CONVERSION_FAILED",
                f"ODA File Converter exited with code {completed.returncode} and produced no DXF.",
                detail[:800],
                "Open the drawing in ODA File Converter to see the failure directly; the file may be password-protected or corrupt.",
            )

        output = max(produced, key=lambda path: path.stat().st_mtime)
        dxf_bytes = output.read_bytes()
        if len(dxf_bytes) < 100 or b"SECTION" not in dxf_bytes[:2048].upper():
            raise HostError(
                "ODA_OUTPUT_INVALID",
                "The converter produced a file that is not a readable ASCII DXF.",
                f"The output is {len(dxf_bytes)} bytes and has no SECTION marker in its header.",
                "Try a different output version in host-config.json (for example ACAD2013), or convert the drawing manually.",
            )

        return {
            "fileName": output.name,
            "sourceFormat": "DWG",
            "targetFormat": "DXF",
            "outputVersion": config.get("odaOutputVersion", "ACAD2018"),
            "bytes": len(dxf_bytes),
            "dxfBase64": base64.b64encode(dxf_bytes).decode("ascii"),
        }
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def handle(message: dict[str, Any]) -> dict[str, Any]:
    message_id = message.get("id", "")
    operation = message.get("op", "")
    config = load_config()
    engine = engine_info(config)

    if operation == "ping":
        return {"id": message_id, "ok": True, "result": {"host": "universal-geo-converter", "version": HOST_VERSION}, "engine": engine.to_dict()}

    if operation == "health":
        return {
            "id": message_id,
            "ok": True,
            "result": {
                "status": "READY" if engine.ready else "NOT_INSTALLED",
                "hostVersion": HOST_VERSION,
                "python": sys.version.split()[0],
                "platform": sys.platform,
                "configPath": str(CONFIG_PATH),
                "outputVersion": config.get("odaOutputVersion"),
            },
            "engine": engine.to_dict(),
        }

    if operation == "convert":
        result = convert_dwg(message.get("payload") or {}, config)
        return {"id": message_id, "ok": True, "result": result, "engine": engine.to_dict()}

    raise HostError(
        "HOST_UNKNOWN_OP",
        f'The helper received an unknown operation "{operation}".',
        "Only ping, health and convert are implemented.",
        "Update the extension and the helper to matching versions.",
    )


def main() -> int:
    while True:
        try:
            message = read_message()
        except HostError as error:
            write_message({"id": "", "ok": False, "error": error.to_dict()})
            continue
        except (json.JSONDecodeError, struct.error) as error:
            write_message(
                {
                    "id": "",
                    "ok": False,
                    "error": {
                        "code": "HOST_BAD_MESSAGE",
                        "what": "The helper could not read the message from the extension.",
                        "why": str(error),
                        "action": "Reload the extension; if it persists, reinstall the native helper.",
                    },
                }
            )
            continue

        if message is None:
            return 0  # Chrome closed the pipe: the browser or the extension shut down.

        try:
            write_message(handle(message))
        except HostError as error:
            write_message({"id": message.get("id", ""), "ok": False, "error": error.to_dict()})
        except Exception as error:  # noqa: BLE001 - the host must never die on one bad job
            write_message(
                {
                    "id": message.get("id", ""),
                    "ok": False,
                    "error": {
                        "code": "HOST_UNEXPECTED",
                        "what": "The helper hit an unexpected error.",
                        "why": f"{type(error).__name__}: {error}",
                        "action": "Report this with the message above; the conversion was not completed.",
                    },
                }
            )


if __name__ == "__main__":
    sys.exit(main())
