"""``kappa.py``'s label parsing — the part where a human's edits meet the harness.

The κ arithmetic is tested in test_judge_validation.py; what is tested here is reading a sheet a
person filled in by hand, which is where the surprises live: pipes inside answers, a `CORRECT`
written as `correct`, a row left blank, an id that is not in the scored set.
"""

from __future__ import annotations

import sys
from pathlib import Path

import orjson
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import kappa

HEADER = (
    "| # | control_id | Question | Reference answer (gold) | Candidate answer | Verdict |\n"
    "|---:|---|---|---|---|---|\n"
)


def test_reads_the_verdict_column_of_a_filled_in_sheet() -> None:
    text = HEADER + (
        "| 1 | `positive:aaa111` | how much? | $350,000 | three hundred fifty thousand | CORRECT |\n"
        "| 2 | `perturbed:bbb222` | how much? | $350,000 | $400,000 | INCORRECT |\n"
    )
    assert kappa.parse_markdown_labels(text) == {
        "positive:aaa111": "CORRECT",
        "perturbed:bbb222": "INCORRECT",
    }


def test_tolerates_human_spellings_and_ignores_unfilled_rows() -> None:
    text = HEADER + (
        "| 1 | `positive:aaa111` | q | g | c | correct |\n"
        "| 2 | `perturbed:bbb222` | q | g | c | n |\n"
        "| 3 | `positive:ccc333` | q | g | c |  |\n"
    )
    labels = kappa.parse_markdown_labels(text)
    assert labels == {"positive:aaa111": "CORRECT", "perturbed:bbb222": "INCORRECT"}
    assert "positive:ccc333" not in labels  # blank means unlabelled, not INCORRECT


def test_the_header_row_is_not_mistaken_for_a_label() -> None:
    assert kappa.parse_markdown_labels(HEADER) == {}


def test_csv_labels_are_accepted_too(tmp_path: Path) -> None:
    path = tmp_path / "labels.csv"
    path.write_text("control_id,label\npositive:aaa111,CORRECT\nperturbed:bbb222,INCORRECT\n")
    assert kappa.load_labels(path) == {
        "positive:aaa111": "CORRECT",
        "perturbed:bbb222": "INCORRECT",
    }


def _scored(tmp_path: Path, rows: list[dict]) -> Path:
    path = tmp_path / "scored.jsonl"
    path.write_bytes(b"\n".join(orjson.dumps(r) for r in rows) + b"\n")
    return path


def _sheet(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "sheet.md"
    path.write_text(HEADER + body)
    return path


def test_end_to_end_reports_kappa_against_the_scored_verdicts(tmp_path, capsys) -> None:
    scored = _scored(
        tmp_path,
        [
            {"control_id": "positive:a", "verdict": "CORRECT", "judge_model": "j"},
            {"control_id": "positive:b", "verdict": "CORRECT", "judge_model": "j"},
            {"control_id": "perturbed:c", "verdict": "INCORRECT", "judge_model": "j"},
            {"control_id": "perturbed:d", "verdict": "CORRECT", "judge_model": "j"},
        ],
    )
    sheet = _sheet(
        tmp_path,
        "| 1 | `positive:a` | q | g | c | CORRECT |\n"
        "| 2 | `positive:b` | q | g | c | CORRECT |\n"
        "| 3 | `perturbed:c` | q | g | c | INCORRECT |\n"
        "| 4 | `perturbed:d` | q | g | c | INCORRECT |\n",
    )
    assert kappa.main(["--labels", str(sheet), "--scored", str(scored)]) == 0
    out = capsys.readouterr().out
    assert "raw agreement = 3/4" in out
    assert "Cohen's kappa = 0.500" in out
    assert "disagreements: perturbed:d" in out


def test_an_unrecognised_label_fails_loudly_rather_than_being_guessed(tmp_path, capsys) -> None:
    scored = _scored(tmp_path, [{"control_id": "positive:a", "verdict": "CORRECT"}])
    sheet = _sheet(tmp_path, "| 1 | `positive:a` | q | g | c | probably? |\n")
    assert kappa.main(["--labels", str(sheet), "--scored", str(scored)]) == 1
    assert "unrecognised label" in capsys.readouterr().err


def test_a_label_for_an_unknown_control_id_is_an_error(tmp_path, capsys) -> None:
    scored = _scored(tmp_path, [{"control_id": "positive:a", "verdict": "CORRECT"}])
    sheet = _sheet(tmp_path, "| 1 | `positive:zzz` | q | g | c | CORRECT |\n")
    assert kappa.main(["--labels", str(sheet), "--scored", str(scored)]) == 1
    assert "not in" in capsys.readouterr().err


def test_missing_files_exit_two_with_a_pointer_to_the_command_that_writes_them(tmp_path, capsys) -> None:
    scored = _scored(tmp_path, [{"control_id": "positive:a", "verdict": "CORRECT"}])
    assert kappa.main(["--labels", str(tmp_path / "nope.md"), "--scored", str(scored)]) == 2
    sheet = _sheet(tmp_path, "| 1 | `positive:a` | q | g | c | CORRECT |\n")
    assert kappa.main(["--labels", str(sheet), "--scored", str(tmp_path / "nope.jsonl")]) == 2
    assert "judge-validate" in capsys.readouterr().err


@pytest.mark.parametrize(
    ("kappa_value", "expected"),
    [(0.9, "almost perfect"), (0.7, "substantial"), (0.5, "moderate"), (0.0, "poor / no better than chance")],
)
def test_bands_are_the_landis_koch_conventions(kappa_value: float, expected: str) -> None:
    assert kappa.band(kappa_value) == expected
