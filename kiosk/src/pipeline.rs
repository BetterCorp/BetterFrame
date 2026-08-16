use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use gstreamer::prelude::*;
use gstreamer::{self as gst, Element, Pipeline};
use tracing::{error, info, warn};

pub const STATUS_OK: u8 = 0;
pub const STATUS_RESTARTING: u8 = 1;
pub const STATUS_ERROR: u8 = 2;

static NEXT_PIPELINE_ID: AtomicU64 = AtomicU64::new(1);
static PIPELINES: OnceLock<Mutex<HashMap<String, Weak<PipelineStats>>>> = OnceLock::new();

pub struct PipelineStats {
    name: String,
    decoder: Mutex<String>,
    frames_processed: AtomicU64,
    frames_dropped: AtomicU64,
    restarts: AtomicU64,
}

#[derive(serde::Serialize)]
pub struct PipelineTelemetry {
    name: String,
    decoder: String,
    hardware_decode: bool,
    frames_processed: u64,
    frames_dropped: u64,
    restarts: u64,
}

pub fn telemetry() -> Vec<PipelineTelemetry> {
    let mut registry = PIPELINES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    let mut out = Vec::new();
    registry.retain(|_, weak| {
        let Some(stats) = weak.upgrade() else {
            return false;
        };
        let decoder = stats.decoder.lock().unwrap().clone();
        let lower = decoder.to_ascii_lowercase();
        out.push(PipelineTelemetry {
            name: stats.name.clone(),
            hardware_decode: ["va", "nv", "v4l2", "d3d11"]
                .iter()
                .any(|prefix| lower.starts_with(prefix)),
            decoder,
            frames_processed: stats.frames_processed.load(Ordering::Relaxed),
            frames_dropped: stats.frames_dropped.load(Ordering::Relaxed),
            restarts: stats.restarts.load(Ordering::Relaxed),
        });
        true
    });
    out
}

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
) -> Option<(
    Pipeline,
    Element,
    Arc<AtomicU64>,
    Arc<AtomicU8>,
    Arc<PipelineStats>,
)> {
    let pipeline_name = format!(
        "cam-{name}-{}",
        NEXT_PIPELINE_ID.fetch_add(1, Ordering::Relaxed),
    );
    let pipeline = Pipeline::with_name(&pipeline_name);
    let stats = Arc::new(PipelineStats {
        name: pipeline_name.clone(),
        decoder: Mutex::new("unknown".to_string()),
        frames_processed: AtomicU64::new(0),
        frames_dropped: AtomicU64::new(0),
        restarts: AtomicU64::new(0),
    });
    PIPELINES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap()
        .insert(pipeline_name.clone(), Arc::downgrade(&stats));

    let mut builder = gst::ElementFactory::make("rtspsrc")
        .property("location", rtsp_uri)
        .property("latency", 300u32)
        .property_from_str("protocols", "tcp");
    if let Some(value) = username.filter(|value| !value.is_empty()) {
        builder = builder.property("user-id", value);
    }
    if let Some(value) = password.filter(|value| !value.is_empty()) {
        builder = builder.property("user-pw", value);
    }
    let src = builder
        .build()
        .map_err(|error| error!("[{pipeline_name}] rtspsrc: {error}"))
        .ok()?;
    let decode = gst::ElementFactory::make("decodebin")
        .build()
        .map_err(|error| error!("[{pipeline_name}] decodebin: {error}"))
        .ok()?;
    let sink = gst::ElementFactory::make("gtk4paintablesink")
        .build()
        .map_err(|error| error!("[{pipeline_name}] gtk4paintablesink: {error}"))
        .ok()?;
    pipeline.add_many([&src, &decode, &sink]).ok()?;

    if let Ok(bin) = decode.clone().downcast::<gst::Bin>() {
        let decoder_stats = stats.clone();
        bin.connect_deep_element_added(move |_, _, element| {
            let Some(factory) = element.factory() else {
                return;
            };
            if factory
                .metadata("klass")
                .unwrap_or_default()
                .contains("Decoder")
            {
                let name = factory.name().to_string();
                *decoder_stats.decoder.lock().unwrap() = name.clone();
                info!("selected decoder: {name}");
            }
        });
    }

    let decode_weak = decode.downgrade();
    let source_name = pipeline_name.clone();
    src.connect_pad_added(move |_, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let caps_text = caps.to_string();
        if !caps_text.contains("media=(string)video")
            && !caps_text.contains("encoding-name=(string)H26")
        {
            return;
        }
        let Some(decode) = decode_weak.upgrade() else {
            return;
        };
        let Some(sink_pad) = decode.static_pad("sink") else {
            return;
        };
        if !sink_pad.is_linked() {
            match pad.link(&sink_pad) {
                Ok(_) => info!("[{source_name}] RTSP video linked"),
                Err(error) => error!("[{source_name}] RTSP link failed: {error:?}"),
            }
        }
    });

    // Prefer the DMA-BUF/GL path. Common software decoders output YUV while
    // gtk4paintablesink accepts RGB system memory, so insert videoconvert only
    // when direct negotiation fails.
    let pipeline_weak = pipeline.downgrade();
    let sink_weak = sink.downgrade();
    let decode_name = pipeline_name.clone();
    decode.connect_pad_added(move |_, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        if !caps
            .structure(0)
            .map(|structure| structure.name().starts_with("video/"))
            .unwrap_or(false)
        {
            return;
        }
        let Some(sink) = sink_weak.upgrade() else {
            return;
        };
        let Some(sink_pad) = sink.static_pad("sink") else {
            return;
        };
        if !sink_pad.is_linked() {
            match pad.link(&sink_pad) {
                Ok(_) => info!("[{decode_name}] decoder linked directly to GTK sink"),
                Err(error) => {
                    info!("[{decode_name}] direct decoder link unavailable ({error:?}); using videoconvert");
                    let Some(pipeline) = pipeline_weak.upgrade() else {
                        return;
                    };
                    let Ok(convert) = gst::ElementFactory::make("videoconvert").build() else {
                        error!("[{decode_name}] videoconvert is unavailable");
                        return;
                    };
                    let Some(convert_sink) = convert.static_pad("sink") else {
                        return;
                    };
                    if pipeline.add(&convert).is_err()
                        || convert.link(&sink).is_err()
                        || pad.link(&convert_sink).is_err()
                        || convert.sync_state_with_parent().is_err()
                    {
                        error!("[{decode_name}] software conversion fallback failed");
                    } else {
                        info!("[{decode_name}] decoder linked through videoconvert");
                    }
                }
            }
        }
    });

    let status = Arc::new(AtomicU8::new(STATUS_OK));
    let bus_name = pipeline_name.clone();
    let bus_status = status.clone();
    let bus_stats = stats.clone();
    let guard = pipeline
        .bus()?
        .add_watch_local(move |_, message| {
            use gst::MessageView;
            match message.view() {
                MessageView::Error(error) => {
                    error!(
                        "[{bus_name}] pipeline error: {} ({:?})",
                        error.error(),
                        error.debug()
                    );
                    bus_status.store(STATUS_ERROR, Ordering::Relaxed);
                }
                MessageView::Warning(warning) => {
                    warn!(
                        "[{bus_name}] pipeline warning: {} ({:?})",
                        warning.error(),
                        warning.debug()
                    );
                }
                MessageView::Qos(qos) => {
                    let (_, dropped) = qos.stats();
                    bus_stats
                        .frames_dropped
                        .store(dropped.value().max(0) as u64, Ordering::Relaxed);
                }
                _ => {}
            }
            gst::glib::ControlFlow::Continue
        })
        .ok()?;
    std::mem::forget(guard);

    let last_buffer = Arc::new(AtomicU64::new(epoch_millis()));
    if let Some(pad) = sink.static_pad("sink") {
        let timestamp = last_buffer.clone();
        let probe_status = status.clone();
        let probe_stats = stats.clone();
        pad.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
            timestamp.store(epoch_millis(), Ordering::Relaxed);
            probe_stats.frames_processed.fetch_add(1, Ordering::Relaxed);
            probe_status.store(STATUS_OK, Ordering::Relaxed);
            gst::PadProbeReturn::Ok
        });
    }

    info!("[{pipeline_name}] pipeline created for {rtsp_uri}");
    Some((pipeline, sink, last_buffer, status, stats))
}

pub fn play(pipeline: &Pipeline) {
    match pipeline.set_state(gst::State::Playing) {
        Ok(result) => info!("[{}] Playing = {result:?}", pipeline.name()),
        Err(error) => error!("[{}] Playing failed: {error:?}", pipeline.name()),
    }
}

pub fn stop(pipeline: &Pipeline) {
    let _ = pipeline.set_state(gst::State::Null);
}

pub fn restart(
    pipeline: &Pipeline,
    last_buffer: &AtomicU64,
    status: &AtomicU8,
    stats: &PipelineStats,
) {
    let name = pipeline.name().to_string();
    info!("[{name}] restarting stalled pipeline");
    status.store(STATUS_RESTARTING, Ordering::Relaxed);
    stats.restarts.fetch_add(1, Ordering::Relaxed);
    let _ = pipeline.set_state(gst::State::Null);
    last_buffer.store(epoch_millis(), Ordering::Relaxed);
    if let Err(error) = pipeline.set_state(gst::State::Playing) {
        error!("[{name}] restart failed: {error:?}");
        status.store(STATUS_ERROR, Ordering::Relaxed);
    }
}
