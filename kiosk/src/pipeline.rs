use gstreamer::prelude::*;
use gstreamer::{self as gst, Element, Pipeline};
use tracing::{error, info, warn};

/// Create a GStreamer pipeline for an RTSP camera that outputs to a GTK4 paintable sink.
/// Returns (pipeline, paintable_sink).
pub fn create_camera_pipeline(name: &str, rtsp_uri: &str) -> Option<(Pipeline, Element)> {
    let pipeline_name = format!("cam-{name}");
    let pipeline = Pipeline::with_name(&pipeline_name);

    let src = gst::ElementFactory::make("rtspsrc")
        .property("location", rtsp_uri)
        .property("latency", 300u32)
        .property_from_str("protocols", "tcp")
        .build()
        .ok()?;

    let decode = gst::ElementFactory::make("decodebin").build().ok()?;
    let convert = gst::ElementFactory::make("videoconvert").build().ok()?;

    let sink = gst::ElementFactory::make("gtk4paintablesink")
        .build()
        .map_err(|e| {
            error!("gtk4paintablesink not available: {e}. Install gst-plugin-gtk4");
        })
        .ok()?;

    let queue = gst::ElementFactory::make("queue")
        .property("max-size-buffers", 1u32)
        .property("leaky", 2u32)
        .build()
        .ok()?;

    pipeline.add_many([&src, &decode, &queue, &convert, &sink]).ok()?;

    // rtspsrc → decodebin (dynamic pads)
    let decode_weak = decode.downgrade();
    src.connect_pad_added(move |_src, pad| {
        let Some(decode) = decode_weak.upgrade() else { return };
        let sink_pad = decode.static_pad("sink").unwrap();
        if !sink_pad.is_linked() {
            let _ = pad.link(&sink_pad);
        }
    });

    // decodebin → queue → convert → sink (dynamic pads, video only)
    let queue_weak = queue.downgrade();
    let pipeline_name_clone = pipeline_name.clone();
    decode.connect_pad_added(move |_decode, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let caps_str = caps.to_string();

        if !caps_str.starts_with("video/") {
            return;
        }

        info!("[{pipeline_name_clone}] decodebin video pad: {caps_str}");

        let Some(queue) = queue_weak.upgrade() else { return };
        let sink_pad = queue.static_pad("sink").unwrap();
        if !sink_pad.is_linked() {
            if pad.link(&sink_pad).is_err() {
                warn!("[{pipeline_name_clone}] decodebin pad link failed");
            }
        }
    });

    gst::Element::link_many([&queue, &convert, &sink]).ok()?;

    info!("[{pipeline_name}] pipeline created for {rtsp_uri}");
    Some((pipeline, sink))
}

/// Start a pipeline.
pub fn play(pipeline: &Pipeline) {
    if let Err(e) = pipeline.set_state(gst::State::Playing) {
        error!("Failed to set pipeline to Playing: {e:?}");
    }
}

/// Stop a pipeline.
pub fn stop(pipeline: &Pipeline) {
    let _ = pipeline.set_state(gst::State::Null);
}
