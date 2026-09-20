# Linux kiosk sleep and ONVIF events

Each display has an independent inactivity timeout. A sleep timeout of 60 seconds
means 60 seconds after the last user input, explicit layout/operator command, or
wake command, checked once per second. Zero disables automatic sleep. Returning
to the default layout, refreshing the bundle, recovering a stalled stream, and
expiring temporary camera overrides do not restart this timer or wake a display.
If idle reversion and sleep are both due, sleep wins.

While sleeping, the application replaces the entire layout with an opaque black
screen. A small BetterFrame logo at 7% opacity moves slowly and reflects at the
screen edges. Camera cards, names, web content, and other layout overlays are
hidden even when CEC/DPMS cannot turn the physical monitor off. The existing
stream cooling policy still releases inactive streams; background synchronization,
ONVIF event reception, and recording are independent of this presentation.

A wake command, explicit layout/operator command, or local key/click/touch/scroll
restores the layout. The first local wake event is consumed. Bundle refreshes
preserve the selected assigned layout, sleep state, and original inactivity
clock. No system suspend or OS reboot is used by the sleep screen.

## Camera subscription compatibility

ONVIF subscriptions contain an endpoint address and sometimes opaque
`ReferenceParameters` (such as a vendor subscription ID). BF preserves these
parameters, their namespace declarations, and the decoded URL on subsequent
PullMessages, Renew, and Unsubscribe requests. WS-Addressing headers accompany
every authentication method, including HTTP Digest. The SOAP 1.2 content type
also carries the action.

Renewal uses the difference between the camera's `CurrentTime` and
`TerminationTime`, so clock skew and shorter granted leases do not cause BF to
wait for the wrong deadline. Pull responses can bring renewal forward but cannot
postpone it; only creation or successful renewal establishes a later deadline.
A SOAP operation fault is not retried as a succession
of authentication methods. Invalid/expired pull subscriptions are recreated and
old subscriptions are unsubscribed when possible.

These changes target the Linux client. Android already has its own standby
implementation; Windows host power support remains experimental. Camera firmware
can have additional vendor-specific requirements, so a passing mock-camera test
still needs verification against affected physical cameras.
