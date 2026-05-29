use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use gstreamer::prelude::*;
use gstreamer::{self as gst, Element, Pipeline};
use tracing::{error, info, warn};

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn create_camera_pipeline(
    name: &str,
    rtsp_uri: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Option<(Pipeline, Element, Arc<AtomicU64>)> {
    let pipeline_name = format!("cam-{name}");
    let pipeline = Pipeline::with_name(&pipeline_name);

    // Credentials are supplied separately so the cached bundle can avoid
    // storing playback secrets directly in the RTSP URL.
    let mut builder = gst::ElementFactory::make("rtspsrc")
        .property("location", &rtsp_uri)
        .property("latency", 300u32)
        .property_from_str("protocols", "tcp");
    if let Some(u) = username.filter(|v| !v.is_empty()) {
        builder = builder.property("user-id", u);
    }
    if let Some(p) = password.filter(|v| !v.is_empty()) {
        builder = builder.property("user-pw", p);
    }
    let src = builder
        .build()
        .map_err(|e| error!("[{pipeline_name}] rtspsrc: {e}"))
        .ok()?;

    let decode = gst::ElementFactory::make("decodebin")
        .build()
        .map_err(|e| error!("[{pipeline_name}] decodebin: {e}"))
        .ok()?;

    let convert = gst::ElementFactory::make("videoconvert")
        .build()
        .map_err(|e| error!("[{pipeline_name}] videoconvert: {e}"))
        .ok()?;

    let sink = gst::ElementFactory::make("gtk4paintablesink")
        .build()
        .map_err(|e| error!("[{pipeline_name}] gtk4paintablesink: {e}"))
        .ok()?;

    pipeline.add_many([&src, &decode, &convert, &sink]).ok()?;
    gst::Element::link_many([&convert, &sink])
        .map_err(|e| error!("[{pipeline_name}] link convert→sink failed: {e}"))
        .ok()?;

    // rtspsrc → decodebin (dynamic pads)
    let decode_weak = decode.downgrade();
    let pn = pipeline_name.clone();
    src.connect_pad_added(move |_src, pad| {
        let name = pad.name().to_string();
        info!("[{pn}] rtspsrc pad added: {name}");

        // Only link video pads — check caps for application/x-rtp with video media
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let caps_str = caps.to_string();
        if !caps_str.contains("media=(string)video")
            && !caps_str.contains("encoding-name=(string)H26")
        {
            info!("[{pn}] skipping non-video pad: {caps_str}");
            return;
        }

        let Some(decode) = decode_weak.upgrade() else {
            return;
        };
        let sink_pad = decode.static_pad("sink").unwrap();
        if !sink_pad.is_linked() {
            match pad.link(&sink_pad) {
                Ok(_) => info!("[{pn}] rtspsrc→decodebin linked (video)"),
                Err(e) => error!("[{pn}] rtspsrc→decodebin link failed: {e:?}"),
            }
        }
    });

    // decodebin → convert (dynamic pads, video only)
    let convert_weak = convert.downgrade();
    let pn2 = pipeline_name.clone();
    decode.connect_pad_added(move |_decode, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let structure = caps.structure(0);
        let media = structure.map(|s| s.name().to_string()).unwrap_or_default();

        info!("[{pn2}] decodebin pad: {media}");

        if !media.starts_with("video/") {
            return;
        }

        let Some(convert) = convert_weak.upgrade() else {
            return;
        };
        let sink_pad = convert.static_pad("sink").unwrap();
        if !sink_pad.is_linked() {
            match pad.link(&sink_pad) {
                Ok(_) => info!("[{pn2}] decodebin→convert linked"),
                Err(e) => error!("[{pn2}] decodebin→convert link failed: {e:?}"),
            }
        }
    });

    // Watch bus for errors
    let pn3 = pipeline_name.clone();
    let bus = pipeline.bus().unwrap();
    let _guard = bus
        .add_watch_local(move |_bus, msg| {
            use gst::MessageView;
            match msg.view() {
                MessageView::Error(err) => {
                    error!(
                        "[{pn3}] pipeline error: {} ({:?})",
                        err.error(),
                        err.debug()
                    );
                }
                MessageView::Warning(w) => {
                    warn!("[{pn3}] pipeline warning: {} ({:?})", w.error(), w.debug());
                }
                MessageView::StateChanged(sc) => {
                    if sc.src().map(|s| s.name().as_str() == pn3).unwrap_or(false) {
                        info!("[{pn3}] state: {:?} → {:?}", sc.old(), sc.current());
                    }
                }
                _ => {}
            }
            gst::glib::ControlFlow::Continue
        })
        .ok()?;

    // Leak the guard so it lives as long as the pipeline
    std::mem::forget(_guard);

    // Track last buffer arrival for stall detection. Initialised to "now"
    // so the watchdog gives the pipeline time to connect before flagging it.
    let last_buffer = Arc::new(AtomicU64::new(epoch_millis()));
    if let Some(pad) = sink.static_pad("sink") {
        let ts = last_buffer.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            ts.store(epoch_millis(), Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });
    }

    info!("[{pipeline_name}] pipeline created for {rtsp_uri}");
    Some((pipeline, sink, last_buffer))
}

pub fn play(pipeline: &Pipeline) {
    match pipeline.set_state(gst::State::Playing) {
        Ok(r) => info!("[{}] set_state(Playing) = {r:?}", pipeline.name()),
        Err(e) => error!("[{}] set_state(Playing) failed: {e:?}", pipeline.name()),
    }
}

pub fn stop(pipeline: &Pipeline) {
    let _ = pipeline.set_state(gst::State::Null);
}

pub fn restart(pipeline: &Pipeline, last_buffer: &AtomicU64) {
    let name = pipeline.name().to_string();
    info!("[{name}] restarting stalled pipeline");
    let _ = pipeline.set_state(gst::State::Null);
    last_buffer.store(epoch_millis(), Ordering::Relaxed);
    match pipeline.set_state(gst::State::Playing) {
        Ok(r) => info!("[{name}] restart → Playing = {r:?}"),
        Err(e) => error!("[{name}] restart failed: {e:?}"),
    }
}
