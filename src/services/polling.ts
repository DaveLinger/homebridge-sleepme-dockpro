// filename: src/services/polling.ts
import {Logging} from 'homebridge';
import {Client, DeviceStatus} from '../sleepme/client.js';
import {DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS, DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES, SleepmeContext} from '../types/index.js';
import {RetryService} from './retry.js';

export interface PollingConfig {
  activePollingIntervalSeconds?: number;
  standbyPollingIntervalMinutes?: number;
}

/**
 * Manages the polling service for device status updates
 */
export class PollingService {
  private timeout: NodeJS.Timeout | undefined;
  private readonly activePollingIntervalMs: number;
  private readonly standbyPollingIntervalMs: number;
  private currentDeviceStatus: DeviceStatus | null = null;
  
  constructor(
    private readonly log: Logging,
    private readonly deviceName: string,
    private readonly retryService: RetryService,
    config?: PollingConfig
  ) {
    // Set up active polling interval from config or use default
    const configuredActiveSeconds = config?.activePollingIntervalSeconds;
    if (configuredActiveSeconds !== undefined) {
      if (configuredActiveSeconds < 5) {
        this.log.warn(`Active polling interval must be at least 5 seconds. Using 5 seconds.`);
        this.activePollingIntervalMs = 5 * 1000;
      } else {
        this.activePollingIntervalMs = configuredActiveSeconds * 1000;
        this.log.debug(`Using configured active polling interval of ${configuredActiveSeconds} seconds`);
      }
    } else {
      this.activePollingIntervalMs = DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS * 1000;
      this.log.debug(`Using default active polling interval of ${DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS} seconds`);
    }

    // Set up standby polling interval from config or use default
    const configuredStandbyMinutes = config?.standbyPollingIntervalMinutes;
    if (configuredStandbyMinutes !== undefined) {
      if (configuredStandbyMinutes < 1) {
        this.log.warn(`Standby polling interval must be at least 1 minute. Using 1 minute.`);
        this.standbyPollingIntervalMs = 60 * 1000;
      } else {
        this.standbyPollingIntervalMs = configuredStandbyMinutes * 60 * 1000;
        this.log.debug(`Using configured standby polling interval of ${configuredStandbyMinutes} minutes`);
      }
    } else {
      this.standbyPollingIntervalMs = DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES * 60 * 1000;
      this.log.debug(`Using default standby polling interval of ${DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES} minutes`);
    }
    
    this.log.debug(`Active polling interval: ${this.activePollingIntervalMs/1000} seconds`);
    this.log.debug(`Standby polling interval: ${this.standbyPollingIntervalMs/60000} minutes`);
  }

  /**
   * Determines polling interval based on device state
   */
  private getPollingIntervalBasedOnState(isActive: boolean): number {
    const interval = isActive ? this.activePollingIntervalMs : this.standbyPollingIntervalMs;
    this.log.debug(`${this.deviceName}: Device is ${isActive ? 'ACTIVE' : 'STANDBY'}, using ${isActive ? interval/1000 + 's' : interval/60000 + 'm'} polling interval`);
    return interval;
  }

  /**
   * Starts polling for device status updates
   */
  startPolling(
    client: Client, 
    deviceId: string, 
    initialIsActive: boolean = false,
    onStatusUpdated: (status: DeviceStatus) => void
  ): void {
    this.log.debug(`${this.deviceName}: Starting polling with initial state: ${initialIsActive ? 'ACTIVE' : 'STANDBY'}`);
    
    // Start the polling cycle
    this.scheduleNextPoll(client, deviceId, initialIsActive, onStatusUpdated);
  }

  /**
   * Changes the polling interval based on device state
   */
  updatePollingInterval(isActive: boolean): void {
    this.log.debug(`${this.deviceName}: Updating polling interval for state: ${isActive ? 'ACTIVE' : 'STANDBY'}`);
    
    // Clear existing timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    
    // We don't have context here to restart polling, the caller must call startPolling again
  }

  /**
   * Stops the polling service
   */
  stopPolling(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
      this.log.debug(`${this.deviceName}: Polling stopped`);
    }
  }

  /**
   * Schedules the next poll operation
   */
  private scheduleNextPoll(
    client: Client, 
    deviceId: string, 
    isActive: boolean, 
    onStatusUpdated: (status: DeviceStatus) => void
  ): void {
    // Clear any existing timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    
    // Get the appropriate polling interval based on current state
    const pollingInterval = this.getPollingIntervalBasedOnState(isActive);
    
    this.log.debug(`${this.deviceName}: Scheduling next poll in ${isActive ? pollingInterval/1000 + 's' : pollingInterval/60000 + 'm'}`);
    
    // Schedule the next poll
    this.timeout = setTimeout(async () => {
      this.log.debug(`${this.deviceName}: Polling at: ${new Date()}`);
      
      try {
        // Use the retry service for polling
        const status = await this.retryService.retryApiCall(
          () => client.getDeviceStatus(deviceId),
          "poll device status"
        );
        
        this.currentDeviceStatus = status.data;
        
        // Check if device state has changed
        const currentActive = status.data.control.thermal_control_status === 'active';
        if (currentActive !== isActive) {
          this.log.info(`${this.deviceName}: Device state changed from ${isActive ? 'ACTIVE' : 'STANDBY'} to ${currentActive ? 'ACTIVE' : 'STANDBY'}`);
          
          // Call the status updated callback
          onStatusUpdated(status.data);
          
          // Reschedule with new interval
          this.scheduleNextPoll(client, deviceId, currentActive, onStatusUpdated);
          return;
        }
        
        // Call the status updated callback
        onStatusUpdated(status.data);
        
        // Schedule next poll with the same interval
        this.scheduleNextPoll(client, deviceId, isActive, onStatusUpdated);
      } catch (error) {
        this.log.error(`${this.deviceName}: Error polling device: ${error instanceof Error ? error.message : String(error)}`);
        
        // Even on error, schedule the next poll
        this.scheduleNextPoll(client, deviceId, isActive, onStatusUpdated);
      }
    }, pollingInterval);
  }

  /**
   * Gets the current device status (last known)
   */
  getCurrentStatus(): DeviceStatus | null {
    return this.currentDeviceStatus;
  }
}