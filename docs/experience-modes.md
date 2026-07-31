# NakliOS experience modes

NakliOS has two user-facing experience modes. They are launch policies, not
separate products or generations of the desktop.

## Immersive

Immersive is the default and recommended mode. Compatible apps open in NakliOS
windows, inherit the current theme, expose App Info, and may use the cooperative
SDK. An app marked `maxMode:'basic'` or `iframeable:false` still opens in a new
tab; NakliOS does not weaken its sandbox or pretend an incompatible app embeds.

## Basic

Basic is a retained compatibility and user-choice mode. Host-native classics
and the storage-dependent system apps Files, Notes, and Lorewell remain in NakliOS
windows. Other standalone web apps open at their canonical URL in a new tab.

Basic remains useful when:

- a browser, extension, authentication flow, or app does not behave reliably
  inside an iframe;
- a user wants the origin and browser chrome of the standalone app to remain
  visible;
- an app has not adopted the NakliOS cooperative contract yet.

It is intentionally not the default and should not acquire its own feature
fork. New host functionality must work in Immersive; Basic only preserves the
safe hosted core and the canonical new-tab fallback.

## Compatibility contract

- New profiles default to Immersive.
- An existing explicit Basic preference is preserved.
- Files, Notes, Lorewell, and host-native classics stay hosted in both modes.
- App catalog compatibility flags override Immersive without changing the
  user's saved preference.
- Switching modes does not migrate, copy, delete, or rebind app data.
- Cross-origin apps stay sandboxed whenever embedded. A mode switch never
  grants same-origin privilege.

The historical internal values `A`, `B`, and `C` are migration inputs only:
`A`/`B` map to Basic and `C` maps to Immersive. “Mode C” is not current product
terminology.

## Decision

**Keep Basic.** Revisit only if browser support and the entire maintained app
catalog make the compatibility route genuinely unused. Until then, removing it
would turn known iframe incompatibilities into regressions for no meaningful
reduction in the maintained host surface.
