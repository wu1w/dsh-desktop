# Windows computer screenshot and scroll acceptance — 2026-11-03

Base: `f8a9ee12af71a062138f1a0f9056da3a0ec8bcbf`, including Mac fixes `51d3bd9` and Mac native acceptance. The Windows checkout was clean and updated by fast-forward. Windows 10.0.26100, Electron 45.0.0, Chromium 156.0.8078.48, embedded Node 24.22.0; one real 2560×1440 display at scale factor 1. No display or safety settings were changed. Only the two newly created native fixture windows were activated or mutated.

## Production capture backend and capability boundary

Production uses `desktopCapturer.getSources({types:['window'], thumbnailSize:{width:1100,height:800}})` and selects the exact observed HWND, with no screen fallback. The pinned runtime logs identify `WindowCapturerWinGdi` as primary and a `FallbackDesktopCapturerWrapper` with `WgcCapturerWin`. WGC sessions were initialized during enumeration, but Electron does not expose the backend ID or native frame crop of each returned thumbnail. These results establish the production GDI/WGC wrapper behavior; they do **not** claim WGC-only coverage or attribute every tested image to WGC.

The selected-window thumbnail contains the fixture's unique red/blue/yellow markers and no magenta occluder pixels. Native HWND and bounds match the fixture before and after move/resize/restore. Its exact native frame origin/crop is not exposed by Electron: the pinned GDI implementation additionally crops resize borders. The old DWM-based image scale produced about 3.2 physical pixels of marker error; substituting the outer window rectangle also produced errors. A matching aspect ratio is not evidence of the actual crop.

The product now keeps `capture-image-pixels` and native `physical-screen-pixels` bounds separate and returns `mappingAvailable:false`, reason `CAPTURE_FRAME_BOUNDS_UNAVAILABLE`. It no longer publishes an invented image-to-input transform. UIA element actions and explicitly native window-relative coordinates remain available. This is a concrete capture-library capability gap, not a permission failure; an independent WGC/native-frame API was not added to expand scope.

