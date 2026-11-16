# Web permissions

Open **Entities**, edit a web or HTML entity, and use **Web permissions**. Managed dashboards and AbleSign entities expose the same controls. Save to deliver the entity policy to every block that uses it. Display mouse/keyboard settings remain separate.

On Linux, **Sound** and **Automatic audio and video** are enabled by default, including for existing entities. This permits a page to play media without a click when its HTML or scripts request playback. It does not start media that the page never requests. Uncheck Sound to mute that entity, or automatic playback to require a page user gesture.

Microphone, camera, location, notifications, clipboard, media device enumeration, protected media, cross-site storage and pointer lock default to denied. Requests are automatically answered using the entity settings while the top-level page is on its configured website origin. Other origins and unsupported requests are denied. Screen capture is unavailable. WebKit's secure-context, browser frame/delegation rules, hardware and operating-system requirements still apply; a checkbox cannot bypass those requirements. Native notification popups remain suppressed.

A hidden block is always muted, including when its layout is inactive or the display sleeps. A visible block with Sound enabled becomes audible again. Put a block in the active layout when you need its audio. Camera streams currently render video only. There is no background-audio exception.

New windows and tabs navigate their originating block. Native dialogs, file/color pickers, print UI, context menus and webpage fullscreen are suppressed. HTML inline media is allowed. Use another BetterFrame layout for a fullscreen presentation.

Cookies and website storage remain available but can be cleared by a restart or eviction. Configure entity auto-login steps and let the app fetch/cache content again as needed; storage is not a persistent-login guarantee.

Failed pages and terminated web processes are retried while visible, at most three times per five minutes. Hidden failures wait until their block is visible. Display client logs include permission decisions, origin-match results, load error categories and recovery attempts without page contents or credential-bearing URLs. An interrupted action reports failure; recovery does not promise to replay a partly completed action group.

The server UI and the updated Linux client are both required. Old clients ignore the new bundle settings and retain their old WebKit policy. These controls describe Linux WebKit behaviour; Android and Windows do not yet implement this permission policy.
