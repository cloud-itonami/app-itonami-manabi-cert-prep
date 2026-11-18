# 16 KB alignment and system-bar insets — evidence of 2026-11-18

Tracking: [AWAI-3432](https://linear.app/kotobalabs/issue/AWAI-3432), part of
the template-wide [AWAI-3393](https://linear.app/kotobalabs/issue/AWAI-3393)
(reference: Hiring, AWAI-3392).

## Before (main 260c056)

- `tauri/src-tauri/build.rs` had no page-size link argument.
- `MainActivity.kt` called only `enableEdgeToEdge()`, so the page could draw
  under the status and navigation bars.

## Change

- `build.rs`: for an Android target, link with `-Wl,-z,max-page-size=16384`.
- `MainActivity.kt`: system bars, display cutout and IME become the content
  view's padding. The page has a single light theme (`public/calm.css`
  `--paper-cream #f7f3ed`, no dark variant), so both bars use
  `SystemBarStyle.light`, the decor is always #f7f3ed and the bar icons are
  requested dark in either system theme, also after a live theme switch.

## After

Build: `CARGO_BUILD_JOBS=4 nice -n 10 npm run build:android` (aarch64 debug),
after deleting the APK outputs, under the shared AWAI-3393 build lock.

| Check | Result |
| -- | -- |
| APK | 155,733,793 bytes, sha256 `7dcb051aa8c7f45393e9db0787aeead5ec26ac2fac4f9251315e8d26f1f11a0b`, signer SHA-256 `2507930b…9b29` (development identity). 140.7 MB of it is the unstripped debug `.so` (debug symbols), not a stale zip hole. INTERNET permission was already in the manifest on main. |
| ELF | `llvm-readelf -lW lib/arm64-v8a/libmanabi_cert_prep_lib.so`: 4 LOAD segments, all `Align 0x4000` |
| Zip | `zipalign -c -P 16 -v 4`: `lib/arm64-v8a/libmanabi_cert_prep_lib.so (OK)`, verification successful |
| VM | Disposable Android 15 `default` arm64 (`AE3A.240806.019`, page size 4096), new AVD with `-wipe-data`, deleted afterwards. In light mode, after a live switch to dark, and on a cold start in dark (scrolled to the end), the content starts below the status bar and ends above the navigation bar (`light.jpg`, `dark-live.jpg`, `dark-cold-scrolled.jpg`). |

## Not established

- **16 KB warning on a device:** the VM uses 4 KB pages, so it does not show
  the 16 KB warning in either case. The fix is shown by the ELF alignment.
- **Navigation icon colour in dark mode:** the window requests dark icons
  (`dumpsys window`: `apr=LIGHT_STATUS_BARS LIGHT_NAVIGATION_BARS`), but on
  this system image SystemUI draws the 3-button navigation icons pale grey
  while the system is in dark mode. They stay visible on the cream bar, and
  the app cannot change this further. The status-bar icons are dark in both
  modes.
- The final source differs from the built APK only in one code comment.