Source references: [Electron 45 desktopCapturer](https://github.com/electron/electron/blob/v45.0.0/shell/browser/api/electron_api_desktop_capturer.cc), [pinned GDI capturer](https://webrtc.googlesource.com/src/+/ce13eaa8e5750b09c46b088a35d74bdadbac25dc/modules/desktop_capture/win/window_capturer_win_gdi.cc), [pinned cropping rules](https://webrtc.googlesource.com/src/+/ce13eaa8e5750b09c46b088a35d74bdadbac25dc/modules/desktop_capture/win/window_capture_utils.cc).

## Bounded actual-device matrix

All **23 source-device behavior cases passed**. The separate unsupported/untested items below are not counted as passed capabilities. The fixture reads actual native wheel messages and paints its viewport; no input API or capture result is mocked.

| Area | Actual checks | Source result |
| --- | --- | --- |
| Selected capture | Normal; partially occluded by the other fixture; moved; resized; restored; modal owner. Exact HWND, native bounds and unique content colors checked; no screen or other-window image fallback | Pass |
| Async capture | A monotonically moving window changes bounds while capture is pending; old image/observation rejected with `COMPUTER_OBSERVATION_STALE` | Pass |
| Stale action | Move and resize after observation reject scroll before any wheel message | Pass |
| Vertical scroll | Down/up delivered −360/+360 WM_MOUSEWHEEL deltas, moving the controlled viewport +180/−180 pixels. New painted viewport color appears in the production screenshot | Pass |
| Horizontal scroll | Right/left delivered +360/−360 WM_MOUSEHWHEEL deltas, moving the controlled viewport +180/−180 pixels. Repainted screenshot checked | Pass |
| Boundaries | Top/left/bottom/right clamp at 0/1000 without movement beyond the boundary | Pass |
| Non-scrollable target | Wheel message arrives; viewport remains unchanged. Successful input dispatch is not a guarantee that arbitrary application content scrolls | Pass: correct OS no-op |
| Focus switch | Normal activation reacquires only the intended fixture; the other fixture receives no wheel messages | Pass |
| Modal switch | Disabled observed owner refuses with `COMPUTER_FOCUS_CHANGED`; both viewports unchanged | Pass |
| Invalid request | Invalid direction rejected with `COMPUTER_INVALID_INPUT` before input | Pass |
| Minimized | Observe returns `COMPUTER_NO_WINDOW`; stale scroll refuses; restore recovers selected capture | Pass |
| Closed/expired | Closed HWND and normally exited target process return `COMPUTER_APP_GONE`; no fallback screenshot | Pass |
| Exact screenshot-pixel input transform | Native capture crop is absent from Electron API; no unverified numeric transform is emitted | Unsupported |
| WGC-only / per-thumbnail backend attribution | No selection/attribution interface in the production wrapper; fallback initialization is not WGC-only success | Not established |
| Multiple monitors / mixed DPI | Only one real display at 100%; no system settings changed | Not tested |

The controlled canvas defines 60 pixels per wheel notch. The measured 180-pixel movement proves direction and three-notch delivery on that fixture; it is not a universal scrolling distance for all applications.

## Product changes and regression

After asynchronous Windows capture, the runtime observes the same bound process/HWND again and compares native geometry. A changed window is rejected instead of returning an old image/token; otherwise it returns the helper's current token. Closed targets propagate APP_GONE. Empty or different-HWND thumbnails are never attached. Inputs that completed before a capture failure are not replayed automatically; callers must observe before deciding what to do next.

Related unit/service regression: **24 pass / 0 fail / 0 skip**. Tests cover fresh capture authority, geometry changes after one completed input, target closure, empty/wrong-window frames and refusal to infer GDI geometry from aspect ratio. Full Windows suite: **1139 tests, 1093 pass / 25 fail / 21 skip / 0 cancelled**. The only failures are 21 native file-symlink EPERM setup failures and four repeated parent failures. The two additional skips versus the preceding Windows run come from newly pulled Mac-native cases. No symlink permission or Developer Mode change was made. Mac native acceptance remains the separate previously recorded 9/9; this Windows run does not repeat Mac hardware validation.

Reproduce from repository root:

```powershell
node outputs/dsh-codex-client/scripts/run-computer-scenarios.cjs
```

For installed production modules, set `DSH_ACCEPTANCE_APP_ROOT` to the fresh installation's `resources/app`; the harness uses the same pinned Electron 45 runtime and compiles only its own WinForms fixture using the existing .NET Framework compiler. Both the Electron driver and its parent have bounded watchdogs. The reliable parent launcher avoids PowerShell's asynchronous GUI return/closed log handles. Raw PNGs and diagnostics contain only the created fixture windows and remain ignored local evidence. Sanitized source-device evidence is in `validation/windows-computer-scenarios-20261103.json`.

## Final installed-artifact verification

Build and NSIS packaging both exited 0. The final unsigned, unpublished installer is **393,819,534 bytes**, SHA-256 `54df6b387a9e094756e3a40ff5b952e7d13ae23c57ab24e1bb0ab57d6a0977f8`. A fresh Chinese/spaces `scenarios-final` target installed with exit 0; 123 packaged-resource/runtime probes passed. **All 96 tracked runtime/source files present in the installed desktop/server/shared/native directories matched the final worktree byte-for-byte**, including the latest Mac-shared command code.

The same **23/23 actual-device cases passed against the installed production runtime and helper modules**, loaded by the same pinned Electron 45 acceptance driver. This does not claim the test script replaced the installed application's entry point. Evidence is `validation/windows-computer-installed-20261103.json`; all backend attribution and precise-pixel/multi-display limits remain unchanged.

The actual installed DSH executable also launched a separate new profile: Codex connected, official DeepSeek-V4.1-Flash selected, missing-key warning visible and Send disabled. Normal caption Close completed with exit 0. Uninstall exited 0, removed its test executables and preserved the isolated client JSON SHA-256. No paid provider call, release publication or system setting change was performed.
