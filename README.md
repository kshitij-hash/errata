# Errata

Memory that keeps its corrections.

An agent-memory layer built on [HydraDB](https://github.com/hydra-db/hydradb) for Hack Hydra
(Track 3 - Memory & Context Retrieval). All work in this repository starts on or after
2026-08-12, per hackathon rules.

Status: backend complete — deterministic write path (ingest → belief graph on HydraDB) and the full
read surface (current belief, as-of, diff, cited answer, calibrated abstention) run end-to-end on
LongMemEval data. LLM extraction + conflict judge are wired behind the same interfaces, gated on
OpenRouter credits.
