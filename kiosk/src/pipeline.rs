use gstreamer::prelude::*;
use gstreamer::{self as gst, Element, Pipeline};
use tracing::{error, info, warn};

/// Create a GStreamer pipeline for an RTSP camera that outputs to a GTK4 paintable sink.
/// Returns (pipeline, paintable_sink) — the sink's "paintable" property drives a gtk4::Picture.
pub fn create_camera_pipeline(name: &str, rtsp_uri: &str) -> Option<(Pipeline, Element)> {
    let pipeline_name = format!("cam-{name}");
    let pipeline = Pipeline::with_name(&pipeline_name);

    let src = gst::ElementFactory::make("rtspsrc")
        .property("location", rtsp_uri)
        .property("latency", 300u32)
        .property_from_str("protocols", "tcp")
        .build()
        .ok()?;

    let depay_h264 = gst::ElementFactory::make("rtph264depay").build().ok();
    let depay_h265 = gst::ElementFactory::make("rtph265depay").build().ok();
    let parse_h264 = gst::ElementFactory::make("h264parse").build().ok();
    let parse_h265 = gst::ElementFactory::make("h265parse").build().ok();
    let decode = gst::ElementFactory::make("avdec_h264").build()
        .or_else(|| gst::ElementFactory::make("decodebin").build().ok());

    let convert = gst::ElementFactory::make("videoconvert").build().ok()?;

    let sink = gst::ElementFactory::make("gtk4paintablesink")
        .build()
        .map_err(|e| {
            error!("gtk4paintablesink not available: {e}. Install gst-plugin-gtk4");
        })
        .ok()?;

    let queue = gst::ElementFactory::make("queue")
        .property("max-size-buffers", 1u32)
        .property("leaky", 2u32) // downstream
        .build()
        .ok()?;

    pipeline.add_many([&src, &queue, &convert, &sink]).ok()?;
    gst::Element::link_many([&queue, &convert, &sink]).ok()?;

    // rtspsrc has dynamic pads — connect on pad-added
    let queue_weak = queue.downgrade();
    let pipeline_name_clone = pipeline_name.clone();
    src.connect_pad_added(move |_src, pad| {
        let caps = pad.current_caps().or_else(|| pad.query_caps(None));
        let caps_str = caps.map(|c| c.to_string()).unwrap_or_default();

        // Only link video pads
        if !caps_str.contains("video") && !caps_str.contains("264") && !caps_str.contains("265") {
            return;
        }

        info!("[{pipeline_name_clone}] linking pad: {caps_str}");

        let Some(queue) = queue_weak.upgrade() else { return };
        if pad.link(&queue.static_pad("sink").unwrap()).is_err() {
            warn!("[{pipeline_name_clone}] pad link failed");
        }
    });

    // For decodebin-style pipelines, we might need more complex linking.
    // For now, rtspsrc → queue → convert → sink works for raw decode.
    // The actual decode happens if we insert depay+parse+decoder elements.
    // TODO: auto-detect codec and insert appropriate decoder chain.

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
