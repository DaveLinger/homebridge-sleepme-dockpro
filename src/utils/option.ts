// filename: src/utils/option.ts

/**
 * A simple Option monad for handling nullable values
 */
export class Option<T> {
  readonly value: T | null;

  constructor(value: T | null) {
    this.value = value;
  }

  /**
   * Applies a function to the value if it exists
   */
  map<TNext>(mapF: (value: T) => TNext): Option<TNext> {
    if (this.value) {
      return new Option(mapF(this.value));
    }
    return new Option<TNext>(null);
  }

  /**
   * Returns the value or a fallback if the value is null
   */
  orElse<T>(elseValue: T): T {
    if (!this.value) {
      return elseValue;
    }
    return this.value as unknown as T;
  }
}