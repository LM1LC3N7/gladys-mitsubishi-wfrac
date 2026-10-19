"""Golden vectors for the JavaScript port, computed by pywfrac's own parser.

Run from anywhere, with the portable Python in isolated mode:

    python -I test/fixtures/generate.py <pywfrac>/src <pywfrac>/tests/live_captures.py \
        test/fixtures/golden.json

pywfrac 0.1.10 (MIT, https://github.com/blues-sechseck/pywfrac). The package
`__init__` needs aiohttp, so `pywfrac.parser` is loaded without it. The
payloads are the library's own live captures (an SRK35ZS-WF unit, captured by
its author); nothing comes from a unit of ours.
"""

import importlib
import json
import runpy
import sys
import types

src, captures_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
pkg = types.ModuleType("pywfrac")
pkg.__path__ = [src + "/pywfrac"]
sys.modules["pywfrac"] = pkg
parser_mod = importlib.import_module("pywfrac.parser")
aircon_mod = importlib.import_module("pywfrac.models.aircon")
RacParser = parser_mod.RacParser
AirconStat = aircon_mod.AirconStat

captures = runpy.run_path(captures_path)["LIVE_CAPTURES"]
p = RacParser()


def fields(a):
    return {
        "operation": a.Operation,
        "mode": a.OperationMode,
        "airFlow": a.AirFlow,
        "windUD": a.WindDirectionUD,
        "windLR": a.WindDirectionLR,
        "presetTemp": a.PresetTemp,
        "entrust": a.Entrust,
        "coolHotJudge": a.CoolHotJudge,
        "modelNr": a.ModelNr,
        "modelNrRaw": a.ModelNrRaw,
        "vacant": a.Vacant,
        "selfClean": a.IsSelfCleanOperation,
        "indoorTemp": a.IndoorTemp,
        "outdoorTemp": a.OutdoorTemp,
        "electric": a.Electric,
        "errorCode": a.ErrorCode,
        "compressorRunning": a.CompressorRunning,
    }


CHANGES = [
    ("power_off", {"Operation": False}),
    ("power_on", {"Operation": True}),
    ("mode_heat", {"OperationMode": 2}),
    ("mode_auto", {"OperationMode": 0}),
    ("setpoint_22_5", {"PresetTemp": 22.5}),
    ("fan_high", {"AirFlow": 4}),
    ("fan_auto", {"AirFlow": 0}),
    ("swing_ud_auto", {"WindDirectionUD": 0}),
    ("swing_ud_3", {"WindDirectionUD": 3}),
]

result = {"source": "pywfrac 0.1.10 parser.py (MIT), tests/live_captures.py", "frames": {}}
for name, (payload, _) in captures.items():
    a = p.translate_bytes(payload)
    commands = {}
    for cname, change in CHANGES:
        stat = AirconStat.from_aircon(a)
        for k, v in change.items():
            setattr(stat, k, v)
        commands[cname] = p.to_base64(stat)
    result["frames"][name] = {"payload": payload, "fields": fields(a), "commands": commands}

with open(out, "w", encoding="utf-8", newline="\n") as f:
    json.dump(result, f, indent=2, sort_keys=True)
    f.write("\n")
print("ok", len(result["frames"]))
