//! The tools, one module per domain. [`DOMAINS`] fixes the catalog order an
//! MCP client sees (pinned by the tools/list snapshot).

use serde_json::{json, Value};

use super::registry::Domain;

mod app_context;
mod dictionary;
mod drafts;
mod folders;
mod live;
mod orgs;
mod recordings;
mod templates;

pub(super) const DOMAINS: &[Domain] = &[
    templates::DOMAIN,
    dictionary::DOMAIN,
    app_context::DOMAIN,
    live::DOMAIN,
    recordings::DOMAIN,
    folders::DOMAIN,
    orgs::DOMAIN,
    drafts::DOMAIN,
];

/// JSON-Schema for one TimelineEvent, shared by set_findings. Which fields apply
/// depends on the recording's meeting kind: a sales or negotiation finding is
/// laned by `side` (`me` = a problem/mistake by ME, `them` = a point/pressure the
/// other party raised), while an internal-meeting finding has no side and is
/// bucketed by `category` instead.
pub(super) fn finding_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": { "type": "string", "description": "Stable id; omit to mint a new one." },
            "atMs": { "type": "number", "description": "Moment on the recording timeline (ms)." },
            "side": { "type": "string", "enum": ["me", "them"], "description": "Lane: my problem vs their move. Omit for an internal meeting, which has no opposing side." },
            "category": { "type": "string", "enum": ["decision", "open", "fact"], "description": "Internal-meeting bucket: settled / still open / merely established. Omit when a side is set." },
            "severity": { "type": "string", "enum": ["info", "warn", "critical"] },
            "source": { "type": "string", "enum": ["eval", "extra"], "description": "From an eval, or an AI-caught extra moment." },
            "title": { "type": "string", "description": "Short label." },
            "detail": { "type": "string", "description": "One or two sentences explaining the moment." },
            "quotes": { "type": "array", "items": { "type": "string" }, "description": "Supporting verbatim quotes." },
            "evalIds": { "type": "array", "items": { "type": "string" }, "description": "Matching evaluation ids (for source=eval)." },
            "resolved": { "type": "boolean", "description": "True when ME later addressed/defused this moment." },
            "resolution": { "type": "string", "description": "One line on how ME handled it (only when resolved)." },
            "author": { "type": "string", "description": "Which analyst wrote this marker (e.g. 'claude'); omit for Parley's own pass." }
        },
        "required": ["atMs", "severity", "title", "detail"]
    })
}
