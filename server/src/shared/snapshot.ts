/**
 * Camera snapshot capture.
 *
 * Spawns ffmpeg (preferred) or gst-launch-1.0 to pull one frame from an RTSP
 * URL and return it as a JPEG buffer. Bounded by a hard timeout so a stuck
 * connection can't pile up subprocesses.
 */
import { spawn } from "node:child_process";
import { unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 8000;

export interface SnapshotOptions {
  timeoutMs?: number;
}

/**
 * Capture a single frame from an RTSP URL. Returns a JPEG buffer, or null on
 * any failure (timeout, missing binary, non-zero exit, empty file).
 *
 * Tries ffmpeg first (fast, widely installed). Falls back to gst-launch-1.0.
 */
export async function captureSnapshot(
  rtspUrl: string,
  opts: SnapshotOptions = {},
): Promise<Buffer | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!rtspUrl || !rtspUrl.startsWith("rtsp://")) return null;

  const result = await tryFfmpeg(rtspUrl, timeoutMs);
  if (result) return result;
  return tryGstLaunch(rtspUrl, timeoutMs);
}

async function tryFfmpeg(rtspUrl: string, timeoutMs: number): Promise<Buffer | null> {
  const out = join(tmpdir(), `bf-snap-${randomBytes(8).toString("hex")}.jpg`);
  // -y overwrite, -rtsp_transport tcp (most reliable), -frames:v 1 single frame,
  // -an no audio. Use mjpeg via filename extension.
  const args = [
    "-y",
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-frames:v", "1",
    "-q:v", "5",
    "-an",
    out,
  ];
  const ok = await runWithTimeout("ffmpeg", args, timeoutMs);
  if (!ok) {
    void unlink(out).catch(() => undefined);
    return null;
  }
  try {
    const buf = await readFile(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    void unlink(out).catch(() => undefined);
  }
}

async function tryGstLaunch(rtspUrl: string, timeoutMs: number): Promise<Buffer | null> {
  const out = join(tmpdir(), `bf-snap-${randomBytes(8).toString("hex")}.jpg`);
  // rtspsrc → decodebin → videoconvert → jpegenc → single-frame filesink
  const args = [
    "-q",
    "rtspsrc", `location=${rtspUrl}`, "protocols=tcp", "latency=200", "!",
    "decodebin", "!",
    "videoconvert", "!",
    "jpegenc", "!",
    "filesink", `location=${out}`,
    "num-buffers=1",
  ];
  const ok = await runWithTimeout("gst-launch-1.0", args, timeoutMs);
  if (!ok) {
    void unlink(out).catch(() => undefined);
    return null;
  }
  try {
    const buf = await readFile(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    void unlink(out).catch(() => undefined);
  }
}

function runWithTimeout(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(false);
    }, timeoutMs);

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(false);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}
