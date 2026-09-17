export class RunCheckpointStoreDisposedError extends Error {
  constructor() {
    super('Run checkpoint store has been disposed.');
    this.name = 'RunCheckpointStoreDisposedError';
  }
}

export class RunCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCheckpointValidationError';
  }
}
