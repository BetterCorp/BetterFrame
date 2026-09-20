//! WS-Addressing endpoint references are an address plus opaque parameters.
//! Keep both, including inherited XML namespaces, for pull/renew/unsubscribe.
use std::time::{Duration, Instant};

const WSA: &str = "http://www.w3.org/2005/08/addressing";

pub struct Subscription {
    pub address: String,
    pub reference_headers: String,
    renew_at: Instant,
}

impl Subscription {
    pub fn parse(xml: &str, fallback: Duration) -> Result<Self, String> {
        let doc = roxmltree::Document::parse(xml).map_err(|e| format!("subscription XML: {e}"))?;
        let reference = doc
            .descendants()
            .find(|n| n.has_tag_name("SubscriptionReference"))
            .ok_or("missing SubscriptionReference")?;
        let address = reference
            .children()
            .find(|n| n.has_tag_name("Address"))
            .and_then(|n| n.text())
            .unwrap_or("")
            .trim()
            .to_owned();
        let url = url::Url::parse(&address).map_err(|_| "invalid subscription address")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("invalid subscription protocol".into());
        }
        let mut reference_headers = String::new();
        for container in reference.children().filter(|n| {
            n.has_tag_name("ReferenceParameters") || n.has_tag_name("ReferenceProperties")
        }) {
            for child in container.children().filter(|n| n.is_element()) {
                write_element(child, &mut reference_headers, true);
            }
        }
        let mut sub = Self {
            address,
            reference_headers,
            renew_at: Instant::now(),
        };
        sub.update_deadline(xml, fallback);
        Ok(sub)
    }

    pub fn renew_due(&self) -> bool {
        Instant::now() >= self.renew_at
    }

    pub fn update_deadline(&mut self, xml: &str, fallback: Duration) {
        self.renew_at = Instant::now() + renew_delay(lease_duration(xml).unwrap_or(fallback));
    }

    pub fn observe_deadline(&mut self, xml: &str) {
        if let Some(lease) = lease_duration(xml) {
            self.renew_at = pull_renew_deadline(self.renew_at, Instant::now(), lease);
        }
    }
}

fn pull_renew_deadline(existing: Instant, observed_at: Instant, remaining: Duration) -> Instant {
    // Pull responses report remaining lifetime, not a newly granted lease.
    // Only creation or a successful Renew may move the deadline later.
    existing.min(observed_at + renew_delay(remaining))
}

fn renew_delay(lease: Duration) -> Duration {
    // Use the camera's relative lifetime, not the kiosk's wall clock. Leave
    // enough headroom for a blocking pull and transport/authentication retries.
    lease.mul_f64(0.5).min(Duration::from_secs(240))
}

fn lease_duration(xml: &str) -> Option<Duration> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let time = |name| {
        let text = doc.descendants().find(|n| n.has_tag_name(name))?.text()?;
        time::OffsetDateTime::parse(text.trim(), &time::format_description::well_known::Rfc3339)
            .ok()
    };
    let seconds = (time("TerminationTime")? - time("CurrentTime")?).whole_seconds();
    Some(Duration::from_secs(seconds.max(0) as u64))
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn qualified(
    node: roxmltree::Node<'_, '_>,
    namespace: Option<&str>,
    name: &str,
    attribute: bool,
) -> String {
    let prefix = namespace.and_then(|uri| {
        node.namespaces()
            .find(|ns| ns.uri() == uri && (!attribute || ns.name().is_some()))
            .and_then(|ns| ns.name())
    });
    prefix
        .map(|p| format!("{p}:{name}"))
        .unwrap_or_else(|| name.to_owned())
}

