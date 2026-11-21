#!/usr/bin/env python3
"""build_registry.py — WO-100/WO-105/WO-107 registry builder (batch A1).

Intake (owner workbook, machine-extracted; sha256-pinned by the controller):
    odai/dev_docs/registry_intake.json
Outputs (odai/config/, deterministic; re-run reproduces byte-identical files):
    business_agents.json     22 agent rows   + dev02 Table A verdicts + WO-101 CTRL shim module names
    skill_contracts.json     59 skill rows   + dev02 Table C coverage + WO-103 P0 module wiring
    specialist_roles.json    54 specialist rows + WO-107 dedup ledger (6 CTRL merges + 2 fix classifications + reuse verdicts)
    objectives_registry.json 100 objective rows + engine template fields (statement, generalized criterion
                             per WO-102 grammar: units / % / days / RM caps+counts / dates; gates mapped to scopes)
    task_graph.json          224 task nodes, topo-sorted, edges validated DAG BEFORE writing
    connectors_matrix.json   28 connector rows classified MOCK / PROVIDER_SANDBOX / BLOCKED (TBD -> BLOCKED;
                             SK-058 orphan disposition; WO-105)
    policy_index.json        16 PR+SEC rows with dev01 §5 dispositions
Governance: Rev 2.1 + DEV-01 registry validation + DEV-02 mapping evidence; registry is DATA —
no dispatcher/policy engine is created or modified here (G1-safe; WO-101 shims are module-name pointers).

Determinism contract: no timestamps, sorted keys, fixed separators, intake sha recorded from argv
(recomputed), UTF-8 with ensure_ascii; the file write is atomic and re-runs are asserted
hash-stable by the suite (tests/registry.test.mjs) and self-checked below.
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INTAKE = os.path.join(ROOT, "odai", "dev_docs", "registry_intake.json")
OUTDIR = os.path.join(ROOT, "odai", "config")
REGISTRY_VERSION = "business-plane-v2.1-a1"

# ---------------------------------------------------------------------------
# Governance tables — transcribed from DEV-02 mapping evidence (Rev 2.1) and
# DEV-01 registry validation. These are the reuse-disposition record (WO-107).
# ---------------------------------------------------------------------------

# dev02 Table A — 22 business agents -> verdict (+ dev01 §1 anchor when LIVE/PARTIAL).
# Row-by-row justifications are transcribed verbatim from the evidence file below.

TABLE_A_VERDICTS = [
    ("AG-01", "REGISTER", "Domain coordinator persona for \u201cStarting a business\u201d; no runtime equivalent \u2014 new odai dispatcher entry over 4 pooled specialists."),
    ("AG-02", "REGISTER", "Domain coordinator for product discovery; pool (Demand/Catalog/Supplier/Margin) exists only in registry, not in runtime."),
    ("AG-03", "REGISTER", "Domain coordinator for store setup; requires persona binding to Storefront/Checkout/QA specialists + Hashmeta route."),
    ("AG-04", "REGISTER", "Domain coordinator for advertising; persona new, though 2 pooled specialists reuse active skills (Table B)."),
    ("AG-05", "REGISTER", "Domain coordinator for lead generation; funnel/CRM capabilities are connector-bound and unbound today."),
    ("AG-06", "REGISTER", "Domain coordinator for service/selling; FAQ-RAG and escalation modules do not yet exist in engine."),
    ("AG-07", "REGISTER", "Domain coordinator for orders/dropshipping; supplier/logistics providers are TBD in sheet 06."),
    ("AG-08", "REGISTER", "Domain coordinator for money/cash-flow; ledger, margin, forecast modules must be built (DEV-03 work orders)."),
    ("AG-09", "REGISTER", "Domain coordinator for automation/growth; scheduler/tenant personas new, even though platform scheduler primitive exists."),
    ("AG-10", "REGISTER", "Domain coordinator for safety/approvals; persona must bind to existing control runtimes (CTRL-06/10/12) rather than DEV-08/12/13 (dev plane)."),
    ("CTRL-01", "REUSE", "Wraps existing Qwen voice runtime + media-read capability; register as thin persona only, no new engine work."),
    ("CTRL-02", "REUSE", "Maps to active translation skill + model-gateway language ID; colloquial/code-switch layer is params, not new code."),
    ("CTRL-03", "REGISTER", "Deterministic currency/budget/risk extraction with clarify-loop is new logic; no existing control persona covers it."),
    ("CTRL-04", "REUSE", "The objective->task engine already produces this (sheets 03/05, 224 rows, DAG-clean) \u2014 engine-native, params only."),
    ("CTRL-05", "REUSE", "odai dispatcher routing tables are exactly this control; register config entry, reuse dispatcher mechanism."),
    ("CTRL-06", "REUSE", "Deterministic allow/deny fail-closed runtime exists (permission/policy engine enforced by DEV-12-built runtime); persona binds it."),
    ("CTRL-07", "REUSE", "Platform dispatcher + session/scheduler runtime already provide durable intents, idempotency, outbox reconciliation."),
    ("CTRL-08", "REGISTER", "Cross-source claim/price verification with conflict detection is new deterministic logic \u2014 no engine equivalent in the 8 active skills."),
    ("CTRL-09", "REGISTER", "Money-first actual/forecast voice narration is a new persona template + contract validator; not present today."),
    ("CTRL-10", "REUSE", "Maps to existing SHIELD/monitoring runtime capability (named in DEV-12/DEV-13 agent defs as inspectable existing surface)."),
    ("CTRL-11", "REUSE", "Session, roles, tenant isolation and step-up auth are platform identity runtime; persona wraps existing checks."),
    ("CTRL-12", "REUSE", "Immutable audit-event trail pattern + stop/resume recovery exist in platform runtime."),
]

# dev01 §1 live-engine anchors used for the WO-101 CTRL shim module names.
CTRL_ANCHORS = {
    "CTRL-01": {"anchor": "DEV-07-SK-01/04 adapter contracts", "live": "none"},
    "CTRL-02": {"anchor": "DEV-07-SK-03; Planner.validate", "live": "server/odai/objectives.mjs#interpret (grammar-limited)"},
    "CTRL-03": {"anchor": "DEV-07-SK-03; B \u00a7budget", "live": "server/odai/registry.mjs#criterionFromText (WO-102 generalized: units/%/days/RM caps/counts/dates)"},
    "CTRL-04": {"anchor": "Planner.validate", "live": "server/odai/objectives.mjs#createObjective (generic) + registry.mjs#planFor (registry projection)"},
    "CTRL-05": {"anchor": "Registry.resolve", "live": "server/odai/registry.mjs#matchObjective (deterministic lexical+template scoring)"},
    "CTRL-06": {"anchor": "Policy.evaluate; DEV-08-SK-01", "live": "server/odai/policy.mjs + objectives.mjs GATES + workflow.decideSpend (3 live scopes)"},
    "CTRL-07": {"anchor": "Dispatcher.execute; DEV-08-SK-02", "live": "server/odai/workflow.mjs beats (no durable outbox yet)"},
    "CTRL-08": {"anchor": "Evidence.append; DEV-11", "live": "workflow beat-7 watch_verify + receipts projection"},
    "CTRL-09": {"anchor": "DEV-03-SK-05", "live": "workflow beat-10 final_report"},
    "CTRL-10": {"anchor": "Watcher.review; DEV-13", "live": "intent #10 shield engine; monitor module: tools/watchd.mjs (advisory-only)"},
    "CTRL-11": {"anchor": "DEV-09-SK-01", "live": "server/odai/store.mjs tenant-scoped keys (server-derived tenant)"},
    "CTRL-12": {"anchor": "DEV-03-SK-04; logEvent", "live": "objectives.mjs resume()/persist() (memory-authoritative; durable replay V33 slot)"},
}

# dev02 Table B — per-specialist verdict against the 8 installed active-skills roles.
# verdict: REUSE-AS-IS | MERGE | REGISTER-NEW ; matched: active skill(s) or None
TABLE_B_VERDICTS = {
    "Asset Manager": ("REGISTER-NEW", None, None),
    "Audience Researcher": ("REGISTER-NEW", None, "none (owner data-research not in active-skills)"),
    "Brand Setup Specialist": ("MERGE", "theme-factory", "fuzzy (visual identity only; naming/trademark uncovered)"),
    "Budget Planner": ("REGISTER-NEW", None, None),
    "Business Model Analyst": ("REGISTER-NEW", None, None),
    "CRM Follow-up Specialist": ("REGISTER-NEW", None, None),
    "Campaign Strategist": ("REGISTER-NEW", None, None),
    "Cashflow Forecaster": ("REGISTER-NEW", None, None),
    "Catalog Curator": ("REGISTER-NEW", None, None),
    "Channel Publisher": ("REGISTER-NEW", None, None),
    "Checkout Integrator": ("REGISTER-NEW", None, "woocommerce-code-review is dev-plane code review, not business checkout integration \u2014 plane boundary honored"),
    "Claims Reviewer": ("REGISTER-NEW", None, None),
    "Compliance Researcher": ("REGISTER-NEW", None, "owner deep-research not in active-skills"),
    "Consent Checker": ("REGISTER-NEW", None, None),
    "Content Planner": ("REGISTER-NEW", None, None),
    "Conversation Designer": ("MERGE", "ux-designer", "fuzzy (UX copy/flows overlap; objection-handling+SLA uncovered)"),
    "Conversion Analyst": ("MERGE", "landing-page-optimizer", "fuzzy (CRO/experiment plan covered; funnel analytics/GA feed uncovered)"),
    "Creative Generator": ("MERGE", "theme-factory", "fuzzy (styling/artifact theming only; image/video gen is connector-bound)"),
    "Demand Researcher": ("REGISTER-NEW", None, "owner market-research-reports not in active-skills"),
    "Escalation Agent": ("REGISTER-NEW", None, None),
    "Evidence Verifier": ("REGISTER-NEW", None, "control duty \u2014 superseded by CTRL-08 merge ledger (WO-107)"),
    "Experiment Analyst": ("MERGE", "landing-page-optimizer", "fuzzy (A/B plan guidance only; attribution engine uncovered)"),
    "FAQ Retrieval Agent": ("REGISTER-NEW", None, None),
    "Finance Ledger Agent": ("REGISTER-NEW", None, None),
    "Fulfillment Planner": ("REUSE-AS-IS", "network-optimization-modeler", "exact-intent (distribution network, facility/inventory positioning)"),
    "Funnel Builder": ("MERGE", "landing-page-optimizer", "fuzzy (hero/CTA/forms covered; lead-form CRM wiring uncovered)"),
    "Identity Agent": ("REGISTER-NEW", None, "control duty \u2014 superseded by CTRL-11 merge ledger (WO-107)"),
    "Inventory Validator": ("MERGE", "network-optimization-modeler", "fuzzy (inventory positioning covered; live stock/SKU checks connector-bound)"),
    "Localization Specialist": ("REUSE-AS-IS", "translation", "exact (cultural adaptation + terminology consistency in skill scope)"),
    "Margin Analyst": ("REGISTER-NEW", None, None),
    "Objective Planner": ("REGISTER-NEW", None, "agent-conductor is dev-plane only; planning stays engine-native (CTRL-04)"),
    "Optimization Agent": ("REGISTER-NEW", None, None),
    "Order Validator": ("REGISTER-NEW", None, None),
    "Payment Reconciler": ("REGISTER-NEW", None, None),
    "Policy Decision Agent": ("REGISTER-NEW", None, "control duty \u2014 superseded by CTRL-06 merge ledger (WO-107)"),
    "Promotion Planner": ("REGISTER-NEW", None, None),
    "Recovery & Audit Agent": ("REGISTER-NEW", None, "control duty \u2014 superseded by CTRL-12 merge ledger (WO-107)"),
    "Refund Case Agent": ("REGISTER-NEW", None, None),
    "Registration Advisor": ("REGISTER-NEW", None, None),
    "Report Narrator": ("REGISTER-NEW", None, "misclassified business row \u2014 CTRL-09 duty (WO-107 fix)"),
    "Scheduler Agent": ("REGISTER-NEW", None, None),
    "Shipping Rate Agent": ("REGISTER-NEW", None, None),
    "Shipping Tracker": ("REGISTER-NEW", None, None),
    "Site QA Tester": ("MERGE", "responsive-design + ux-designer", "fuzzy (responsive/accessibility review covered; functional test runner uncovered)"),
    "Specialist Router": ("REGISTER-NEW", None, "misclassified business row \u2014 CTRL-05 duty (WO-107 fix); agent-conductor dev-plane only"),
    "Spend Controller": ("REGISTER-NEW", None, "control duty \u2014 superseded by CTRL-06 merge ledger (WO-107)"),
    "Storefront Builder": ("MERGE", "responsive-design + ux-designer", "fuzzy (layout/IA covered; commerce CMS/PDP build uncovered, needs SK-058 Hashmeta)"),
    "Supplier Dispatcher": ("REGISTER-NEW", None, None),
    "Supplier Verification Specialist": ("REGISTER-NEW", None, None),
    "Tenant Onboarding Agent": ("REGISTER-NEW", None, None),
    "Threat Monitor": ("REGISTER-NEW", None, "control duty \u2014 superseded by CTRL-10 merge ledger (WO-107)"),
    "Translation Agent": ("REUSE-AS-IS", "translation", "exact match"),
    "Voice Telephony Agent": ("REGISTER-NEW", None, None),
    "Voice UX Guide": ("MERGE", "ux-designer", "fuzzy (dialogue/accessibility principles only; voice onboarding runtime uncovered)"),
}

# dev02 Table C — skill coverage verdicts (template-covered | needs-module | connector-bound).
_COV = {
    "SK-001": "connector-bound", "SK-002": "template-covered", "SK-003": "template-covered",
    "SK-004": "needs-module", "SK-005": "template-covered", "SK-006": "connector-bound",
    "SK-007": "connector-bound", "SK-008": "needs-module", "SK-009": "connector-bound",
    "SK-010": "connector-bound", "SK-011": "connector-bound", "SK-012": "needs-module",
    "SK-013": "template-covered", "SK-014": "needs-module", "SK-015": "template-covered",
    "SK-016": "template-covered", "SK-017": "connector-bound", "SK-018": "connector-bound",
    "SK-019": "template-covered", "SK-020": "needs-module", "SK-021": "needs-module",
    "SK-022": "connector-bound", "SK-023": "connector-bound", "SK-024": "connector-bound",
    "SK-025": "connector-bound", "SK-026": "connector-bound", "SK-027": "needs-module",
    "SK-028": "connector-bound", "SK-029": "template-covered", "SK-030": "needs-module",
    "SK-031": "template-covered", "SK-032": "needs-module", "SK-033": "connector-bound",
    "SK-034": "connector-bound", "SK-035": "needs-module", "SK-036": "template-covered",
    "SK-037": "needs-module", "SK-038": "connector-bound", "SK-039": "template-covered",
    "SK-040": "template-covered", "SK-041": "connector-bound", "SK-042": "connector-bound",
    "SK-043": "connector-bound", "SK-044": "needs-module", "SK-045": "template-covered",
    "SK-046": "needs-module", "SK-047": "connector-bound", "SK-048": "connector-bound",
    "SK-049": "template-covered", "SK-050": "needs-module", "SK-051": "needs-module",
    "SK-052": "template-covered", "SK-053": "connector-bound", "SK-054": "needs-module",
    "SK-055": "connector-bound", "SK-056": "connector-bound", "SK-057": "connector-bound",
    "SK-058": "connector-bound", "SK-059": "connector-bound",
}
# dev01 §3 buckets (B1 engine-covered | B2 needs odai skill-module | B3 connector-bound)
_B1 = {"SK-014", "SK-021", "SK-031", "SK-035", "SK-037", "SK-040", "SK-041", "SK-045", "SK-046"}
_B2 = {"SK-002", "SK-003", "SK-004", "SK-005", "SK-008", "SK-012", "SK-013", "SK-015", "SK-016",
       "SK-019", "SK-020", "SK-027", "SK-029", "SK-030", "SK-032", "SK-036", "SK-039", "SK-044",
       "SK-049", "SK-050", "SK-051", "SK-052"}
def dev01_bucket(sk):
    return "B1" if sk in _B1 else ("B2" if sk in _B2 else "B3")

# WO-101 CTRL shims — module-name pointers into the EXISTING engine (data only).
CTRL_SHIMS = {
    "CTRL-02": "server/odai/objectives.mjs#interpret",
    "CTRL-03": "server/odai/registry.mjs#criterionFromText",
    "CTRL-04": "server/odai/objectives.mjs#createObjective",
    "CTRL-05": "server/odai/registry.mjs#matchObjective",
    "CTRL-06": "server/odai/policy.mjs#evaluate",
    "CTRL-07": "server/odai/workflow.mjs#startRun",
    "CTRL-08": "server/odai/skills.mjs#skill_evidence_append",
    "CTRL-09": "server/odai/skills.mjs#skill_report_compose",
    "CTRL-10": "tools/watchd.mjs (advisory; dev-plane watchdog)",
    "CTRL-11": "server/odai/store.mjs#get",
    "CTRL-12": "server/odai/objectives.mjs#resume",
    "CTRL-01": "NOT_IMPLEMENTED (voice adapter \u2014 WO-106 pending)",
}

# WO-107 control-duty merge ledger: the 6 sheet-13 rows typed "Control specialist" bind
# canonically onto sheet-01 CTRL agents; no separate process (Rev 2.1 reuse rule:
# "role count != process count"). dev01 §2 records duties CTRL-04/06/07/08/11/12; name-based
# canonical binding below (Spend Controller shares the CTRL-06 gateway duty; Threat Monitor
# binds CTRL-10, the SHIELD monitor) — deviation disclosed in the run report.
CTRL_MERGES = {
    "Evidence Verifier": "CTRL-08",
    "Identity Agent": "CTRL-11",
    "Policy Decision Agent": "CTRL-06",
    "Recovery & Audit Agent": "CTRL-12",
    "Spend Controller": "CTRL-06",
    "Threat Monitor": "CTRL-10",
}

# WO-107 misclassification fixes (dev01 §2, WATCH-03 flag): sheet-13 type says
# "Business specialist" but the duty is control -> reclassified and merged, one canonical
# binding each.
CTRL_FIXES = {
    "Specialist Router": {"corrected_type": "Control", "merged_into": "CTRL-05"},
    "Report Narrator": {"corrected_type": "Control", "merged_into": "CTRL-09"},
}

# WO-102 gate registry — every distinct sheet-02 gate string mapped deterministically
# to engine scope(s). Scopes: spend | publish | comms | external_write (held-NEVER class
# under 9.0 connector readiness, enforced like publish) | review (advisory owner-review,
# no live dispatcher scope). Builder FAILS if the sheet union is not covered exactly.
GATE_SCOPES = {
    "Allowed actions only": ["review"],
    "Approval gates for external actions": ["external_write"],
    "Approval to publish": ["publish"],
    "Approve any proposed expenditure": ["spend"],
    "Approve experiment budget": ["spend"],
    "Approve publication": ["publish"],
    "Approve publishing": ["publish"],
    "Approved messages": ["comms"],
    "Bank access permission": ["spend"],
    "Block unknown stock": ["review"],
    "Booking approval": ["external_write"],
    "Cannot undo all remote effects": ["review"],
    "Change approvals": ["review"],
    "Channel approval": ["publish"],
    "Channel authorization": ["publish"],
    "Claims validation": ["review"],
    "Consent to contact": ["comms"],
    "Discount approval": ["spend"],
    "Dispatch authorization": ["external_write"],
    "Do not infer missing costs": ["review"],
    "Do not invent sales": ["review"],
    "Draft only": ["review"],
    "Escalate exceptions": ["review"],
    "Escalate medical queries": ["review"],
    "Forecast not promise": ["review"],
    "Fulfillment rights": ["external_write"],
    "Hard RM300 limit": ["spend"],
    "Human escalation": ["review"],
    "Image usage rights": ["review"],
    "Isolation required": ["review"],
    "Ledger evidence": ["review"],
    "Local compliance": ["review"],
    "Market eligibility": ["review"],
    "Market rules": ["review"],
    "Market-specific checks": ["review"],
    "Merchant credentials and approval": ["spend"],
    "Messaging approval": ["comms"],
    "Missing shelf life flagged": ["review"],
    "No blind cancellation": ["external_write"],
    "No clinical advice": ["review"],
    "No deceptive claims": ["review"],
    "No duplicate dispatch": ["external_write"],
    "No fabricated rates": ["review"],
    "No guaranteed sales": ["review"],
    "No guaranteed timing": ["review"],
    "No guessed wholesale prices": ["review"],
    "No invented orders": ["review"],
    "No paid spend": ["spend"],
    "No scraping private data": ["review"],
    "No spend": ["spend"],
    "No spend; review business options": ["spend"],
    "No unapproved spend": ["spend"],
    "No unsafe actions": ["review"],
    "No unsupported health claims": ["review"],
    "Owner approval": ["review"],
    "Owner approves brand": ["review"],
    "Owner decision": ["review"],
    "Owner selects product": ["review"],
    "Owner-set threshold": ["spend"],
    "Price change approval": ["review"],
    "Provider availability": ["review"],
    "Publish approval": ["publish"],
    "Publishing approval": ["publish"],
    "Quota and budget limits": ["spend"],
    "RM100 hard cap": ["spend"],
    "Refund approval": ["spend"],
    "Registration may require owner action": ["external_write"],
    "Resale eligibility": ["review"],
    "Resale rights required": ["review"],
    "Restore from verified record": ["review"],
    "Review regulatory constraints": ["review"],
    "Rights and claims review": ["review"],
    "Sandbox only": ["review"],
    "Security controls": ["review"],
    "Separate cash and profit": ["review"],
    "Source checks": ["review"],
    "Source-grounded": ["review"],
    "Spend and publishing approval": ["spend", "publish"],
    "Spend approval": ["spend"],
    "Step-up authentication": ["spend"],
    "Stop and reconciliation": ["spend"],
    "Supplier authorization required": ["external_write"],
    "Supplier contract": ["external_write"],
    "Tenant and consent controls": ["review"],
    "Unknown costs must remain unknown": ["review"],
    "Unknowns flagged": ["review"],
    "Usage quota approval": ["spend"],
    "Use actual analytics": ["review"],
    "Verified actuals": ["review"],
    "Verified cost inputs": ["review"],
    "Verified tracking": ["review"],
    "Verified transactions": ["review"],
    "Verify accuracy": ["review"],
    "Verify independently": ["review"],
    "Voice capability verification": ["review"],
    "Within entitlements": ["spend"],
}

# WO-105 connector classification rules (deterministic, evaluated in order):
#   1 provider 'Not established'/TBD/MISSING            -> BLOCKED
#   2 CON-* rows (verification mentions BLOCKED; external writes/dispatch) -> BLOCKED
#   3 internal persistence or mirror-only utilities     -> MOCK
#   4 named external provider, unverified               -> PROVIDER_SANDBOX
CONNECTOR_DISPOSITION_SK058 = {
    "skill_id": "SK-058",
    "finding": "referenced by 0 of 224 tasks (DEV-01 G-c orphan)",
    "disposition": "CONTRACT_ONLY_ROLLED_UP_INTO_SK-047",
    "note": "Hashmeta website execution stays bound to SK-047 storefront_builder via CON-HASH-WEB (BLOCKED); SK-058 keeps its contract row for audit but must not gain task edges without a new owner work order.",
}

# dev01 §5 — privacy/security dispositions (REPO = repo-enforceable deterministic check;
# OWNER = owner sign-off / protected-admin bootstrap; COVERED = sealed by Rev 2.1 guardrail
# contracts; verify-at-G1 still required).
POLICY_DISPOSITIONS = {
    "PR-01": ("COVERED + REPO test", "GUARD-05; DEV-05-SK-02 RLS; SEC-24 negative suite"),
    "PR-02": ("REPO", "DEV-12-SK-04 secret-data scan; DEV-07-SK-05 log redaction"),
    "PR-03": ("OWNER (+GUARD-03)", "G1 bootstrap: broker/credential provisioning by protected admin; repo can only test absence"),
    "PR-04": ("COVERED", "Rev 2.1 mandates synthetic fixtures; dataset approval = owner (F before-writes)"),
    "PR-05": ("REPO + OWNER", "GUARD-04 DLP egress allowlist in code; per-provider approval matrix owner-signed"),
    "PR-06": ("REPO + OWNER", "DEV-05-SK-05 lifecycle jobs; processor/backup obligations = owner/vendor sign-off"),
    "PR-07": ("OWNER", "Platform/infra evidence (transit/storage), not repo code; config assertion in CI"),
    "SEC-01": ("COVERED + REPO", "DEV-13-SK-01; heartbeat wiring not live -> test in WO-108"),
    "SEC-02": ("COVERED + PARTIAL LIVE", "DEV-12-SK-01 preflight; engine beat gates exist; dispatch-time re-check missing -> REPO test"),
    "SEC-03": ("REPO", "DEV-13-SK-03 + GUARD-04; fixture suite"),
    "SEC-04": ("OWNER", "Requires control-service/protected runtime (G1); repo side = DEV-08-SK-04 quarantine states"),
    "SEC-05": ("REPO + OWNER", "DEV-03-SK-04 + DEV-10-SK-04 drill; recovery targets owner-approved"),
    "SEC-06": ("COVERED", "Evidence.append + append-only store outside agent write scope; store isolation = G1/owner"),
    "SEC-07": ("REPO (+GUARD-06 budget)", "DEV-12-SK-06; live cap primitive exists but reservation not atomic -> code item"),
    "SEC-08": ("OWNER + CONFIG", "Separate credentials/scopes issued at bootstrap; repo test = cross-plane use denial (SEC-21)"),
    "SEC-09": ("COVERED + REPO", "DEV-13 advisory-only property already in contract; schedule wiring = config item"),
}

# WO-103 — first 6 P0 skill modules (family names from the work order; deterministic
# pure functions living in server/odai/skills.mjs, contracts sourced from sheet-04).
# WO-113 tranche 2 batch 1 appends the 4 highest-reference t1-core modules.
P0_MODULES = {
    "SK-024": {"module": "skill_ledger_append", "family": "ledger-append", "wo": "WO-103"},
    "SK-009": {"module": "skill_catalog_query", "family": "catalog-query", "wo": "WO-103"},
    "SK-021": {"module": "skill_evidence_append", "family": "evidence-append", "wo": "WO-103"},
    "SK-035": {"module": "skill_gate_check", "family": "gate-check", "wo": "WO-103"},
    "SK-041": {"module": "skill_schedule_scaffold", "family": "schedule-scaffold", "wo": "WO-103"},
    "SK-040": {"module": "skill_report_compose", "family": "report-compose", "wo": "WO-103"},
    "SK-055": {"module": "skill_poster_social_create", "family": "poster-social-creator", "wo": "WO-113"},
    "SK-018": {"module": "skill_creative_generate", "family": "creative-generator", "wo": "WO-113"},
    "SK-030": {"module": "skill_margin_analyze", "family": "margin-analyst", "wo": "WO-113"},
    "SK-047": {"module": "skill_storefront_build", "family": "storefront-builder", "wo": "WO-113"},
    "SK-012": {"module": "skill_claims_review", "family": "claims-reviewer", "wo": "WO-113"},
    "SK-013": {"module": "skill_compliance_research", "family": "compliance-researcher", "wo": "WO-113"},
    "SK-026": {"module": "skill_funnel_build", "family": "funnel-builder", "wo": "WO-113"},
    "SK-046": {"module": "skill_spend_control", "family": "spend-controller", "wo": "WO-113"},
    "SK-049": {"module": "skill_supplier_verify", "family": "supplier-verification", "wo": "WO-113"},
    "SK-002": {"module": "skill_audience_research", "family": "audience-researcher", "wo": "WO-113"},
    "SK-005": {"module": "skill_business_model_analyze", "family": "business-model-analyst", "wo": "WO-113"},
    "SK-007": {"module": "skill_campaign_design", "family": "campaign-strategist", "wo": "WO-113"},
}

# ---------------------------------------------------------------------------
# WO-102 generalized criterion grammar — Python mirror of the server
# implementation in server/odai/registry.mjs (tests assert parity on fixtures).
# ---------------------------------------------------------------------------

def _num(s):
    return int(s.replace(",", ""))


def criterion_from_text(text):
    """Deterministic grammar generalized per WO-102: units / % over days (legacy
    engine grammars FIRST, unchanged), then RM caps, RM revenue targets, generic
    counts, and date deadlines. Returns None when nothing matches."""
    t = str(text or "").replace("\u2019", "'")
    m = re.search(r"(\d+)(?:\s+\w+){0,4}\s*(?:units?|products?|pieces?|pcs)", t, re.I)
    if m:
        return {"kind": "units_sold", "target_units": _num(m.group(1))}
    m = re.search(r"(\d+)\s*%", t)
    d = re.search(r"(\d+)\s*(?:days?|hours?)", t, re.I)
    if m and d:
        return {"kind": "growth", "pct": _num(m.group(1)), "days": _num(d.group(1))}
    m = re.search(r"(?:no|not|don'?t|never)\s+more\s+than\s+RM\s?([\d,]+)", t, re.I)
    if not m:
        m = re.search(r"RM\s?([\d,]+)\s*(?:hard\s*)?(?:cap|limit)", t, re.I)
    if not m:
        m = re.search(r"(?:budget|spend|cost)s?\b[^.?]{0,24}?\bRM\s?([\d,]+)", t, re.I)
    if m:
        return {"kind": "money_cap_myr", "cap_myr": _num(m.group(1))}
    m = re.search(r"(?:earn|make|generate|revenue of?)\s+(?:me\s+)?RM\s?([\d,]+)", t, re.I)
    if m:
        return {"kind": "revenue_target_myr", "target_myr": _num(m.group(1))}
    generic_count = not re.search(r"cap|limit", t, re.I)
    m = re.search(r"RM\s?([\d,]+)", t, re.I)
    if m and generic_count:
        return {"kind": "money_amount_myr", "amount_myr": _num(m.group(1))}
    m = re.search(r"(\d+)\s+((?:new\s+)?(?:customers?|orders?|leads?|followers?|subscribers?|reviews?|replies?|tickets?|abandoned carts?))", t, re.I)
    if m:
        return {"kind": "count_target", "target": _num(m.group(1)), "metric": re.sub(r"\s+", "_", m.group(2).lower().rstrip("s"))}
    m = re.search(r"by\s+(?:the\s+)?(?:end\s+of\s+)?(this\s+week|this\s+month|this\s+quarter|this\s+year|next\s+week|next\s+month|next\s+year|(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", t, re.I)
    if m:
        return {"kind": "deadline", "until": re.sub(r"\s+", " ", m.group(1)).lower()}
    return None


# ---------------------------------------------------------------------------
# Loading + helpers
# ---------------------------------------------------------------------------

def load_intake():
    raw = open(INTAKE, "rb").read()
    d = json.loads(raw.decode("utf-8"))
    counts = {
        "01_Business_Agents": 22, "02_Objectives": 100, "03_Objective_Task_Mapping": 224,
        "04_Business_Skills": 59, "05_Agent_Assignment": 224, "06_API_Connectors": 28,
        "07_Data_Privacy": 7, "08_Security_Policies": 9, "09_Acceptance_Tests": 100,
        "10_Dependencies": 224, "11_Source_Notes": 11, "12_Marketing_Overlays": 10,
        "13_Specialist_Roles": 54,
    }
    for sheet, n in counts.items():
        got = len(d[sheet])
        assert got == n, "intake shape drift: %s has %d rows, expected %d — STOP (refuse to rebuild)" % (sheet, got, n)
    return hashlib.sha256(raw).hexdigest(), d


def split_list(s):
    parts = re.split(r"[;,]", str(s or ""))
    return [p.strip() for p in parts if p.strip()]


def json_bytes(obj):
    return (json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


# ---------------------------------------------------------------------------
# Emitters
# ---------------------------------------------------------------------------

def envelope(name, rows, sha, extra=None):
    body = {"registry_version": REGISTRY_VERSION, "generated_from": "odai/dev_docs/registry_intake.json",
            "intake_sha256": sha, "row_count": len(rows)}
    if extra:
        body.update(extra)
    body["rows"] = rows
    return body


def build_agents(d, sha):
    ta = {i: (v, j) for i, v, j in TABLE_A_VERDICTS}
    rows = []
    for r in d["01_Business_Agents"]:
        aid = r["agent_id"]
        verdict, just = ta[aid]
        row = {
            "agent_id": aid, "agent_name": r["agent_name"], "domain": r["domain"],
            "role_description": r["vivid_agent_role_description"],
            "subagent_pool": split_list(r["subagent_pool"]), "required_skills": r["required_skills"],
            "output_contract": r["output_contract"], "success_oracle": r["success_oracle"], "kpi": r["kpi"],
            "authority_boundary": r["authority_boundary"], "deployment_state": r["deployment_state"],
            "record_type": r["record_type"], "source": r["source"],
            "plane": "business-runtime",
            "reuse_verdict_dev02": verdict, "justification": just, "new_process_created": False,
        }
        if aid.startswith("CTRL-"):
            row["shim"] = {"module_name": CTRL_SHIMS[aid], "rev21_anchor": CTRL_ANCHORS[aid]["anchor"],
                            "live_engine_path": CTRL_ANCHORS[aid]["live"], "separate_process": False}
        rows.append(row)
    assert len(rows) == 22
    return envelope("business_agents", rows, sha, {
        "verdict_totals_dev02_rowwise": {"REUSE": sum(1 for x in rows if x["reuse_verdict_dev02"] == "REUSE"),
                                          "REGISTER": sum(1 for x in rows if x["reuse_verdict_dev02"] == "REGISTER")},
        "dev02_note_discrepancy": "DEV-02 prose totals (REUSE 12 / REGISTER 10) conflict with the row-by-row Table A (13 REGISTER / 9 REUSE); row-by-row verdicts are authoritative here and the discrepancy is disclosed in the WO-A1 run report.",
    })


def build_skills(d, sha):
    refcount = {}
    for t in d["03_Objective_Task_Mapping"]:
        refcount[t["skill_id"]] = refcount.get(t["skill_id"], 0) + 1
    rows = []
    for r in d["04_Business_Skills"]:
        sid = r["skill_id"]
        row = {
            "skill_id": sid, "skill_key": r["skill_key"], "display_name": r["display_name"],
            "version": r["version"], "kind": r["kind"], "description": r["vivid_skill_description_-_build_"],
            "keywords": split_list(r["skill_keywords_from_source"]),
            "required_input_fields": split_list(r["required_input_fields"]),
            "required_output_fields": split_list(r["required_output_fields"]),
            "execution_steps": r["execution_steps"], "error_and_recovery": r["error_and_recovery"],
            "allowed_capabilities": r["allowed_capabilities"], "prohibited_actions": r["prohibited_actions"],
            "acceptance_tests": r["acceptance_tests"], "suggested_module": r["suggested_module"],
            "deployment_state": r["deployment_state"], "use_case_count": r["use_case_count"],
            "security_controls": r["security_controls"], "reuse_decision_source": r["reuse_decision"],
            "canonical_owner": r["canonical_owner"], "connector_candidate": r["connector_candidate"],
            "boundary": r["boundary"], "verification": r["verification"],
            "coverage_dev02": _COV[sid], "dev01_bucket": dev01_bucket(sid),
            "task_reference_count": refcount.get(sid, 0),
        }
        if sid in P0_MODULES:
            row["implementation"] = {"status": "IMPLEMENTED_P0", "module": "server/odai/skills.mjs",
                                     "function": P0_MODULES[sid]["module"], "family": P0_MODULES[sid]["family"],
                                     "work_order": P0_MODULES[sid]["wo"]}
        else:
            row["implementation"] = {"status": "NOT_IMPLEMENTED", "module": None, "function": None}
        if sid == "SK-058":
            row["orphan_disposition"] = CONNECTOR_DISPOSITION_SK058
        rows.append(row)
    assert len(rows) == 59
    return envelope("skill_contracts", rows, sha, {
        "coverage_totals_dev02": {k: sum(1 for x in rows if x["coverage_dev02"] == k)
                                  for k in ("template-covered", "needs-module", "connector-bound")},
        "p0_modules_implemented": sorted(P0_MODULES),
    })


def build_specialists(d, sha):
    rows = []
    for r in d["13_Specialist_Roles"]:
        name = r["subagent"]
        verdict, matched, quality = TABLE_B_VERDICTS[name]
        is_control_row = str(r["type"]).strip().lower() == "control specialist"
        final_type = "Control" if (is_control_row or name in CTRL_FIXES) else "Business"
        merged_into = CTRL_MERGES.get(name) or (CTRL_FIXES.get(name) or {}).get("merged_into")
        final_verdict = "MERGED-INTO-CTRL" if merged_into else verdict
        row = {
            "specialist": name, "sheet_type_source": r["type"], "type_final": final_type,
            "required_skills": split_list(r["required_skills"]),
            "use_case_references_count": int(str(r["use_case_references_count"])),
            "mandatory_controls": r["mandatory_controls"],
            "reuse_verdict_tableB": verdict,
            "active_skill_match": matched, "match_quality": quality or "",
            "reuse_verdict_final": final_verdict,
            "canonical_agent_binding": merged_into, "separate_process": merged_into is None,
            "classification_fix": name in CTRL_FIXES,
        }
        rows.append(row)
    assert len(rows) == 54
    ledger = {
        "wo107_control_merges": {k: v for k, v in sorted(CTRL_MERGES.items())},
        "wo107_misclassification_fixes": {k: v for k, v in sorted(CTRL_FIXES.items())},
        "populations_are_three_disjoint": {
            "registry_specialists": 54, "installed_active_skills": 8, "rev21_dev_specialists": 32,
            "note": "dev01 §2 — neither superset nor subset; dev-plane agent-conductor/woocommerce-code-review correctly excluded from business reuse.",
        },
        "absent_owner_skill_references": sorted(["data-research", "business-development", "content-strategy", "deep-research",
                                                  "market-research-reports", "copywriting", "domain-name-brainstormer", "content-creator-pro"]),
        "final_totals": {k: sum(1 for x in rows if x["reuse_verdict_final"] == k)
                         for k in ("REUSE-AS-IS", "MERGE", "REGISTER-NEW", "MERGED-INTO-CTRL")},
    }
    return envelope("specialist_roles", rows, sha, {"dedup_ledger": ledger})


def build_task_graph(d, sha):
    by_obj = {}
    for t in d["03_Objective_Task_Mapping"]:
        by_obj.setdefault(t["objective_id"], []).append(t)
    rows = []
    for oid in sorted(by_obj):
        nodes = sorted(by_obj[oid], key=lambda x: (int(x["step"]), x["task_id"]))
        steps = [int(x["step"]) for x in nodes]
        assert steps == list(range(1, len(nodes) + 1)), "step contiguity broken for " + oid
        ids = [x["task_id"] for x in nodes]
        pos = {tid: i for i, tid in enumerate(ids)}
        for x in nodes:
            preds = [x["predecessor_id"]] if x["predecessor_id"] else []
            for p in preds:
                assert p in pos, "edge outside objective: %s -> %s" % (x["task_id"], p)
                assert pos[p] < pos[x["task_id"]], "edge not forward-stepped: %s" % x["task_id"]
            rows.append({
                "task_id": x["task_id"], "objective_id": oid, "step": int(x["step"]),
                "skill_id": x["skill_id"], "agent_id": x["agent_id"], "specialist": x["specialist"],
                "canonical_owner": x["canonical_owner"], "inputs": split_list(x["inputs"]),
                "outputs": split_list(x["outputs"]), "connector_candidate": x["connector_candidate"],
                "depends_on": sorted(preds), "dependency_note": x["dependency_note"], "status": x["status"],
            })
    # Global DAG validation (Kahn) BEFORE writing — dev01 G-a contract.
    indeg = {r["task_id"]: len(r["depends_on"]) for r in rows}
    children = {r["task_id"]: [] for r in rows}
    for r in rows:
        for p in r["depends_on"]:
            children[p].append(r["task_id"])
    queue = sorted([t for t, i in indeg.items() if i == 0])
    order = []
    while queue:
        n = queue.pop(0)
        order.append(n)
        for c in sorted(children[n]):
            indeg[c] -= 1
            if indeg[c] == 0:
                queue.append(c)
        queue.sort()
    assert len(order) == 224, "DAG validation failed: acyclic order %d != 224" % len(order)
    assert len(rows) == 224
    # rows are already topologically ordered (step-contiguous per objective, edges forward)
    return envelope("task_graph", rows, sha, {
        "topo_ok": True, "nodes": 224, "edges": sum(len(r["depends_on"]) for r in rows),
        "ordering": "per-objective step-contiguous; global Kahn acyclic (mirrors reg_validation.json: cyclic=false)",
    })


def gate_lookup(sheet_string):
    if sheet_string in GATE_SCOPES:
        return GATE_SCOPES[sheet_string]
    folded = sheet_string.replace("\u2019", "'")
    if folded in GATE_SCOPES:
        return GATE_SCOPES[folded]
    raise KeyError("unmapped gate string: " + sheet_string)


def build_objectives(d, sha, graph_rows):
    at = {r["objective_id"]: r for r in d["09_Acceptance_Tests"]}
    ov = {}
    for r in d["12_Marketing_Overlays"]:
        ov.setdefault(r["objective_id"], []).append(r)
    tasks = {}
    for g in graph_rows:
        tasks.setdefault(g["objective_id"], []).append(g)
    rows = []
    observed_gates = set()
    for r in d["02_Objectives"]:
        oid = r["objective_id"]
        gate_str = str(r["financial_/_safety_gate"]).strip()
        observed_gates.add(gate_str)
        scopes = gate_lookup(gate_str)
        crit = criterion_from_text(r["owner_statement"])
        crit_src = "owner_statement"
        if crit is None:
            crit = criterion_from_text(r["expected_result"])
            crit_src = "expected_result" if crit else "none"
        gates = []
        for sc in scopes:
            gates.append({"sheet_string": gate_str, "scope": sc,
                          "engine_gate_id": {"spend": "approve_spend", "publish": "approve_publish",
                                             "comms": "approve_customer_comms",
                                             "external_write": "approve_external_action",
                                             "review": "owner_review"}[sc],
                          "held_never_connector_readiness": sc in ("publish", "comms", "external_write")})
        acc = at.get(oid, {})
        rows.append({
            "objective_id": oid, "business_family": r["business_family"],
            "statement": r["owner_statement"], "agent_id": r["agent_id"], "lead_agent": r["lead_agent"],
            "expected_result": r["expected_result"],
            "gate": {"sheet_string": gate_str, "scopes": scopes},
            "gates_mapped": gates,
            "criterion_spec": {"spec": crit, "grammar_source": crit_src, "generalized_via": "WO-102"},
            "measurable_via": "criterion-grammar" if crit else "registry-acceptance-test",
            "owner_summary": r["owner_summary"], "inputs_required": split_list(r["inputs_required"]),
            "priority": r["priority"], "status": r["status"], "source": r["source"],
            "tasks": [t["task_id"] for t in tasks.get(oid, [])],
            "acceptance": {"test_id": acc.get("test_id"), "success_oracle": acc.get("success_oracle"),
                            "money_view": acc.get("money_view"), "approval_boundary": acc.get("approval_boundary"),
                            "failure_test": acc.get("security_/_failure_test"), "data_mode": acc.get("data_mode")},
            "marketing_overlay": ({"workflow": ov[oid][0].get("workflow"), "connector": ov[oid][0].get("connector"),
                                    "expected_result": ov[oid][0].get("expected_result"),
                                    "gate_note": ov[oid][0].get("gate")} if oid in ov else None),
        })
    missing = sorted(k for k in GATE_SCOPES if k not in observed_gates)
    assert not missing, "GATE_SCOPES has stale keys not present in sheet-02: %s" % missing
    assert len(rows) == 100
    stats = {"distinct_gate_strings": len(observed_gates),
             "scope_totals": {}}
    for sc in set(sum([gate_lookup(g) for g in observed_gates], [])):
        stats["scope_totals"][sc] = sum(1 for g in observed_gates if sc in gate_lookup(g))
    return envelope("objectives_registry", rows, sha, {"gate_registry_stats": stats})


def build_connectors(d, sha):
    rows = []
    for r in d["06_API_Connectors"]:
        cid = r["connector_id"]
        blob = " ".join(str(r.get(k) or "") for k in ("provider", "purpose_/_evidence", "restriction_/_approval",
                                                       "integration", "configuration", "execution_contract",
                                                       "verification_status"))
        if re.search(r"not established|\bTBD\b|MISSING", blob, re.I) or str(r.get("provider")) == "Not established":
            cls, rule = "BLOCKED", "rule1 provider-not-established/TBD"
        elif cid.startswith("CON-"):
            cls, rule = "BLOCKED", "rule2 CON-* external write/activation — NEVER while connector readiness disabled (9.0)"
        elif str(r.get("provider")) == "Supabase" or re.search(r"mirror only", str(r.get("restriction_/_approval") or ""), re.I):
            cls, rule = "MOCK", "rule3 internal persistence / mirror-only utility — engine-safe simulated surface"
        else:
            cls, rule = "PROVIDER_SANDBOX", "rule4 named external provider, verification pending (DEV-06-SK-01)"
        row = {"connector_id": cid, "provider": r["provider"], "purpose": r["purpose_/_evidence"],
               "owner_skills": str(r.get("owner_/_skill_ids")), "integration": r["integration"],
               "configuration": r["configuration"], "execution_contract": r["execution_contract"],
               "restriction_approval": r["restriction_/_approval"], "verification_status": r["verification_status"],
               "source": r["source"], "classification": cls, "classification_rule": rule}
        if cid == "CAT-20":
            row["note"] = "SK-058 orphan execution rolled up into SK-047 storefront_builder (see skill_dispositions)"
        rows.append(row)
    assert len(rows) == 28
    counts = {k: sum(1 for x in rows if x["classification"] == k) for k in ("MOCK", "PROVIDER_SANDBOX", "BLOCKED")}
    return envelope("connectors_matrix", rows, sha, {
        "classification_totals": counts,
        "skill_dispositions": [CONNECTOR_DISPOSITION_SK058],
    })


def build_policies(d, sha):
    rows = []
    for r in d["07_Data_Privacy"]:
        disp, anchor = POLICY_DISPOSITIONS[r["policy_id"]]
        rows.append({"policy_id": r["policy_id"], "class": "PR", "source_sheet": "07_Data_Privacy",
                     "control": r["proposed_control"], "data_class": r["data_class"],
                     "acceptance_test": r["acceptance_test"], "status_source": r["status"],
                     "disposition_dev01": disp, "enforcement_anchor": anchor})
    for r in d["08_Security_Policies"]:
        disp, anchor = POLICY_DISPOSITIONS[r["policy_id"]]
        rows.append({"policy_id": r["policy_id"], "class": "SEC", "source_sheet": "08_Security_Policies",
                     "control": r["control"], "data_class": None,
                     "acceptance_test": "See DEV-01 §5 enforcement anchor (WO-108 negative tests)",
                     "status_source": r["status"], "disposition_dev01": disp, "enforcement_anchor": anchor})
    assert len(rows) == 16
    return envelope("policy_index", rows, sha, {
        "disposition_totals": {k: sum(1 for x in rows if k in x["disposition_dev01"])
                               for k in ("REPO", "OWNER", "COVERED")},
    })


def write_file(name, obj):
    data = json_bytes(obj)
    target = os.path.join(OUTDIR, name)
    tmp = target + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, target)
    return hashlib.sha256(data).hexdigest()


def main():
    check = "--check" in sys.argv[1:]  # re-run drift detection (used by tests/registry.test.mjs)
    sha, d = load_intake()
    graph = build_task_graph(d, sha)
    files = [
        ("business_agents.json", build_agents(d, sha)),
        ("specialist_roles.json", build_specialists(d, sha)),
        ("skill_contracts.json", build_skills(d, sha)),
        ("objectives_registry.json", build_objectives(d, sha, graph["rows"])),
        ("task_graph.json", graph),
        ("connectors_matrix.json", build_connectors(d, sha)),
        ("policy_index.json", build_policies(d, sha)),
    ]
    drift = []
    for name, obj in files:
        digest = write_file(name, obj) if not check else None
        path = os.path.join(OUTDIR, name)
        current = hashlib.sha256(open(path, "rb").read()).hexdigest()
        if check:
            recomputed = hashlib.sha256(json_bytes(obj)).hexdigest()
            if recomputed != current:
                drift.append(name)
        print("%-26s rows=%-4s sha256=%s" % (name, obj["row_count"], current[:16]))
    if check:
        print("HASH-STABLE re-run verified" if not drift else "DRIFT DETECTED: " + ", ".join(drift))
        sys.exit(1 if drift else 0)
    # second-pass determinism proof (cheap, self-checking): re-serialize in memory and compare
    for name, obj in files:
        path = os.path.join(OUTDIR, name)
        assert hashlib.sha256(json_bytes(obj)).hexdigest() == hashlib.sha256(open(path, "rb").read()).hexdigest()
    print("BUILD_OK intake_sha256=" + sha)


if __name__ == "__main__":
    main()
