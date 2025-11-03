

## [1.1.1](https://github.com/DaveLinger/homebridge-sleepme-dockpro/compare/v1.0.4...v1.1.1) (2025-11-03)

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
