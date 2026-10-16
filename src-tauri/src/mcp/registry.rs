//! The tool catalog (`tools/list`) and the name → handler table that
//! `tools/call` dispatches through. Each domain module under `tools` lists its
//! own schemas and handlers; this file only puts them together.

use serde_json::{json, Value};

use super::bridge::call_frontend;
use super::context::{required_str, McpContext};
use super::tools::DOMAINS;

/// How a tool is answered.
pub(super) enum Handler {
    /// Here, from the files the server shares with the app.
    Local(fn(&McpContext, Value) -> anyhow::Result<Value>),
    /// By the frontend: an RPC named after the tool, carrying these
    /// arguments, checked and copied in this order.
    Forward(&'static [Field]),
    /// By the frontend, with the RPC arguments this builds from the tool's.
    ForwardWith(fn(Value) -> anyhow::Result<Value>),
}

/// One argument a [`Handler::Forward`] tool passes on.
#[derive(Clone, Copy)]
pub(super) enum Field {
    /// A string the call fails without.
    Required(&'static str),
    /// Passed on as given, `null` when absent.
    Optional(&'static str),
}

/// One domain's tools: their schemas in catalog order, and their handlers.
pub(super) struct Domain {
    pub(super) schemas: fn() -> Vec<Value>,
    pub(super) handlers: &'static [(&'static str, Handler)],
}

pub(super) fn tool(name: &str, title: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
    })
}

/// The `tools/list` catalog: every domain's schemas, domain by domain.
pub(super) fn tools() -> Vec<Value> {
    DOMAINS.iter().flat_map(|d| (d.schemas)()).collect()
}

fn handler(name: &str) -> Option<&'static Handler> {
    DOMAINS
        .iter()
        .flat_map(|d| d.handlers)
        .find(|(n, _)| *n == name)
        .map(|(_, h)| h)
}

pub(super) async fn call_tool(state: &McpContext, params: Value) -> anyhow::Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing tool name"))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let handler = handler(name).ok_or_else(|| anyhow::anyhow!("unknown tool: {name}"))?;
    let value = match handler {
        Handler::Local(run) => run(state, args)?,
        Handler::Forward(fields) => {
            call_frontend(state, name, forward_args(&args, fields)?).await?
        }
        Handler::ForwardWith(build) => call_frontend(state, name, build(args)?).await?,
    };
    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value)? }] }))
}

/// The RPC arguments of a [`Handler::Forward`] tool. Fields are checked in
/// order, so the first missing one is the one reported.
fn forward_args(args: &Value, fields: &[Field]) -> anyhow::Result<Value> {
    let mut out = serde_json::Map::new();
    for field in fields {
        let (key, value) = match *field {
            Field::Required(key) => (key, json!(required_str(args, key)?)),
            Field::Optional(key) => (key, args.get(key).cloned().unwrap_or(Value::Null)),
        };
        out.insert(key.to_string(), value);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::{tools, DOMAINS};

    #[test]
    fn every_tool_name_is_unique() {
        let names: Vec<String> = tools()
            .iter()
            .filter_map(|t| t.get("name")?.as_str().map(str::to_string))
            .collect();
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(names.len(), unique.len(), "duplicate tool name in tools()");
    }

    #[test]
    fn every_tool_has_exactly_one_handler() {
        let mut handled: Vec<&str> = DOMAINS
            .iter()
            .flat_map(|d| d.handlers)
            .map(|(name, _)| *name)
            .collect();
        let mut listed: Vec<String> = tools()
            .iter()
            .filter_map(|t| t.get("name")?.as_str().map(str::to_string))
            .collect();
        handled.sort_unstable();
        listed.sort_unstable();
        assert_eq!(handled, listed);
    }
}
