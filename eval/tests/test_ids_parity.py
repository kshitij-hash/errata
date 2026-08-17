"""Cross-language parity for vertex ids (cross-language id parity): the Python `vid` MUST reproduce every
entry in packages/graph/fixtures/id-vectors.json, which the TS vitest suite also asserts. A drift
fails CI in both languages. This is the pytest half; it lives in eval/tests/.

Placed here in scratchpad so it can be dropped into eval/tests/ matching the agent's layout.
"""
import hashlib
import json
from pathlib import Path

# repo-root-relative path from eval/tests/ → ../../packages/graph/fixtures/id-vectors.json
FIXTURE = Path(__file__).resolve().parents[2] / "packages" / "graph" / "fixtures" / "id-vectors.json"


def vid(key: str) -> int:
    """53-bit, JS-safe. Must match packages/graph/src/ids.ts byte-for-byte (no key/salt/person)."""
    digest = hashlib.blake2b(key.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") >> 11


def test_id_vectors_parity() -> None:
    data = json.loads(FIXTURE.read_text())
    vectors = data["vectors"]
    assert len(vectors) == data["_count"] >= 100
    for v in vectors:
        assert vid(v["key"]) == v["vid"], f'vid parity drift for key {v["key"]!r}'


def test_id_vectors_are_53_bit_safe() -> None:
    for v in json.loads(FIXTURE.read_text())["vectors"]:
        assert 0 <= v["vid"] < (1 << 53)
