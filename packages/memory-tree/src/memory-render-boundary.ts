const MEMORY_ATOM_MARKER = 'littlesheep-memory-atom';

export function memoryAtomStart(atomId: string): string {
  return `<!-- ${MEMORY_ATOM_MARKER}:start ${atomId} -->`;
}

export function memoryAtomEnd(atomId: string): string {
  return `<!-- ${MEMORY_ATOM_MARKER}:end ${atomId} -->`;
}
