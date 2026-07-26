# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `package-lock.json` still declared version 1.1.7 after the 1.2.0 and 1.3.0 bumps, because those were applied to `package.json` by hand rather than through `release-it`. This would have failed the switch to `npm ci` below.
- CI installs with `npm ci` instead of `npm install`, so the build is tested against the exact dependency tree described by the lockfile rather than whatever resolves on the day.
- The "List, audit, fix outdated dependencies and build again" step ran `npm audit fix` and then rebuilt against the mutated tree, which could fail a build for reasons unrelated to the commit and threw the fix away regardless. Its `npm list --outdated` calls were also silently no-ops — `--outdated` is not a flag `npm list` accepts, so it exited 0 without reporting anything. Dependency reporting now lives in a separate `audit` job marked `continue-on-error`, using the real `npm outdated`.

### Changed
- The build workflow accepts `workflow_dispatch`, so a run can be started by hand from the Actions tab without inventing a commit.
- Added a `concurrency` group so a burst of pushes to the same branch cancels superseded runs instead of queueing them.
- Enabled npm caching in `actions/setup-node`.

## [1.3.0] - 2026-07-26

### Added
- Temperature writes are debounced by 500ms. Dragging the slider in the Home app emits a write per step, and every intermediate value is distinct, so deduplication alone did not help: one gesture could previously spend most of a minute's request quota. Only the value the user settles on is now sent. The delay is not perceptible because the optimistic update has already moved the UI before the request is queued. Power on/off is deliberately not debounced — those are single deliberate taps where latency matters most.
- Client-side rate limiting. The SleepMe API allows 10 requests per minute per account, and the plugin now tracks its own usage against a fixed wall-clock minute window to match the documented "discrete minute" semantics. Reads and writes are budgeted separately: 4 requests are held in reserve so a tap in the Home app is never blocked by background polling. A poll with no budget is skipped and rescheduled rather than retried, since retrying a full window only makes it worse; a command with no budget waits for the window to reset instead of spending a retry on a request that would 429.
- One shared `Client` per API token, created by the platform. Previously three separate call sites constructed clients, including a fresh one inside the poller closure on every reschedule, so nothing could observe the account's aggregate request rate. Because the quota is per account, the limiter lives with the client and is shared by every device behind a token.

### Changed
- The active polling interval now scales with the number of devices sharing an API token, keeping total polling at or below the account's request budget regardless of device count. The safe floor is 10 seconds per device, so two devices set to 10s are polled every 20s, three every 30s. A configured value already above the floor is used unchanged — two devices left at the 45s default stay at 45s rather than being stretched to 90s. Standby polling is not scaled; even four devices at the 15 minute default cost well under one request per minute.
- Redundant commands are no longer sent. A temperature write is skipped when it matches what the device is already set to, compared on the value actually sent so that Celsius settings collapsing onto the same LOW/HIGH sentinel are not resent. A thermal state write is skipped only when the state is confirmed and no command is in flight, so a genuine turn-on is never dropped.
- The optimistic temperature update now stores the value sent to the API rather than the raw Fahrenheit conversion, so local state matches what the device reports back.
- Polling interval settings are documented as automatically optimized. They were already in the collapsed Advanced section; the help text now explains that the plugin manages the rate itself and that these are overrides rather than tuning knobs.
- Device discovery waits out the rate limit window if the polling budget is exhausted mid-discovery, so an account with more devices than the per-minute budget does not silently lose the model check on the later ones.

### Fixed
- Hitting the internal rate limit is now invisible in HomeKit. A deferred poll leaves every characteristic untouched, so the accessory keeps showing its last known values instead of going stale or erroring, and `onGet` continues to answer instantly from cache because it never makes an API call. A delayed command does not block the Home app either: the `onSet` handlers resolve as soon as the optimistic update is applied and let the request run detached. The only trace is a single warning in the Homebridge log.
- A deferred poll during the initial status fetch or during the post-failure status refresh no longer logs a misleading error. Both are expected outcomes of the rate limiter and are logged at debug.

## [1.2.0] - 2026-07-26

### Added
- Water level history at info level. The startup reading is logged once per device, changes to `water_level` are logged with their previous value, and `is_water_low` transitions are logged (`warn` when low water is detected, `info` when it clears). Previously the water level appeared only inside a `debug` line, so a low-water event left no trace unless debug logging was enabled. A steady tank logs nothing after startup.
- Device filtering, so newer SleepMe products are not registered as Dock Pro thermostats. Only devices reporting a supported model (`DP999NA` by default) are added — the `ST501NA` Sleep Tracker, for example, reports no `water_level`, `is_water_low`, or `water_temperature_*` and would otherwise appear as a thermostat and water sensor that never update. `supported_models` overrides the model list if SleepMe ships a Dock Pro with a new code, and a `device_ids` allowlist restricts the plugin to specific devices. If the model cannot be determined because the status call failed, the device is added rather than dropped.

### Fixed
- The `timeout` API metric never incremented. `Client.handleError()` discarded the underlying axios error code when re-throwing, so the `ECONNABORTED` check in `retryApiCall()` could never match. Failed calls now throw a `SleepmeApiError` carrying both the HTTP status and the axios error code.
- `npm run test` failed with "No tests found, exiting with code 1", which failed the Build and Lint workflow before it reached the lint or build steps. Jest now runs with `--passWithNoTests`.
- `npm run lint` only checked `src/*/*.ts`. The unquoted `src/**/*.ts` glob was expanded by the shell, which does not support `**` recursion, so `platform.ts` and `platformAccessory.ts` were never linted. The pattern is now quoted and passed to ESLint, and all six source files are covered.
- All outstanding lint errors and warnings, so `npm run lint --max-warnings=0` passes: `no-explicit-any` (×4), an unused `Service` binding, `prefer-const`, plus indentation, quoting, trailing-comma, trailing-whitespace and line-length cleanups.

