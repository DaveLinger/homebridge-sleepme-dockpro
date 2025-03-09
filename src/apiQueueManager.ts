import { Client, Control, DeviceStatus } from './sleepme/client.js';
import { Logging } from 'homebridge';

export type QueuedRequest = {
  deviceId: string;
  operation: 'setTemperatureFahrenheit' | 'setTemperatureCelsius' | 'setThermalControlStatus' | 'getDeviceStatus';
  params: any[];
  timestamp: number;
  retryCount: number;
};

export type QueuedRequestResult = {
  success: boolean;
  data?: Control | DeviceStatus;
  error?: any;
  statusCode?: number;
};

export type DeviceState = {
  lastSuccessfulState?: Control;
  pendingState?: Control;
  lastError?: {
    message: string;
    code: number;
    timestamp: number;
  };
};

export interface RequestCallback {
  (result: QueuedRequestResult): void;
}

export class ApiQueueManager {
  private queue: Map<string, QueuedRequest> = new Map();
  private deviceStates: Map<string, DeviceState> = new Map();
  private processing = false;
  private lastProcessTime = 0;
  private scheduledTimeout: NodeJS.Timeout | null = null;
  private callbacks: Map<string, RequestCallback[]> = new Map();

  constructor(
    private readonly client: Client,
    private readonly log: Logging,
    private readonly minRequestInterval: number = 1000, // 1 second default
    private readonly maxRetries: number = 3,
    private readonly retryBackoff: number = 5000, // 5 seconds
    private readonly consistencyCheckInterval: number = 30000, // 30 seconds
  ) {}

  /**
   * Adds a request to the queue, overriding any pending request for the same device and operation
   */
  public enqueue(
    deviceId: string, 
    operation: QueuedRequest['operation'], 
    params: any[],
    callback?: RequestCallback
  ): void {
    const key = this.getQueueKey(deviceId, operation);
    const request: QueuedRequest = {
      deviceId,
      operation,
      params,
      timestamp: Date.now(),
      retryCount: 0,
    };

    // Store the callback if provided
    if (callback) {
      if (!this.callbacks.has(key)) {
        this.callbacks.set(key, []);
      }
      this.callbacks.get(key)!.push(callback);
    }

    // If it's a state-changing operation, update the pending state
    if (operation !== 'getDeviceStatus') {
      this.updatePendingState(deviceId, operation, params);
    }

    this.queue.set(key, request);
    this.log.debug(`Enqueued request: ${deviceId} - ${operation}`);
    
    this.scheduleProcessing();
  }

  /**
   * Process the queue if not already processing
   */
  private scheduleProcessing(): void {
    if (this.scheduledTimeout) {
      return;
    }

    const timeSinceLastProcess = Date.now() - this.lastProcessTime;
    const delay = Math.max(0, this.minRequestInterval - timeSinceLastProcess);

    this.log.debug(`Scheduling queue processing in ${delay}ms`);
    this.scheduledTimeout = setTimeout(() => {
      this.scheduledTimeout = null;
      this.processQueue();
    }, delay);
  }

  /**
   * Process the next request in the queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.size === 0) {
      return;
    }

    this.processing = true;
    this.lastProcessTime = Date.now();
    
    try {
      // Sort requests by timestamp and get the oldest
      const [key, request] = [...this.queue.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      
      this.log.debug(`Processing request: ${request.deviceId} - ${request.operation}`);
      this.queue.delete(key);

      try {
        let result;
        switch (request.operation) {
          case 'setTemperatureFahrenheit':
            result = await this.client.setTemperatureFahrenheit(request.deviceId, request.params[0]);
            break;
          case 'setTemperatureCelsius':
            result = await this.client.setTemperatureCelsius(request.deviceId, request.params[0]);
            break;
          case 'setThermalControlStatus':
            result = await this.client.setThermalControlStatus(request.deviceId, request.params[0]);
            break;
          case 'getDeviceStatus':
            result = await this.client.getDeviceStatus(request.deviceId);
            break;
        }

        // Handle successful response
        this.handleSuccess(request, result.data, result.status);
      } catch (error) {
        // Handle error response
        this.handleError(request, error);
      }
    } finally {
      this.processing = false;
      
      // If there are still items in the queue, schedule the next processing
      if (this.queue.size > 0) {
        this.scheduleProcessing();
      } else {
        // Schedule consistency check if no requests are pending
        this.scheduleConsistencyCheck();
      }
    }
  }

  /**
   * Handle a successful API response
   */
  private handleSuccess(request: QueuedRequest, data: any, statusCode: number): void {
    this.log.debug(`Request successful: ${request.deviceId} - ${request.operation}`);
    
    // Update device state for the device
    if (request.operation !== 'getDeviceStatus') {
      // For control operations, update the last successful state
      if (!this.deviceStates.has(request.deviceId)) {
        this.deviceStates.set(request.deviceId, {});
      }
      
      const deviceState = this.deviceStates.get(request.deviceId)!;
      deviceState.lastSuccessfulState = data;
      deviceState.pendingState = undefined;
      deviceState.lastError = undefined;
    } else if (data && 'control' in data) {
      // For getDeviceStatus, check if the current status matches our last known state
      const deviceState = this.deviceStates.get(request.deviceId);
      if (deviceState && deviceState.pendingState) {
        // Compare API state with pending state
        const apiControl = (data as DeviceStatus).control;
        const pendingControl = deviceState.pendingState;
        
        // Check for discrepancies and re-enqueue the request if needed
        if (this.statesAreDifferent(apiControl, pendingControl)) {
          this.log.warn(`Device state mismatch detected for ${request.deviceId}, re-applying settings`);
          this.reapplyPendingState(request.deviceId, pendingControl);
        } else {
          // States match, clear pending state
          deviceState.lastSuccessfulState = apiControl;
          deviceState.pendingState = undefined;
        }
      }
    }

    // Notify callbacks
    const callbackKey = this.getQueueKey(request.deviceId, request.operation);
    const callbacks = this.callbacks.get(callbackKey) || [];
    callbacks.forEach(callback => {
      callback({
        success: true,
        data: data,
        statusCode: statusCode
      });
    });
    this.callbacks.delete(callbackKey);
  }

