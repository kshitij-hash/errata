"""Pinned prompts and their sha256 fingerprints.

The ANSWER_PROMPT is the shared answer prompt held byte-identical across all three arms.
Its sha256 is asserted against the deployed API's ``/api/meta.answer_prompt_sha256`` by the
parity gate before any spend (see ``cli.py::check_parity``) — that is how "prompt parity is
rule #1" becomes enforceable rather than aspirational. The string below is vendored verbatim;
the parity gate, not this file, is the authority on whether it matches the deployed answer path.

The JUDGE_PROMPT contains a literal JSON example with ``{`` / ``}`` braces, so it MUST NOT be
filled with ``str.format``; use ``fill_judge_prompt`` / plain ``.replace`` on the named slots.
"""

from __future__ import annotations

import hashlib

# The machine-detectable abstention marker shared by the full-context and naive arms.
INSUFFICIENT_MARKER = "INSUFFICIENT_INFORMATION"


def sha256(text: str) -> str:
    """Hex sha256 of a prompt string (utf-8)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --- The shared answer prompt (this exact string is hashed for the parity gate) ---------------
ANSWER_PROMPT = (
    "You are answering a question about a user's own chat history with an assistant.\n"
    "\n"
    "Today's date is {question_date}.\n"
    "\n"
    "Use ONLY the material provided below. Do not use outside knowledge. Do not guess.\n"
    "\n"
    "If the material does not contain the information needed to answer, your entire reply must be\n"
    "exactly:\n"
    "INSUFFICIENT_INFORMATION: <one sentence naming the closest related thing the history does mention>\n"
    "\n"
    "Otherwise reply with the answer only — no preamble, no restatement of the question, no citations,\n"
    "no explanation. Be specific: give names, dates, and numbers exactly as the material states them.\n"
    "If the material states a fact and later states a different value for the same fact, answer with\n"
    "the LATER value.\n"
    "\n"
    "--- MATERIAL ---\n"
    "{context}\n"
    "--- END MATERIAL ---\n"
    "\n"
    "Question: {question}\n"
    "Answer:"
)

# --- The judge prompt (pinned and hashed) -----------------------------------------------------
JUDGE_PROMPT = (
    "You decide whether a candidate answer is correct, given the reference answer.\n"
    "\n"
    "Question: {question}\n"
    "Reference answer (ground truth): {gold_answer}\n"
    "Candidate answer: {candidate_answer}\n"
    "\n"
    "Decide in this order:\n"
    "1. Identify the specific facts the reference answer asserts — names, dates, quantities, entities.\n"
    "2. Check whether the candidate asserts the SAME facts.\n"
    "\n"
    "Mark CORRECT only if the candidate states every fact the reference states, with the same values.\n"
    "Paraphrase, different wording, different order, and extra correct detail are all fine.\n"
    "\n"
    "Mark INCORRECT if any of the following is true:\n"
    "- the candidate names a different entity, person, place, date, quantity or value\n"
    "- the candidate is about the right topic but does not actually contain the reference fact\n"
    "- the candidate is vague, hedged, or generic where the reference is specific\n"
    "- the candidate gives an earlier value for a fact the reference states was later changed\n"
    "- the candidate declines to answer\n"
    "\n"
    "Being on the right topic is not being correct. When you are unsure, answer INCORRECT.\n"
    "\n"
    "Reply with JSON only:\n"
    '{"verdict": "CORRECT" | "INCORRECT", "reason": "<12 words max>"}'
)

# --- The perturber prompt (builds the judge control set) --------------------------------------
PERTURB_PROMPT = (
    "You are helping build a control set to test an answer-grading judge.\n"
    "\n"
    "Question: {question}\n"
    "Reference answer: {gold_answer}\n"
    "\n"
    "Task: {instruction}\n"
    "\n"
    "Rules:\n"
    "- Change ONLY what the task says to change; keep everything else identical in meaning.\n"
    "- Stay on the same topic and keep the answer fluent and plausible.\n"
    "- Output the rewritten answer only. No preamble, no explanation, no quotation marks.\n"
)

ANSWER_PROMPT_SHA256 = sha256(ANSWER_PROMPT)
JUDGE_PROMPT_SHA256 = sha256(JUDGE_PROMPT)
PERTURB_PROMPT_SHA256 = sha256(PERTURB_PROMPT)


def fill_answer_prompt(*, question_date: str, context: str, question: str) -> str:
    """Fill the answer prompt. Safe: ANSWER_PROMPT has no stray literal braces."""
    return ANSWER_PROMPT.format(
        question_date=question_date, context=context, question=question
    )


def fill_judge_prompt(*, question: str, gold_answer: str, candidate_answer: str) -> str:
    """Fill the judge prompt WITHOUT str.format (it contains literal JSON braces)."""
    return (
        JUDGE_PROMPT.replace("{question}", question)
        .replace("{gold_answer}", gold_answer)
        .replace("{candidate_answer}", candidate_answer)
    )


def fill_perturb_prompt(*, question: str, gold_answer: str, instruction: str) -> str:
    return (
        PERTURB_PROMPT.replace("{question}", question)
        .replace("{gold_answer}", gold_answer)
        .replace("{instruction}", instruction)
    )
