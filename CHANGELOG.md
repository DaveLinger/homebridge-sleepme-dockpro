# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
