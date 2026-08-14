//! The `ask_user` tool — Skein hosting the question the CLI can't offer.
//!
//! `AskUserQuestion` and `ExitPlanMode` do not exist in headless mode (probed:
//! absent from the tool list, and `--tools` silently drops them when named).
//! So rather than wait for them, we provide our own over MCP.
//!
//! The shape that makes this good is the parking. A `tools/call` blocks the
//! HTTP request until the UI answers it, which means the agent is genuinely
//! *stopped* rather than idle, and when the answer arrives the turn continues
//! where it left off instead of restarting. Amber stops being an inference
//! about silence and becomes a fact.
//!
//! Protocol confirmed against claude 2.1.227: plain JSON-RPC over POST, no SSE
//! required. The client also issues one GET, which we may refuse.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

/// How long a question waits before the agent is told to carry on without you.
///
/// Blocking forever would be worse than it sounds: the turn holds its context,
/// and a question you never noticed becomes an agent wedged until you quit. Ten
/// minutes is long enough to be away from the desk and short enough that a
/// forgotten card unsticks itself.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

const TIMED_OUT: &str =
    "The user did not answer within ten minutes. Proceed using your best \
     judgement, and say which way you went and why.";

/// How long the *client* must be told to wait, in milliseconds.
///
/// The parking above is worth nothing unless the CLI is still listening when
/// the answer arrives, and by default it is not. Probed against claude 2.1.232
/// with `tools/probe-ask.ts`, which parks a call and answers it late: the CLI
/// **aborts the HTTP request at 60.02s** and hands the model
/// `is_error: true, "The operation timed out."`. So a question answered at any
/// point past the first minute — which is most of them, since the whole reason
/// to ask is that somebody has to think — reached a request nobody was reading,
/// and the card went quiet having done everything right. `MCP_TOOL_TIMEOUT`
/// lifts it; the same probe with this set parked 90s, was never aborted, and
/// the answer resumed the turn in place.
///
/// The minute of headroom is the point rather than slack. Whichever side gives
/// up first writes what the model reads, and ours is the sentence worth having
/// — it says how long it waited and what to do about it, where the client's
/// says only that something timed out. The heartbeats the CLI streams
/// (`tool_progress` every 30s) do not extend its own deadline, so there is
/// nothing to send that would substitute for this.
pub fn client_timeout_ms() -> u64 {
    ANSWER_TIMEOUT.as_millis() as u64 + 60_000
}

#[derive(Default)]
pub struct Asks {
    port: Mutex<u16>,
    pending: Mutex<HashMap<String, Sender<String>>>,
}

#[derive(Clone, Serialize)]
struct AskOpened {
    conversation_id: String,
    ask_id: String,
    question: String,
    options: Vec<AskOption>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct AskOption {
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Serialize)]
struct AskClosed {
    ask_id: String,
    answered: bool,
}

impl Asks {
    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }
    pub fn set_port(&self, port: u16) {
        *self.port.lock().unwrap() = port;
    }
}

/// Hand the UI's answer back to the parked HTTP request.
#[tauri::command]
pub fn answer_ask(asks: State<'_, Asks>, ask_id: String, answer: String) -> Result<(), String> {
    let tx = asks
        .pending
        .lock()
        .unwrap()
        .remove(&ask_id)
        .ok_or("that question is no longer waiting")?;
    tx.send(answer).map_err(|_| "the asking turn has gone".to_string())
}

fn tool_schema() -> Value {
    json!({
        "name": "ask_user",
        "description":
            "Ask the human a question and wait for their answer. Use this whenever you \
             need a decision only they can make — a choice between approaches, a \
             confirmation, a missing detail. Prefer it over ending your turn with a \
             question, because this keeps the turn open and resumes as soon as they \
             answer. Supply `options` when the answer is a choice; they can then reply \
             with one click.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The question, in one or two sentences."
                },
                "options": {
                    "type": "array",
                    "description": "Optional preset answers, most recommended first.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label":  { "type": "string", "description": "Short choice text." },
                            "detail": { "type": "string", "description": "What picking this means." }
                        },
                        "required": ["label"]
                    }
                }
            },
            "required": ["question"]
        }
    })
}

