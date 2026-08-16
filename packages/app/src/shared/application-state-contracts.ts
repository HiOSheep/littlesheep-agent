// Main/renderer handshake used to synchronously flush durable UI state before exit.

export const APPLICATION_STATE_FLUSH_CHANNEL = 'littlesheep:application-state-flush'

export const APPLICATION_STATE_FLUSH_ACK_CHANNEL = 'littlesheep:application-state-flush-ack'

export const APPLICATION_PERSISTENCE_FLUSH_EVENT = 'littlesheep:persistence-flush'
