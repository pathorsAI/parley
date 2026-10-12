//! WebSocket session machinery shared by the streaming transcription adapters.
//!
//! Every realtime provider splits its socket the same way: a write half that
//! pumps PCM chunks and a read half that turns server frames into JSON payloads
//! to parse. What differs is the wire dressing — binary PCM vs a base64 JSON
//! envelope, whether an idle socket needs a keepalive, what the goodbye frame is
//! called, and whether a close code carries the only error the provider will
//! ever give us. Those bits stay in the adapters; the plumbing around them lives
//! here so it isn't copied five times.

use std::future::pending;
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::Interval;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::common::LevelMeter;

/// A provider socket, and its two halves after `split()`.
pub type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub type WsWrite = SplitSink<Ws, Message>;
pub type WsRead = SplitStream<Ws>;

/// What the read loop should do with one incoming websocket frame.
enum Frame {
    /// A JSON payload to parse.
    Payload(String),
    /// Nothing of interest — keep reading.
    Skip,
    /// The stream ended in a way that isn't an error.
    Stop,
    /// The server closed abnormally: terminal, with its reason as the detail.
    Failed(String),
}

/// How a provider reads a server-initiated close frame.
#[derive(Clone, Copy)]
pub enum OnClose {
    /// Any close just ends the read loop — this provider reports terminal
    /// failures in band, so the close itself says nothing.
    Stop,
    /// A non-1000 close is the only error channel this provider has: terminal,
    /// with the code and reason as the detail.
    FailIfAbnormal,
}

/// What the payload handler wants the read loop to do next.
pub enum Next {
    /// Keep reading.
    Continue,
    /// The provider signalled end-of-stream in band; stop reading.
    Stop,
}

/// Classify one websocket frame into "parse this" / "ignore" / "we're done" /
/// "the server hung up on us".
fn classify(
    msg: Result<Message, tokio_tungstenite::tungstenite::Error>,
    provider: &str,
    source: &str,
    on_close: OnClose,
) -> Frame {
    let msg = match msg {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[{provider}:{source}] read error: {e}");
            return Frame::Stop;
        }
    };
    match msg {
        Message::Text(t) => Frame::Payload(t.to_string()),
        Message::Binary(b) => Frame::Payload(String::from_utf8_lossy(&b).into_owned()),
        Message::Close(frame) => {
            eprintln!("[{provider}:{source}] closed by server: {frame:?}");
            match (on_close, frame) {
                (OnClose::FailIfAbnormal, Some(f)) if f.code != CloseCode::Normal => {
                    Frame::Failed(format!("{} {}", u16::from(f.code), f.reason))
                }
                _ => Frame::Stop,
            }
        }
        _ => Frame::Skip,
    }
}

/// Read server frames until the socket ends, handing every JSON payload to
/// `on_payload`. The handler folds the payload into the adapter's segment
/// builder and returns `Err` for a terminal in-band error, which stops the loop
/// and propagates (see `run_metered_session`'s error surface).
///
/// The first three payloads are traced raw — the cheapest way to see what a
/// provider actually sent when a session misbehaves.
pub async fn read_frames<F>(
    provider: &str,
    source: &str,
    mut read: WsRead,
    on_close: OnClose,
    mut on_payload: F,
) -> Result<()>
where
    F: FnMut(&str) -> Result<Next>,
{
    let mut msg_count: u64 = 0;
    while let Some(msg) = read.next().await {
        let payload = match classify(msg, provider, source, on_close) {
            Frame::Payload(p) => p,
            Frame::Skip => continue,
            Frame::Stop => break,
            Frame::Failed(detail) => return Err(anyhow!("closed by server: {detail}")),
        };
        msg_count += 1;
        if msg_count <= 3 {
            eprintln!("[{provider}:{source}] RX raw#{msg_count}: {payload}");
        }
        if matches!(on_payload(&payload)?, Next::Stop) {
            break;
        }
    }
    Ok(())
}

