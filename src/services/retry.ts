// filename: src/services/retry.ts
import {Logging} from 'homebridge';
import {Client, Control, Device} from '../sleepme/client.js';
import {INITIAL_RETRY_DELAY_MS, MAX_RETRIES, MAX_STATE_MISMATCH_RETRIES, STATE_MISMATCH_RETRY_DELAY_MS} from '../types/index.js';

/**
 * Provides retry logic for API operations
 */
export class RetryService {
  constructor(private readonly log: Logging, private readonly deviceName: string) {}

  /**
   * Executes an operation with exponential backoff retry logic
   */
  async retryApiCall<T>(
    operation: () => Promise<T>, 
    operationName: string, 
    maxRetries: number = MAX_RETRIES, 
    currentAttempt: number = 1
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Retry on any error, not just rate limits
      if (currentAttempt <= maxRetries) {
        // Calculate exponential backoff delay: 15s, 30s, 60s
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentAttempt - 1);
        
        // Format error message based on status code if available
        let errorDetails = error instanceof Error ? error.message : String(error);
        const statusCode = (error as any).statusCode;
        if (statusCode) {
          errorDetails = `HTTP ${statusCode}: ${errorDetails}`;
        }
        
        this.log.warn(
          `${this.deviceName}: Failed to ${operationName} (${errorDetails}). Retrying in ${delay/1000}s (attempt ${currentAttempt}/${maxRetries})`
        );
        
        // Wait and then retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.retryApiCall(
          operation, 
          operationName,
          maxRetries,
          currentAttempt + 1
        );
      }
      
      // If we've exhausted retries, rethrow
      throw error;
    }
  }

  /**
   * Handles state mismatches between expected and actual states
   */
  async handleStateMismatch(
    client: Client, 
    device: Device, 
    expectedState: 'standby' | 'active', 
    actualState: 'standby' | 'active',
    currentControl: Control | null,
    retryCount: number = 0
  ): Promise<Control> {
    if (retryCount >= MAX_STATE_MISMATCH_RETRIES) {
      this.log.warn(`${this.deviceName}: State mismatch persisted after ${MAX_STATE_MISMATCH_RETRIES} retries. API returned ${actualState}, expected ${expectedState}. Accepting API state.`);
      
      // Return the control with the actual state
      return currentControl 
        ? { ...currentControl, thermal_control_status: actualState } 
        : { thermal_control_status: actualState } as Control;
    }

    this.log.warn(`${this.deviceName}: State mismatch detected! API returned ${actualState}, expected ${expectedState}. Retrying (${retryCount + 1}/${MAX_STATE_MISMATCH_RETRIES})`);

    // Wait and retry setting the state
    await new Promise(resolve => setTimeout(resolve, STATE_MISMATCH_RETRY_DELAY_MS));
    
    try {
      const r = await client.setThermalControlStatus(device.id, expectedState);
      const responseState = r.data.thermal_control_status;
      
      if (responseState === expectedState) {
        this.log.info(`${this.deviceName}: Successfully set state to ${expectedState} after retry`);
        return r.data;
      } else {
        // Still mismatched, retry again
        return this.handleStateMismatch(client, device, expectedState, responseState, currentControl, retryCount + 1);
      }
    } catch (error) {
      this.log.error(`${this.deviceName}: Error during state mismatch handling: ${error instanceof Error ? error.message : String(error)}`);
      if (retryCount + 1 < MAX_STATE_MISMATCH_RETRIES) {
        return this.handleStateMismatch(client, device, expectedState, actualState, currentControl, retryCount + 1);
      } else {
        // If we've exhausted retries, return with the actual state
        return currentControl 
          ? { ...currentControl, thermal_control_status: actualState } 
          : { thermal_control_status: actualState } as Control;
      }
    }
  }
}