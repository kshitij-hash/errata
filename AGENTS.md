# AGENTS.md

Vocabulary (canonical, do not drift):
- Claim: one extracted assertion, append-only. Not a "fact".
- Belief: the claim currently accepted for (subject, attribute) - always derived, never stored.
- Revision edge: SUPERSEDES/CONTRADICTS from newer claim to the one it displaces. The edge IS the history.
- Abstention: calibrated "not in the history" + nearest-miss citations. A first-class answer.
- As-of: belief at time t via edge-time filter + deterministic fold in app code.

All build conventions and hard rules: see CLAUDE.md.
