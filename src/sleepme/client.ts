// filename: src/sleepme/client.ts
import axios, {AxiosInstance, AxiosResponse, AxiosError} from 'axios';
import {Logging} from 'homebridge';
import {RateLimiter, RateLimitDeferredError, RequestKind} from './rateLimiter.js';

type ClientResponse<T> = {
  data: T;
  status: number;
};

/**
 * Error thrown for every failed API call. Carries the HTTP status (used to detect
 * rate limiting) and the underlying axios error code (used to detect timeouts).
 */
export class SleepmeApiError extends Error {
  readonly statusCode?: number;
  readonly code?: string;

  constructor(message: string, statusCode?: number, code?: string) {
    super(message);
    this.name = 'SleepmeApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class Client {
  readonly token: string;
  private readonly axiosClient: AxiosInstance
  private readonly log?: Logging;
  private readonly limiter?: RateLimiter;

  /**
   * One Client per API token. The rate limit is per account, so every device
   * behind a token must share a single instance for the limiter to see the
   * account's true request rate.
   */
  constructor(token: string, baseURL = 'https://api.developer.sleep.me', log?: Logging, limiter?: RateLimiter) {
    this.token = token;
    this.axiosClient = axios.create({
      baseURL: baseURL,
      timeout: 30000, // 30 second timeout to prevent hanging requests
    });
    this.log = log;
    this.limiter = limiter;
  }

  /**
   * Claims quota before a request goes out.
   *
   * Reads are classified as polls and writes as commands, which is what gives
   * user actions priority: polls draw on the smaller budget and are deferred
   * when it runs dry, while commands may use the full quota and wait for the
   * next window rather than be dropped.
   */
  private async acquire(kind: RequestKind): Promise<void> {
    if (!this.limiter || this.limiter.tryAcquire(kind)) {
      return;
    }

    if (kind === 'poll') {
      throw new RateLimitDeferredError(this.limiter.msUntilNextWindow());
    }

    // A command only gets here once the account has spent all 10 requests, in
    // which case the server would answer 429 anyway. Waiting out the window is
    // strictly better than burning a retry on a request we know will fail.
    const waitMs = this.limiter.msUntilNextWindow();
    this.log?.warn(
      `API rate limit reached; holding this command for ${Math.ceil(waitMs / 1000)}s until the quota resets.`,
    );
    await new Promise(resolve => setTimeout(resolve, waitMs + 50));
    this.limiter.tryAcquire(kind);
  }

  headers(): object {
    return {
      'Authorization': `Bearer ${this.token}`,
    };
  }

  private logResponse<T>(response: AxiosResponse<T>, method: string, endpoint: string): void {
    if (this.log) {
      this.log.debug(`API ${method} ${endpoint} - Response Code: ${response.status}`);
    }
  }

  private handleError(error: unknown, method: string, endpoint: string): never {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const statusText = axiosError.response?.statusText || 'Unknown error';

      if (this.log) {
        if (status === 429) {
          this.log.error(`API ${method} ${endpoint} - RATE LIMITED (429): Too many requests. ` +
            'The plugin will automatically retry. Consider increasing polling intervals in settings.');
        } else if (status === 401 || status === 403) {
          this.log.error(`API ${method} ${endpoint} - AUTHENTICATION ERROR (${status}): Invalid API token. ` +
            'Please verify your SleepMe API token in plugin settings. ' +
            'Get a new token at: https://docs.developer.sleep.me/docs/');
        } else if (status === 404) {
          this.log.error(`API ${method} ${endpoint} - NOT FOUND (404): Device or endpoint not found. ` +
            'The device may have been removed from your SleepMe account.');
        } else if (status && status >= 500) {
          this.log.error(`API ${method} ${endpoint} - SERVER ERROR (${status}): SleepMe API is experiencing issues. ` +
            'The plugin will retry automatically.');
        } else if (axiosError.code === 'ECONNABORTED') {
          this.log.error(`API ${method} ${endpoint} - TIMEOUT: Request took longer than 30 seconds. Check your network connection.`);
        } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
          this.log.error(`API ${method} ${endpoint} - CONNECTION ERROR: Cannot reach SleepMe API. Check your internet connection.`);
        } else {
          this.log.error(`API ${method} ${endpoint} - Error ${status}: ${statusText}`);
        }

        // Log response details if available
        if (axiosError.response?.data) {
          try {
            const data = typeof axiosError.response.data === 'object'
              ? JSON.stringify(axiosError.response.data)
              : String(axiosError.response.data);
            this.log.debug(`API error details: ${data}`);
          } catch {
            // Ignore stringification errors
          }
        }
      }

      // Preserve the status code (for 429 detection) and the axios error code
      // (for timeout detection) so callers can classify the failure.
      throw new SleepmeApiError(`API error ${status}: ${statusText}`, status, axiosError.code);
    } else {
      // For non-axios errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.log) {
        this.log.error(`API ${method} ${endpoint} - Unexpected error: ${errorMessage}`);
      }
      throw new SleepmeApiError(`API error: ${errorMessage}`);
    }
  }

  async listDevices(): Promise<ClientResponse<Device[]>> {
    const endpoint = '/v1/devices';
    // Outside the try: a deferred poll must not be rewritten into a SleepmeApiError.
    await this.acquire('poll');
    try {
      const response = await this.axiosClient.get<Device[]>(endpoint, {headers: this.headers()});
      this.logResponse(response, 'GET', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'GET', endpoint);
    }
  }

  async getDeviceStatus(id: string): Promise<ClientResponse<DeviceStatus>> {
    const endpoint = `/v1/devices/${id}`;
    // Outside the try: a deferred poll must not be rewritten into a SleepmeApiError.
    await this.acquire('poll');
    try {
      const response = await this.axiosClient.get<DeviceStatus>(endpoint, {headers: this.headers()});
      this.logResponse(response, 'GET', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'GET', endpoint);
    }
  }

  async setTemperatureFahrenheit(id: string, temperature: number): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    await this.acquire('command');
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint,
        {set_temperature_f: temperature},
        {headers: this.headers()},
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }

  async setTemperatureCelsius(id: string, temperature: number): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    await this.acquire('command');
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint,
        {set_temperature_c: temperature},
        {headers: this.headers()},
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }

  async setDisplayTemperatureUnit(id: string, unit: 'c' | 'f'): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    await this.acquire('command');
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint,
        {display_temperature_unit: unit},
        {headers: this.headers()},
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }

  async setThermalControlStatus(id: string, targetState: 'standby' | 'active'): Promise<ClientResponse<Control>> {
    const endpoint = `/v1/devices/${id}`;
    await this.acquire('command');
    try {
      const response = await this.axiosClient.patch<Control>(
        endpoint,
        {thermal_control_status: targetState},
        {headers: this.headers()},
      );
      this.logResponse(response, 'PATCH', endpoint);
      return response;
    } catch (error) {
      this.handleError(error, 'PATCH', endpoint);
    }
  }
}

export type Device = {
  id: string;
  name: string;
  attachments: string[];
};

export type Control = {
  brightness_level: number;
  display_temperature_unit: 'c' | 'f';
  set_temperature_c: number;
  set_temperature_f: number;
  thermal_control_status: 'standby' | 'active';
  time_zone: string;
};

export type DeviceStatus = {
  about: {
    firmware_version: string;
    ip_address: string;
    lan_address: string;
    mac_address: string;
    model: string;
    serial_number: string;
  };
  control: Control;
  status: {
    is_connected: boolean;
    is_water_low: boolean;
    water_level: number;
    water_temperature_f: number;
    water_temperature_c: number;
  };
};