/// Park until the UI answers, or until we give up on being answered.
fn handle_call(
    app: &AppHandle,
    asks: &Asks,
    conversation_id: &str,
    args: &Value,
) -> String {
    let question = args
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("(no question given)")
        .to_string();
    let options: Vec<AskOption> = args
        .get("options")
        .and_then(|o| serde_json::from_value(o.clone()).ok())
        .unwrap_or_default();

    let ask_id = crate::store::uuid_v4();
    let (tx, rx) = mpsc::channel::<String>();
    asks.pending.lock().unwrap().insert(ask_id.clone(), tx);

    let _ = app.emit(
        "ask:opened",
        AskOpened {
            conversation_id: conversation_id.to_string(),
            ask_id: ask_id.clone(),
            question,
            options,
        },
    );

    let answer = match rx.recv_timeout(ANSWER_TIMEOUT) {
        Ok(a) => a,
        Err(RecvTimeoutError::Timeout) => {
            asks.pending.lock().unwrap().remove(&ask_id);
            TIMED_OUT.to_string()
        }
        /* The sender was dropped — the card was closed while it was asking. */
        Err(RecvTimeoutError::Disconnected) => {
            "The user dismissed the question. Proceed using your best judgement.".to_string()
        }
    };

    let _ = app.emit(
        "ask:closed",
        AskClosed {
            ask_id,
            answered: answer != TIMED_OUT,
        },
    );
    answer
}

/// What a JSON-RPC message means, decided without touching the network so it
/// can be tested directly.
#[derive(Debug, PartialEq)]
pub(crate) enum Dispatch {
    /// A notification: acknowledge with 202 and no body.
    Accepted,
    /// Answer immediately with this result.
    Reply(Value),
    /// A `tools/call` — the caller must park until the user answers.
    Call { id: Value, args: Value },
    /// Answer with a JSON-RPC error for this method name.
    Unknown { id: Value, method: String },
}

pub(crate) fn dispatch(rpc: &Value) -> Dispatch {
    // Notifications carry no id and expect no body.
    let Some(id) = rpc.get("id").cloned() else {
        return Dispatch::Accepted;
    };
    let method = rpc.get("method").and_then(Value::as_str).unwrap_or("");

    match method {
        "initialize" => Dispatch::Reply(json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": rpc
                    .get("params")
                    .and_then(|p| p.get("protocolVersion"))
                    .cloned()
                    .unwrap_or_else(|| json!("2025-06-18")),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "skein", "version": env!("CARGO_PKG_VERSION") }
            }
        })),
        "tools/list" => Dispatch::Reply(json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": [tool_schema()] }
        })),
        "ping" => Dispatch::Reply(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/call" => Dispatch::Call {
            id,
            args: rpc
                .get("params")
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({})),
        },
        other => Dispatch::Unknown {
            id,
            method: other.to_string(),
        },
    }
}