fn write_element(node: roxmltree::Node<'_, '_>, out: &mut String, reference: bool) {
    let tag = qualified(
        node,
        node.tag_name().namespace(),
        node.tag_name().name(),
        false,
    );
    out.push_str(&format!("<{tag}"));
    for ns in node.namespaces() {
        if ns.name() == Some("xml") {
            continue;
        }
        let name = ns
            .name()
            .map(|p| format!("xmlns:{p}"))
            .unwrap_or_else(|| "xmlns".into());
        out.push_str(&format!(" {name}=\"{}\"", escape(ns.uri())));
    }
    for attr in node.attributes() {
        if reference && attr.namespace() == Some(WSA) && attr.name() == "IsReferenceParameter" {
            continue;
        }
        let name = if attr.namespace() == Some("http://www.w3.org/XML/1998/namespace") {
            format!("xml:{}", attr.name())
        } else {
            qualified(node, attr.namespace(), attr.name(), true)
        };
        out.push_str(&format!(" {name}=\"{}\"", escape(attr.value())));
    }
    if reference {
        let mut prefix = "bfReference".to_owned();
        while node.lookup_namespace_uri(Some(&prefix)).is_some() {
            prefix.push('_');
        }
        out.push_str(&format!(
            " xmlns:{prefix}=\"{WSA}\" {prefix}:IsReferenceParameter=\"true\""
        ));
    }
    out.push('>');
    for child in node.children() {
        if child.is_element() {
            write_element(child, out, false);
        } else if child.is_text() {
            out.push_str(&escape(child.text().unwrap_or("")));
        }
    }
    out.push_str(&format!("</{tag}>"));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_endpoint_identity_namespaces_and_escaped_address() {
        let xml = r#"<s:Envelope xmlns:s="urn:soap" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:v="urn:vendor">
        <s:Header><a:ReplyTo><a:Address>http://wrong/anonymous</a:Address></a:ReplyTo></s:Header>
        <s:Body><Response><SubscriptionReference><a:Address>http://camera/sub?a=1&amp;b=2</a:Address>
        <a:ReferenceParameters><v:SubscriptionId v:kind="v:opaque">id&lt;&amp;42</v:SubscriptionId>
        <v:Token xmlns:v="urn:inner"><v:Part>abc</v:Part></v:Token></a:ReferenceParameters>
        </SubscriptionReference></Response></s:Body></s:Envelope>"#;
        let sub = Subscription::parse(xml, Duration::from_secs(60)).unwrap();
        assert_eq!(sub.address, "http://camera/sub?a=1&b=2");
        let wrapped = format!("<Header>{}</Header>", sub.reference_headers);
        let doc = roxmltree::Document::parse(&wrapped).unwrap();
        let id = doc
            .descendants()
            .find(|n| n.has_tag_name(("urn:vendor", "SubscriptionId")))
            .unwrap();
        assert_eq!(id.text(), Some("id<&42"));
        assert_eq!(id.attribute((WSA, "IsReferenceParameter")), Some("true"));
        assert_eq!(id.attribute(("urn:vendor", "kind")), Some("v:opaque"));
        assert!(
            doc.descendants()
                .any(|n| n.has_tag_name(("urn:inner", "Part")))
        );
    }
    #[test]
    fn missing_reference_does_not_pick_an_unrelated_address() {
        assert!(
            Subscription::parse(
                "<ReplyTo><Address>http://wrong</Address></ReplyTo>",
                Duration::from_secs(60)
            )
            .is_err()
        );
    }
    #[test]
    fn repeated_long_polls_cannot_postpone_renewal_until_expiry() {
        let created = Instant::now();
        let original = created + renew_delay(Duration::from_secs(60));
        let mut deadline = original;
        // Five seconds in PullMessages, then five seconds between pulls.
        for elapsed in [5, 15, 25] {
            deadline = pull_renew_deadline(
                deadline,
                created + Duration::from_secs(elapsed),
                Duration::from_secs(60 - elapsed),
            );
            assert_eq!(deadline, original);
        }
        assert!(created + Duration::from_secs(30) >= deadline);
        assert!(deadline < created + Duration::from_secs(60));
        // An unexpectedly shorter remaining lease can still bring renewal forward.
        assert_eq!(
            pull_renew_deadline(
                original,
                created + Duration::from_secs(10),
                Duration::from_secs(10)
            ),
            created + Duration::from_secs(15)
        );
        // Cameras that extend their lease on pull do not postpone explicit renewal.
        assert_eq!(
            pull_renew_deadline(
                original,
                created + Duration::from_secs(20),
                Duration::from_secs(60)
            ),
            original
        );
    }

    #[test]
    fn renewal_uses_camera_lifetime_even_with_different_wall_clock() {
        let xml = "<Response><CurrentTime>2001-01-01T00:00:00Z</CurrentTime><TerminationTime>2001-01-01T00:00:20Z</TerminationTime></Response>";
        assert_eq!(lease_duration(xml), Some(Duration::from_secs(20)));
        assert_eq!(
            renew_delay(lease_duration(xml).unwrap()),
            Duration::from_secs(10)
        );
        let expired = xml.replace("00:00:20", "00:00:00");
        assert_eq!(
            renew_delay(lease_duration(&expired).unwrap()),
            Duration::ZERO
        );
    }
}