### Changed
- Water level service (battery/leak/motion) is now reused across restarts instead of being removed and re-added every launch. Only services left behind by a *previous* `water_level_type` setting are removed, so the accessory's service list no longer churns on each Homebridge restart.
- Minimum active polling interval raised from 5 to 10 seconds, matching the floor already advertised in the plugin config UI. Both floors are now defined as constants alongside the defaults.
- Repeated `error instanceof Error ? error.message : String(error)` expressions replaced with a single `errorMessage()` helper.
- Device discovery now reads each device's status once to identify its model and hands that status to the accessory, which no longer fetches it again. Startup API call volume is unchanged (one device list plus one status per device).
- CI now also builds on Node 22, which `engines.node` already declared as supported.

### Removed
- Dead code orphaned by the 1.1.4 "no response" fix: `handleStateMismatch()`, `updateControlFromResponse()`, the unused `previousHeatingCoolingState` field, and the state-mismatch retry constants.
- Stale cleanup code that removed `High Mode` and `Temperature Boost` services, neither of which the plugin creates.
- Legacy `.eslintrc`, superseded by the flat `eslint.config.mjs`.
- `node dist/index.js` from the `build` script — the entry point only registers the platform, so executing it as a build step did nothing.

## [1.1.7] - 2026-04-28

### Fixed
- Tile tap in the iOS Home app on accessories restored from cache. `TargetHeatingCoolingState` now explicitly declares `validValues` of `[0, 1, 2, 3]` to override the `[0, 3]` set cached by HomeKit from earlier versions.

## [1.1.6] - 2026-04-27

### Fixed
- Removed the `validValues` restriction on `TargetHeatingCoolingState` that prevented the tile quick-toggle from working in the iOS Home app. (Superseded by 1.1.7, which sets the full value list explicitly.)

## [1.1.5] - 2026-04-27

### Fixed
- Thermostat tile toggle returning "no response" with no log output. `TemperatureDisplayUnits` is writable on `Service.Thermostat`, and its missing `onSet` handler caused HomeKit to fail the *entire* bundled write — including `TargetHeatingCoolingState`.

### Added
- `setDisplayTemperatureUnit()` on the SleepMe client, so display unit changes made in the Home app are pushed to the device.

## [1.1.4] - 2026-04-27

### Fixed
- "No response" in HomeKit when turning a device ON. The SleepMe `PATCH` response reflects the device's instantaneous state rather than the commanded state, and turning on is slow — the device briefly stays in `standby`, so the response validation saw a false state mismatch, retried for 15 seconds, then accepted `standby` and reverted the toggle. A successful API call is now trusted as confirmation the command was accepted, with the polling cycle confirming the device's actual state.

## [1.1.3] - 2026-04-27

### Added
- Homebridge 2.0 compatibility. `engines` and devDependencies now declare support for both v1 and v2; no code changes were required as the plugin already uses modern APIs.

### Fixed
- `onSet` handlers causing "no response" on device turn-on: API commands are no longer awaited by the characteristic handler, so HomeKit gets an immediate acknowledgement while retries proceed in the background.

### Removed
- The `log.success` shim, which is dead code under Homebridge 2.0.

## [1.1.2] - 2025-11-4

### Changed
- Hourly API metrics logging moved to debug level to reduce log verbosity (consecutive failure warnings remain visible)

[1.3.0]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.3.0
[1.2.0]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.2.0
[1.1.7]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.7
[1.1.6]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.6
[1.1.5]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.5
[1.1.4]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.4
[1.1.3]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.3
[1.1.2]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.2

## [1.1.1] - 2025-11-3

### Added
- Request timeout (30 seconds) to prevent hanging API calls
- Comprehensive error messages with actionable instructions and helpful links
- Validation for empty API key arrays and empty string tokens
- Firmware version display in HomeKit accessory information
- API metrics tracking (success rate, failures, rate limits, timeouts)
- Hourly metrics logging for monitoring plugin health
- Automatic metrics summary when 3+ consecutive failures occur
- Enhanced config UI with detailed descriptions, help text, and examples
- Collapsible "Advanced Settings" section in config UI for better organization

### Fixed
- Type safety issue in `Option<T>.orElse()` method
- `StatusLowBattery` characteristic warning (was passing boolean instead of numeric value)
- `CurrentTemperature` characteristic NaN warning with improved validation and default fallback
- `TargetTemperature` characteristic exceeding minimum value - now properly clamps all API temperature values to HomeKit's valid range (12-46.7°C)

### Changed
- Enhanced error logging with specific handling for authentication, rate limiting, timeouts, and server errors
- Improved retry logic with exponential backoff capped at 60 seconds to prevent excessive delays
- Firmware version now automatically updates when device firmware changes

[1.1.1]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/v1.1.1

## [1.0.4] - 2024-XX-XX

### Added
- Initial release with HomeKit support for SleepMe Dock Pro devices
- Temperature control with AUTO/OFF modes
- Configurable water level alerts (battery, leak, or motion sensor)
- Adaptive polling intervals (active vs standby mode)
- Retry logic with exponential backoff for API failures
- Support for special temperature modes (LOW/HIGH)

### Features
- Control multiple SleepMe devices from Apple Home
- HomeKit automations support
- Low water level warnings
- Optimistic UI updates for responsive control

[1.0.4]: https://github.com/DaveLinger/homebridge-sleepme-dockpro/releases/tag/v1.0.4