/// The conversation id is the last path segment of `/mcp/<id>`, so a call
/// arrives already addressed to a card with no correlation logic anywhere.
pub(crate) fn conversation_of(url: &str) -> &str {
    url.split('?')
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

fn respond(req: tiny_http::Request, body: Value) {
    let data = body.to_string();
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let _ = req.respond(tiny_http::Response::from_string(data).with_header(header));
}

/// Bind on an ephemeral loopback port and serve until the process exits.
/// Returns the port so `spawn_conversation` can point `--mcp-config` at it.
pub fn start(app: AppHandle) -> Result<u16, String> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("bind ask server: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("ask server has no ip address")?
        .port();

    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            /* A parked question blocks its request for up to ten minutes, so
               every request gets its own thread — otherwise one card waiting on
               you would stall every other card's MCP traffic. */
            std::thread::spawn(move || {
                if req.method() != &tiny_http::Method::Post {
                    let _ = req.respond(tiny_http::Response::empty(405));
                    return;
                }

                let conversation_id = conversation_of(req.url()).to_string();

                let mut body = String::new();
                if std::io::Read::read_to_string(req.as_reader(), &mut body).is_err() {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    return;
                }
                let Ok(rpc) = serde_json::from_str::<Value>(&body) else {
                    let _ = req.respond(tiny_http::Response::empty(400));
                    return;
                };

                match dispatch(&rpc) {
                    Dispatch::Accepted => {
                        let _ = req.respond(tiny_http::Response::empty(202));
                    }
                    Dispatch::Reply(body) => respond(req, body),
                    Dispatch::Unknown { id, method } => respond(
                        req,
                        json!({
                            "jsonrpc": "2.0", "id": id,
                            "error": { "code": -32601, "message": format!("no method {method}") }
                        }),
                    ),
                    Dispatch::Call { id, args } => {
                        let asks = app.state::<Asks>();
                        let answer = handle_call(&app, &asks, &conversation_id, &args);
                        respond(
                            req,
                            json!({
                                "jsonrpc": "2.0", "id": id,
                                "result": { "content": [{ "type": "text", "text": answer }] }
                            }),
                        );
                    }
                }
            });
        }
    });

    Ok(port)
}

use tauri::Manager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notification_gets_acknowledged_with_no_body() {
        let n = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(dispatch(&n), Dispatch::Accepted);
    }

    #[test]
    fn initialize_echoes_the_client_protocol_version() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        assert_eq!(v["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(v["result"]["serverInfo"]["name"], "skein");
        assert_eq!(v["id"], 1);
    }

    #[test]
    fn initialize_falls_back_when_the_client_names_no_version() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        assert!(v["result"]["protocolVersion"].is_string());
    }

    #[test]
    fn tools_list_advertises_ask_user_with_a_usable_schema() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let Dispatch::Reply(v) = r else { panic!("expected a reply") };
        let tool = &v["result"]["tools"][0];
        assert_eq!(tool["name"], "ask_user");
        assert_eq!(tool["inputSchema"]["required"][0], "question");
        // Options are what make an answer a click instead of a sentence.
        assert!(tool["inputSchema"]["properties"]["options"].is_object());
    }

    #[test]
    fn tools_call_is_parked_rather_than_answered() {
        let r = dispatch(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "ask_user", "arguments": { "question": "tabs or spaces?" } }
        }));
        let Dispatch::Call { id, args } = r else { panic!("expected a call") };
        assert_eq!(id, 3);
        assert_eq!(args["question"], "tabs or spaces?");
    }

    #[test]
    fn a_call_with_no_arguments_still_parks_rather_than_panicking() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call" }));
        let Dispatch::Call { args, .. } = r else { panic!("expected a call") };
        assert!(args.is_object());
    }

    #[test]
    fn an_unknown_method_reports_itself_instead_of_going_quiet() {
        let r = dispatch(&json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" }));
        assert_eq!(
            r,
            Dispatch::Unknown { id: json!(9), method: "resources/list".into() }
        );
    }

    /// The client must outlast us, or it writes the timeout message instead of
    /// the one above — and at the shipped default (60s, probed against 2.1.232)
    /// it abandons the call long before anybody has finished reading it.
    #[test]
    fn the_client_is_told_to_wait_longer_than_we_do() {
        let ours = ANSWER_TIMEOUT.as_millis() as u64;
        assert!(
            client_timeout_ms() > ours,
            "the client would give up first and the user's answer would land nowhere"
        );
        assert!(client_timeout_ms() >= ours + 30_000, "not enough headroom to be sure");
    }

    #[test]
    fn the_conversation_id_comes_off_the_url() {
        assert_eq!(conversation_of("/mcp/abc-123"), "abc-123");
        assert_eq!(conversation_of("/mcp/abc-123/"), "abc-123");
        assert_eq!(conversation_of("/mcp/abc-123?x=1"), "abc-123");
    }
}