/// The provider-specific shape of the write half's life: how it stays alive and
/// how it says goodbye.
pub struct Pump {
    /// Text frame to send on an interval, for providers that drop a socket that
    /// goes quiet. `None` = no keepalive.
    pub keepalive: Option<(Duration, &'static str)>,
    /// Text frame that tells the server the stream is over, sent once the audio
    /// stops. `None` = closing the socket is the whole goodbye.
    pub finish: Option<&'static str>,
    /// Whether to close the write half afterwards. A protocol whose goodbye is
    /// answered in band (the hosted `end` → tail → `done`) leaves it open so
    /// the server's reply still reaches the read half.
    pub close: bool,
}

impl Default for Pump {
    fn default() -> Self {
        Self {
            keepalive: None,
            finish: None,
            close: true,
        }
    }
}

/// How long one websocket send may take before the socket is presumed dead.
///
/// A dropped network rarely errors a send: the kernel keeps accepting bytes
/// into its send buffer and then the write simply never completes, until TCP
/// gives up minutes later. A healthy send finishes in milliseconds, so a ten
/// second stall is unambiguous — and it bounds noticing a dead socket to
/// roughly "send buffer fills + 10 s", well inside the meeting's 45 s hold
/// buffer (see `transcription::bridge`), so the words spoken meanwhile are
/// still there for the next leg.
pub const SEND_STALL_TIMEOUT: Duration = Duration::from_secs(10);

/// One send bounded by [`SEND_STALL_TIMEOUT`]; a stall counts as a failure.
async fn send_bounded(write: &mut WsWrite, msg: Message) -> bool {
    matches!(
        tokio::time::timeout(SEND_STALL_TIMEOUT, write.send(msg)).await,
        Ok(Ok(()))
    )
}

/// Wait for the next keepalive tick and yield the frame to send, or never
/// resolve when the provider has no keepalive — so that `select!` arm simply
/// stays pending for the life of the session.
async fn keepalive_tick(keepalive: &mut Option<(Interval, &'static str)>) -> &'static str {
    match keepalive {
        Some((timer, frame)) => {
            timer.tick().await;
            *frame
        }
        None => pending().await,
    }
}

/// Pump captured PCM into the socket until the input drains or a send fails,
/// then run the provider's shutdown handshake. `encode` turns one chunk into
/// whatever frame that provider expects.
///
/// Resolves `true` when the input drained (the capture side closed — a normal
/// stop) and `false` when a send failed or stalled past
/// [`SEND_STALL_TIMEOUT`], i.e. the socket died under us; see
/// [`super::common::drive_session`], which reports the latter as a failure.
pub async fn forward_audio<F>(
    mut write: WsWrite,
    mut meter: LevelMeter,
    mut pcm_rx: UnboundedReceiver<Vec<i16>>,
    pump: Pump,
    mut encode: F,
) -> bool
where
    F: FnMut(&[i16]) -> Message,
{
    let mut keepalive = pump
        .keepalive
        .map(|(period, frame)| (tokio::time::interval(period), frame));
    if let Some((timer, _)) = keepalive.as_mut() {
        // The first tick fires immediately; consume it so the interval counts
        // from now rather than firing a keepalive before any audio moved.
        timer.tick().await;
    }

    let drained = loop {
        tokio::select! {
            maybe_chunk = pcm_rx.recv() => {
                let Some(chunk) = maybe_chunk else { break true };
                meter.push(&chunk);
                if !send_bounded(&mut write, encode(&chunk)).await {
                    break false;
                }
            }
            frame = keepalive_tick(&mut keepalive) => {
                if !send_bounded(&mut write, Message::Text(frame.to_string())).await {
                    break false;
                }
            }
        }
    };

    if !drained {
        // The socket is dead, so there is nobody to say goodbye to — and on a
        // stalled one the goodbye would stall just like the send that got us
        // here. Close our input now rather than when this future is dropped:
        // a meeting's bridge notices the dead leg on its next send and starts
        // holding audio for the next one, instead of feeding a channel nobody
        // reads through `drive_session`'s read grace.
        drop(pcm_rx);
        return false;
    }
    // A normal stop. The goodbye is bounded too, in case the network died
    // right as the meeting ended.
    if let Some(frame) = pump.finish {
        let _ = send_bounded(&mut write, Message::Text(frame.to_string())).await;
    }
    if pump.close {
        let _ = tokio::time::timeout(SEND_STALL_TIMEOUT, write.close()).await;
    }
    true
}
