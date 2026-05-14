/**
 * Generic MQTT telemetry bridge. Off by default — enable by setting
 * `BF_MQTT_URL=mqtt://broker:1883` (or mqtts:// for TLS). Optional
 * `BF_MQTT_USERNAME`, `BF_MQTT_PASSWORD`, `BF_MQTT_TOPIC_PREFIX` (default
 * "betterframe").
 *
 * Outbound topics:
 *   <prefix>/<kiosk_id>/event/<topic>   server-side events (camera.changed,
 *                                       layout.changed, kiosk.changed)
 *   <prefix>/<kiosk_id>/telemetry       heartbeat snapshot (cpu, fan, etc)
 *   <prefix>/server/status              {alive:1} on connect, LWT 0 on drop
 *
 * Inbound RPC (subscribed when enabled, handler injected by caller):
 *   <prefix>/<kiosk_id>/rpc/req/<method>   publish to RPC into a kiosk
 *
 * Consumers: any platform that speaks MQTT — ThingsBoard (Gateway adapter
 * config), Home Assistant (MQTT discovery), InfluxDB Telegraf, OpenObserve,
 * custom dashboards. Server picks no preferred consumer.
 */
import mqtt, { type MqttClient } from "mqtt";

export interface MqttBridgeLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface MqttBridge {
  publishEvent(kioskId: number | "server", topic: string, payload: Record<string, unknown>): void;
  publishTelemetry(kioskId: number, payload: Record<string, unknown>): void;
  /** Subscribe to inbound RPC. Callback gets parsed JSON or {} on parse error. */
  onRpc(handler: (kioskId: number, method: string, body: Record<string, unknown>) => void): void;
  end(): void;
}

const NOOP_BRIDGE: MqttBridge = {
  publishEvent: () => {},
  publishTelemetry: () => {},
  onRpc: () => {},
  end: () => {},
};

export function initMqttBridge(log: MqttBridgeLog): MqttBridge {
  const url = (process.env["BF_MQTT_URL"] ?? "").trim();
  if (!url) return NOOP_BRIDGE;

  const prefix = (process.env["BF_MQTT_TOPIC_PREFIX"] ?? "betterframe").replace(/\/+$/, "");
  const username = process.env["BF_MQTT_USERNAME"];
  const password = process.env["BF_MQTT_PASSWORD"];

  let client: MqttClient | undefined;
  let rpcHandlers: Array<(k: number, m: string, b: Record<string, unknown>) => void> = [];

  try {
    client = mqtt.connect(url, {
      username,
      password,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      will: {
        topic: `${prefix}/server/status`,
        payload: Buffer.from(JSON.stringify({ alive: 0 })),
        qos: 0,
        retain: true,
      },
    });
  } catch (err) {
    log.warn(`mqtt: connect failed: ${(err as Error).message}`);
    return NOOP_BRIDGE;
  }

  client.on("connect", () => {
    log.info(`mqtt: connected to ${url} (prefix=${prefix})`);
    client?.publish(
      `${prefix}/server/status`,
      JSON.stringify({ alive: 1, ts: new Date().toISOString() }),
      { retain: true },
    );
    // Subscribe to RPC requests for every kiosk.
    client?.subscribe(`${prefix}/+/rpc/req/+`, (err) => {
      if (err) log.warn(`mqtt: subscribe rpc failed: ${err.message}`);
    });
  });

  client.on("error", (err) => log.warn(`mqtt: ${err.message}`));
  client.on("offline", () => log.warn("mqtt: offline"));

  client.on("message", (topic, payload) => {
    // Expected: <prefix>/<kiosk_id>/rpc/req/<method>
    const parts = topic.split("/");
    if (parts.length !== 5 || parts[0] !== prefix || parts[2] !== "rpc" || parts[3] !== "req") return;
    const kioskId = Number(parts[1]);
    const method = parts[4];
    if (!Number.isFinite(kioskId) || !method) return;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(payload.toString("utf8")) as Record<string, unknown>; }
    catch { /* ignore body parse errors — handler can use empty */ }
    for (const h of rpcHandlers) {
      try { h(kioskId, method, body); }
      catch (err) { log.warn(`mqtt rpc handler threw: ${(err as Error).message}`); }
    }
  });

  return {
    publishEvent(kioskId, topic, payload) {
      if (!client?.connected) return;
      const t = `${prefix}/${String(kioskId)}/event/${topic}`;
      client.publish(t, JSON.stringify({ ...payload, _ts: new Date().toISOString() }));
    },
    publishTelemetry(kioskId, payload) {
      if (!client?.connected) return;
      const t = `${prefix}/${String(kioskId)}/telemetry`;
      client.publish(t, JSON.stringify({ ...payload, _ts: new Date().toISOString() }), { retain: true });
    },
    onRpc(handler) { rpcHandlers.push(handler); },
    end() {
      try { client?.end(); } catch { /* noop */ }
    },
  };
}