  /**
   * Handle an API error response
   */
  private handleError(request: QueuedRequest, error: any): void {
    const statusCode = error.response?.status || 0;
    const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
    
    this.log.error(`API error for ${request.deviceId} - ${request.operation}: ${statusCode} ${errorMessage}`);
    
    // Update device state with error
    if (!this.deviceStates.has(request.deviceId)) {
      this.deviceStates.set(request.deviceId, {});
    }
    
    const deviceState = this.deviceStates.get(request.deviceId)!;
    deviceState.lastError = {
      message: errorMessage,
      code: statusCode,
      timestamp: Date.now()
    };

    // Retry logic
    if (request.retryCount < this.maxRetries) {
      const backoffTime = this.retryBackoff * (request.retryCount + 1);
      this.log.info(`Retrying request after ${backoffTime}ms (attempt ${request.retryCount + 1}/${this.maxRetries})`);
      
      // Re-enqueue with incremented retry count
      const retryRequest = {
        ...request,
        retryCount: request.retryCount + 1,
        timestamp: Date.now() + backoffTime // Delay the timestamp to ensure backoff
      };
      
      this.queue.set(this.getQueueKey(request.deviceId, request.operation), retryRequest);
    } else {
      this.log.error(`Max retries (${this.maxRetries}) exceeded for ${request.deviceId} - ${request.operation}`);
      
      // Notify callbacks about the failure
      const callbackKey = this.getQueueKey(request.deviceId, request.operation);
      const callbacks = this.callbacks.get(callbackKey) || [];
      callbacks.forEach(callback => {
        callback({
          success: false,
          error: error,
          statusCode: statusCode
        });
      });
      this.callbacks.delete(callbackKey);
    }
  }

  /**
   * Update the pending state for a device based on an operation
   */
  private updatePendingState(deviceId: string, operation: string, params: any[]): void {
    if (!this.deviceStates.has(deviceId)) {
      this.deviceStates.set(deviceId, {});
    }
    
    const deviceState = this.deviceStates.get(deviceId)!;
    const pendingState = deviceState.pendingState || deviceState.lastSuccessfulState || {};
    
    // Create a new pending state based on the operation
    switch (operation) {
      case 'setTemperatureFahrenheit':
        deviceState.pendingState = {
          ...pendingState,
          set_temperature_f: params[0]
        };
        break;
      case 'setTemperatureCelsius':
        deviceState.pendingState = {
          ...pendingState,
          set_temperature_c: params[0]
        };
        break;
      case 'setThermalControlStatus':
        deviceState.pendingState = {
          ...pendingState,
          thermal_control_status: params[0]
        };
        break;
    }
  }

  /**
   * Re-apply pending state by enqueueing the necessary requests
   */
  private reapplyPendingState(deviceId: string, pendingState: Partial<Control>): void {
    if (pendingState.thermal_control_status) {
      this.enqueue(
        deviceId, 
        'setThermalControlStatus',
        [pendingState.thermal_control_status]
      );
    }
    
    if (pendingState.set_temperature_f) {
      this.enqueue(
        deviceId,
        'setTemperatureFahrenheit',
        [pendingState.set_temperature_f]
      );
    }
  }

  /**
   * Check if two control states differ in meaningful ways
   */
  private statesAreDifferent(apiState: Control, pendingState: Partial<Control>): boolean {
    // Only compare properties that were explicitly set in pendingState
    for (const key of Object.keys(pendingState) as Array<keyof Control>) {
      if (pendingState[key] !== undefined && apiState[key] !== pendingState[key]) {
        return true;
      }
    }
    return false;
  }

  /**
   * Schedule a consistency check to ensure device state matches API state
   */
  private scheduleConsistencyCheck(): void {
    // Clear any existing timeout
    if (this.scheduledTimeout) {
      clearTimeout(this.scheduledTimeout);
      this.scheduledTimeout = null;
    }
    
    // Only check if we have device states to verify
    if (this.deviceStates.size === 0) {
      return;
    }
    
    this.scheduledTimeout = setTimeout(() => {
      this.scheduledTimeout = null;
      this.performConsistencyCheck();
    }, this.consistencyCheckInterval);
  }

  /**
   * Perform consistency check for all devices with pending states
   */
  private performConsistencyCheck(): void {
    this.log.debug('Performing consistency check');
    
    for (const [deviceId, state] of this.deviceStates.entries()) {
      if (state.pendingState) {
        // There's a pending state, enqueue a status check
        this.enqueue(deviceId, 'getDeviceStatus', []);
      }
    }
  }

  /**
   * Get a unique key for the queue based on device ID and operation
   */
  private getQueueKey(deviceId: string, operation: string): string {
    return `${deviceId}:${operation}`;
  }

  /**
   * Get the current state for a device
   */
  public getDeviceState(deviceId: string): DeviceState {
    return this.deviceStates.get(deviceId) || {};
  }

  /**
   * Manually trigger a get status request for all known devices
   */
  public refreshAllDevices(): void {
    for (const deviceId of this.deviceStates.keys()) {
      this.enqueue(deviceId, 'getDeviceStatus', []);
    }
  }
}